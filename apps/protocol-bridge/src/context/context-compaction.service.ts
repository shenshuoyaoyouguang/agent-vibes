import { Injectable } from "@nestjs/common"
import { randomUUID } from "crypto"
import { fingerprintAttachments } from "./attachment-fingerprint"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import {
  ContextTelemetryService,
  type ContextTelemetryEvent,
} from "./context-telemetry.service"
import {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  createAttachmentRecord,
  createHookResultRecord,
  createMicrocompactBoundaryRecord,
  createSnipBoundaryRecord,
  deriveCompactionHistoryFromTranscript,
  getRecordsAfterCompactBoundary,
  isCompactSummaryRecord,
  isMessageRecord,
  projectSnippedView,
} from "./context-transcript-events"
import {
  ContextNativeCacheEditApplyResult,
  ContextNativeCacheEditService,
} from "./context-native-cache-edit.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { SessionMemoryCompactionService } from "./session-memory-compaction.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import {
  ToolResultCompactionResult,
  ToolResultCompactionService,
} from "./tool-result-compaction.service"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextSessionMemoryEntry,
  ContextTranscriptRecord,
  ProjectedContextMessage,
  ContextProjectionAttachment,
  UnifiedMessage,
} from "./types"

export class ContextProjectionBudgetExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maxTokens: number
  ) {
    super(
      `Projected context is ${estimatedTokens} tokens, exceeding request budget ${maxTokens}.`
    )
    this.name = "ContextProjectionBudgetExceededError"
  }
}

export interface ContextCompactionPlan {
  commit: ContextCompactionCommit
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  attachmentFingerprint: string
  recordCount: number
  retainedRecords: ContextTranscriptRecord[]
  attachmentRecords?: ContextTranscriptRecord[]
  hookResultRecords?: ContextTranscriptRecord[]
  sessionMemoryEntries?: ContextSessionMemoryEntry[]
}

export interface ContextCompactionCandidate {
  commitId: string
  strategy: ContextCompactionCommit["strategy"]
  createdAt: number
  nextEpoch: number
  archivedRecords: ContextTranscriptRecord[]
  retainedRecords: ContextTranscriptRecord[]
  summaryBudget: number
  attachmentFingerprint: string
  liveAttachments: ContextProjectionAttachment[]
  sourceTokenCount: number
  retainedTokenCount: number
}

export interface ContextSnipCompactionResult {
  changed: boolean
  removedRecords: number
  retainedRecords: number
  summaryTokenCount: number
  estimatedTokens: number
}

export interface ContextCompactionResult {
  messages: UnifiedMessage[]
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  wasCompacted: boolean
  appliedCompaction?: ContextCompactionPlan
  snipCompaction?: ContextSnipCompactionResult
  microcompactCompaction?: ToolResultCompactionResult
  nativeCacheEditCompaction?: ContextNativeCacheEditApplyResult
  toolResultCompaction?: ToolResultCompactionResult
}

@Injectable()
export class ContextCompactionService {
  private readonly MIN_REQUEST_BUDGET = 256
  private readonly MIN_SUMMARY_TOKENS = 64
  private readonly MIN_ATTACHMENT_TOKENS = 128
  private readonly SUMMARY_TOKEN_BUDGET = 2400
  private readonly ATTACHMENT_TOKEN_BUDGET = 2200
  private readonly INVESTIGATION_MEMORY_ATTACHMENT_BONUS = 320
  private readonly SNIP_MIN_REMOVED_RECORDS = 2

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly projection: ContextProjectionService,
    private readonly toolResultCompaction: ToolResultCompactionService,
    private readonly attachments: ContextAttachmentBuilderService,
    private readonly usageLedger: ContextUsageLedgerService,
    private readonly sessionMemory: SessionMemoryCompactionService,
    private readonly nativeCacheEdits: ContextNativeCacheEditService,
    private readonly telemetry: ContextTelemetryService
  ) {}

  ensureWithinBudget(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: ContextCompactionCommit["strategy"]
      nativeCacheEdits?: boolean
      dryRun?: boolean
    }
  ): ContextCompactionResult {
    const hardMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    const targetMaxTokens = this.resolvePressureBudget(hardMaxTokens, options)
    const workingState = options.dryRun ? this.cloneState(state) : state
    const attachmentTokenBudget = this.resolveAttachmentBudget(
      hardMaxTokens,
      (snapshot.investigationSummaries?.length ?? 0) > 0
    )

    let projected = this.buildProjectedMessages(
      workingState,
      snapshot,
      attachmentTokenBudget
    )
    let estimated = this.countProjected(projected)
    let appliedCompaction: ContextCompactionPlan | undefined
    let snipCompaction: ContextSnipCompactionResult | undefined
    let microcompactCompaction: ToolResultCompactionResult | undefined
    let nativeCacheEditCompaction: ContextNativeCacheEditApplyResult | undefined

    if (this.shouldCompact(estimated, hardMaxTokens, targetMaxTokens)) {
      this.recordPressureTelemetry(estimated, hardMaxTokens, targetMaxTokens)
    }

    if (
      !options.dryRun &&
      !options.nativeCacheEdits &&
      this.toolResultCompaction.evaluateIdleTrigger(
        this.messageRecordsFromActiveSlice(workingState.records)
      )
    ) {
      const idleResult = this.applyIdleMicrocompact(
        workingState,
        snapshot,
        attachmentTokenBudget
      )
      if (idleResult?.changed) {
        microcompactCompaction = idleResult.result
        projected = idleResult.projectedMessages
        estimated = idleResult.estimatedTokens
      } else if (idleResult) {
        this.telemetry.recordEvent({
          event: "compaction.microcompact_skipped_cached",
        })
      }
    }

    if (estimated > hardMaxTokens) {
      const snip = options.dryRun
        ? undefined
        : this.applyDurableSnip(
            workingState,
            snapshot,
            attachmentTokenBudget,
            hardMaxTokens,
            options.integrityMode
          )
      if (snip?.changed) {
        snipCompaction = snip.result
        projected = snip.projectedMessages
        estimated = snip.estimatedTokens
      }
    }

    if (options.nativeCacheEdits) {
      const cacheEditResult = this.nativeCacheEdits.apply(
        workingState,
        projected
      )
      nativeCacheEditCompaction = cacheEditResult
      if (cacheEditResult.changed) {
        projected = cacheEditResult.projectedMessages
        estimated = this.countProjected(projected)
        this.telemetry.recordEvent({
          event: "compaction.native_cache_edits_inserted",
          delta: cacheEditResult.newlyDeletedToolResults || 1,
          metadata: {
            registeredToolResults: cacheEditResult.registeredToolResults,
            newlyRegisteredToolResults:
              cacheEditResult.newlyRegisteredToolResults,
            newlyDeletedToolResults: cacheEditResult.newlyDeletedToolResults,
            pinnedEditBlocks: cacheEditResult.pinnedEditBlocks,
          },
        })
      }
    }

    const messages = this.sanitizeProjectedMessages(projected, {
      integrityMode: options.integrityMode,
      pendingToolUseIds: options.pendingToolUseIds,
    })
    let finalMessages = messages
    let messageTokens = this.tokenCounter.countMessages(finalMessages)
    if (messageTokens > hardMaxTokens && !options.dryRun) {
      const hardFit = this.buildHardFitProjection(
        finalMessages,
        hardMaxTokens,
        options.integrityMode,
        options.pendingToolUseIds
      )
      if (hardFit) {
        finalMessages = hardFit.messages
        projected = hardFit.projectedMessages
        messageTokens = hardFit.estimatedTokens
        snipCompaction = hardFit.snipCompaction
      }
    }
    if (messageTokens > hardMaxTokens) {
      this.telemetry.recordEvent({
        event: "compaction.projection_budget_exceeded",
        metadata: {
          estimatedTokens: messageTokens,
          maxTokens: hardMaxTokens,
        },
      })
      throw new ContextProjectionBudgetExceededError(
        messageTokens,
        hardMaxTokens
      )
    }

    this.recordResultTelemetry(snipCompaction, microcompactCompaction)

    return {
      messages: finalMessages,
      projectedMessages: projected,
      estimatedTokens: messageTokens,
      wasCompacted: !!appliedCompaction,
      appliedCompaction,
      snipCompaction,
      microcompactCompaction,
      nativeCacheEditCompaction,
      toolResultCompaction: microcompactCompaction,
    }
  }

  private buildHardFitProjection(
    messages: UnifiedMessage[],
    hardMaxTokens: number,
    integrityMode?: "strict-adjacent" | "global",
    pendingToolUseIds?: Iterable<string>
  ):
    | {
        messages: UnifiedMessage[]
        projectedMessages: ProjectedContextMessage[]
        estimatedTokens: number
        snipCompaction: ContextSnipCompactionResult
      }
    | undefined {
    if (messages.length <= 1) return undefined

    const targetTokens = Math.max(
      this.MIN_REQUEST_BUDGET,
      Math.floor(hardMaxTokens * 0.92)
    )
    const mode = integrityMode ?? "global"
    const roundAlignedIndex =
      this.toolIntegrity.findRoundAlignedTruncationPoint(
        messages,
        targetTokens,
        {
          mode,
        }
      )
    const candidateIndexes = [
      roundAlignedIndex,
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        messages,
        targetTokens,
        { mode }
      ),
    ]

    for (const truncationIndex of candidateIndexes) {
      if (truncationIndex <= 0 || truncationIndex >= messages.length) {
        continue
      }

      const candidate = this.toolIntegrity.sanitizeMessages(
        messages.slice(truncationIndex),
        {
          mode,
          pendingToolUseIds,
        }
      ).messages
      if (candidate.length === 0) continue

      const estimatedTokens = this.tokenCounter.countMessages(candidate)
      if (estimatedTokens > hardMaxTokens) continue

      return {
        messages: candidate,
        projectedMessages: candidate.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
          source: "snip",
        })),
        estimatedTokens,
        snipCompaction: {
          changed: true,
          removedRecords: truncationIndex,
          retainedRecords: candidate.length,
          summaryTokenCount: 0,
          estimatedTokens,
        },
      }
    }

    return undefined
  }

  prepareCompactionCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    const hardMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    const effectiveMaxTokens = this.resolvePressureBudget(
      hardMaxTokens,
      options
    )
    const attachmentTokenBudget = this.resolveAttachmentBudget(
      hardMaxTokens,
      (snapshot.investigationSummaries?.length ?? 0) > 0
    )
    const projected = this.buildProjectedMessages(
      state,
      snapshot,
      attachmentTokenBudget
    )
    if (this.countProjected(projected) <= effectiveMaxTokens) {
      return null
    }
    return this.prepareCandidateForBudget(
      state,
      snapshot,
      effectiveMaxTokens,
      attachmentTokenBudget,
      options.strategy || "auto",
      options.integrityMode
    )
  }

  applyGeneratedSummaryCompaction(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    candidate: ContextCompactionCandidate,
    input: {
      summary: string
      hookUserMessage?: string
      emitTelemetry?: boolean
    }
  ): ContextCompactionPlan {
    const attachmentTokenBudget = this.resolveAttachmentBudget(
      candidate.retainedTokenCount +
        candidate.sourceTokenCount +
        candidate.summaryBudget,
      (snapshot.investigationSummaries?.length ?? 0) > 0
    )
    const plan = this.buildPlanFromCandidate(
      state,
      snapshot,
      attachmentTokenBudget,
      candidate,
      input.summary,
      input.hookUserMessage
    )
    this.applyCompactionPlan(state, plan, input.emitTelemetry ?? true)
    return plan
  }

  private prepareCandidateForBudget(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    effectiveMaxTokens: number,
    attachmentTokenBudget: number,
    strategy: ContextCompactionCommit["strategy"],
    integrityMode?: "strict-adjacent" | "global"
  ): ContextCompactionCandidate | null {
    const commitId = randomUUID()
    const activeSlice = getRecordsAfterCompactBoundary(state.records)
    const sourceRecords = this.compactionSourceRecords(activeSlice)
    const messageRecords = sourceRecords.filter(isMessageRecord)
    if (sourceRecords.length <= 1 || messageRecords.length === 0) {
      return null
    }

    const liveAttachments = this.attachments.buildAttachments(
      this.buildProjectionSnapshot(state, snapshot),
      {
        maxTokens: attachmentTokenBudget,
      }
    )
    const attachmentFingerprint = fingerprintAttachments(liveAttachments)
    const attachmentTokens = this.tokenCounter.countMessages(
      liveAttachments.map((attachment) => ({
        role: "user",
        content: attachment.content,
      })) as UnifiedMessage[]
    )
    const summaryBudgetCap = this.resolveSummaryBudgetCap(effectiveMaxTokens)
    const envelopeTokens =
      this.estimateBoundaryTokens(commitId) +
      this.estimateSummaryEnvelopeTokens(commitId) +
      attachmentTokens
    const targetRecentTokens = Math.max(
      0,
      effectiveMaxTokens - envelopeTokens - summaryBudgetCap
    )
    const sourceMessages = sourceRecords.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    const truncationIndex =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        sourceMessages,
        targetRecentTokens,
        { mode: integrityMode }
      )
    if (truncationIndex <= 0 || truncationIndex >= sourceRecords.length) {
      return null
    }

    const archivedRecords = sourceRecords.slice(0, truncationIndex)
    const retainedRecords = sourceRecords
      .slice(truncationIndex)
      .filter(isMessageRecord)
    if (archivedRecords.length === 0 || retainedRecords.length === 0) {
      return null
    }

    const summaryBudget = Math.min(
      summaryBudgetCap,
      Math.max(
        this.MIN_SUMMARY_TOKENS,
        effectiveMaxTokens -
          envelopeTokens -
          this.tokenCounter.countMessages(
            retainedRecords.map((record) => ({
              role: record.role,
              content: record.content,
            })) as UnifiedMessage[]
          )
      )
    )
    const sourceTokenCount = this.tokenCounter.countMessages(
      archivedRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[]
    )
    const retainedTokenCount = this.tokenCounter.countMessages(
      retainedRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[]
    )

    return {
      commitId,
      strategy,
      createdAt: Date.now(),
      nextEpoch: (state.compactionEpoch || 0) + 1,
      archivedRecords,
      retainedRecords,
      summaryBudget,
      attachmentFingerprint,
      liveAttachments,
      sourceTokenCount,
      retainedTokenCount,
    }
  }

  private buildPlanFromCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    candidate: ContextCompactionCandidate,
    summaryText: string,
    hookUserMessage?: string
  ): ContextCompactionPlan {
    const summary = summaryText.trim()
    const summaryTokenCount = this.tokenCounter.countText(summary)
    const archivedRecords = candidate.archivedRecords
    const retainedRecords = candidate.retainedRecords
    const commitId = candidate.commitId
    const archivedThroughRecordId =
      archivedRecords[archivedRecords.length - 1]!.id
    const sessionMemoryEntries = this.sessionMemory.buildEntries(
      archivedRecords.filter(isMessageRecord),
      {
        sourceCompactionId: candidate.commitId,
        archivedThroughRecordId,
      }
    )
    const commit: ContextCompactionCommit = {
      id: commitId,
      strategy: candidate.strategy,
      createdAt: candidate.createdAt,
      epoch: candidate.nextEpoch,
      parentCompactionId: undefined,
      archivedThroughRecordId,
      projectionAnchorRecordId: retainedRecords[0]?.id,
      archivedMessageCount: archivedRecords.filter(isMessageRecord).length,
      sourceRecordCount: archivedRecords.length,
      retainedStartRecordId: retainedRecords[0]?.id,
      retainedRecordCount: retainedRecords.length,
      retainedTextRecordCount: this.countTextRecords(retainedRecords),
      retainedTokenCount: candidate.retainedTokenCount,
      attachmentFingerprint: candidate.attachmentFingerprint,
      sourceTokenCount: candidate.sourceTokenCount,
      summary,
      summaryTokenCount,
      projectedTokenCount: 0,
    }
    const createdAt = Date.now()
    const attachmentRecords = candidate.liveAttachments.map(
      (attachment, index) =>
        createAttachmentRecord(attachment, commit.id, createdAt + 2 + index)
    )
    const hookResultRecords = hookUserMessage?.trim()
      ? [
          createHookResultRecord(
            {
              compactionId: commit.id,
              trigger: commit.strategy,
              content: hookUserMessage.trim(),
            },
            createdAt + 2 + attachmentRecords.length
          ),
        ]
      : []
    const simulatedState = this.cloneState(state)
    this.applyCompactionPlan(
      simulatedState,
      {
        commit,
        projectedMessages: [],
        estimatedTokens: 0,
        attachmentFingerprint: candidate.attachmentFingerprint,
        recordCount: state.records.length,
        retainedRecords,
        attachmentRecords,
        hookResultRecords,
        sessionMemoryEntries,
      },
      false
    )
    const projectedMessages = this.buildProjectedMessages(
      simulatedState,
      snapshot,
      attachmentTokenBudget
    )
    commit.projectedTokenCount = this.countProjected(projectedMessages)

    return {
      commit,
      projectedMessages,
      estimatedTokens: commit.projectedTokenCount,
      attachmentFingerprint: candidate.attachmentFingerprint,
      recordCount: state.records.length,
      retainedRecords,
      attachmentRecords,
      hookResultRecords,
      sessionMemoryEntries,
    }
  }

  private applyCompactionPlan(
    state: ContextConversationState,
    plan: ContextCompactionPlan,
    emitTelemetry = true
  ): void {
    const createdAt = Date.now()
    state.records = [
      createCompactBoundaryRecord(plan.commit, createdAt),
      createCompactSummaryRecord(plan.commit, createdAt + 1),
      ...plan.retainedRecords,
      ...(plan.attachmentRecords || []),
      ...(plan.hookResultRecords || []),
    ]
    state.sessionMemory = this.sessionMemory.mergeEntries(
      state.sessionMemory,
      plan.sessionMemoryEntries || []
    )
    state.compactionHistory = deriveCompactionHistoryFromTranscript(
      state.records
    )
    state.activeCompactionId = plan.commit.id
    state.compactionEpoch =
      plan.commit.epoch ?? (state.compactionEpoch || 0) + 1
    state.lastAppliedCompaction = {
      recordCount: state.records.length,
      attachmentFingerprint: plan.attachmentFingerprint,
      appliedAt: createdAt,
      compactionId: plan.commit.id,
      epoch: state.compactionEpoch,
    }
    this.resetDerivedCompactionState(state)
    if (emitTelemetry) {
      this.telemetry.recordEvent({
        event: "compaction.boundary_applied",
        metadata: {
          archivedMessageCount: plan.commit.archivedMessageCount,
          sourceTokenCount: plan.commit.sourceTokenCount,
          summaryTokenCount: plan.commit.summaryTokenCount,
          epoch: state.compactionEpoch,
        },
      })
      if (plan.sessionMemoryEntries?.length) {
        this.telemetry.recordEvent({
          event: "compaction.session_memory_updated",
          delta: plan.sessionMemoryEntries.length,
          metadata: {
            entries: plan.sessionMemoryEntries.length,
            totalEntries: state.sessionMemory.length,
          },
        })
      }
    }
  }

  private applyIdleMicrocompact(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number
  ):
    | {
        changed: boolean
        projectedMessages: ProjectedContextMessage[]
        estimatedTokens: number
        result: ToolResultCompactionResult
      }
    | undefined {
    const activeSlice = getRecordsAfterCompactBoundary(state.records, {
      includeSnipped: true,
    })
    const compactableRecords = activeSlice.filter(isMessageRecord)
    if (compactableRecords.length === 0) return undefined

    const beforeTokens = this.tokenCounter.countMessages(
      compactableRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[]
    )
    const result = this.toolResultCompaction.compactRecords(
      compactableRecords,
      { trigger: "idle" },
      state.toolResultReplacementState
    )
    if (!result.changed) {
      return {
        changed: false,
        projectedMessages: this.buildProjectedMessages(
          state,
          snapshot,
          attachmentTokenBudget
        ),
        estimatedTokens: this.countProjected(
          this.buildProjectedMessages(state, snapshot, attachmentTokenBudget)
        ),
        result,
      }
    }

    state.records = this.replaceActiveMessageRecords(
      state.records,
      result.records
    )
    state.records.push(
      createMicrocompactBoundaryRecord({
        preTokens: beforeTokens,
        tokensSaved: Math.max(0, beforeTokens - result.estimatedTokens),
        compactedToolIds: result.compactedToolIds || [],
        trigger: "idle",
      })
    )
    const projectedMessages = this.buildProjectedMessages(
      state,
      snapshot,
      attachmentTokenBudget
    )
    return {
      changed: true,
      projectedMessages,
      estimatedTokens: this.countProjected(projectedMessages),
      result,
    }
  }

  private applyDurableSnip(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    effectiveMaxTokens: number,
    integrityMode?: "strict-adjacent" | "global"
  ):
    | {
        changed: boolean
        projectedMessages: ProjectedContextMessage[]
        estimatedTokens: number
        result: ContextSnipCompactionResult
      }
    | undefined {
    const activeSlice = getRecordsAfterCompactBoundary(state.records, {
      includeSnipped: true,
    })
    const messageRecords =
      projectSnippedView(activeSlice).filter(isMessageRecord)
    if (messageRecords.length <= this.SNIP_MIN_REMOVED_RECORDS) {
      return undefined
    }

    const attachmentTokens = this.countProjected(
      this.projection.project(state, {
        attachmentSnapshot: this.buildProjectionSnapshot(state, snapshot),
        attachmentTokenBudget,
        recordsOverride: activeSlice.filter(
          (record) => !isMessageRecord(record)
        ),
      })
    )
    const recordBudget = Math.max(0, effectiveMaxTokens - attachmentTokens)
    const messages = messageRecords.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    const truncationIndex =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        messages,
        recordBudget,
        { mode: integrityMode }
      )
    if (truncationIndex < this.SNIP_MIN_REMOVED_RECORDS) {
      return undefined
    }
    const removed = messageRecords.slice(0, truncationIndex)
    const retained = messageRecords.slice(truncationIndex)
    if (
      removed.length < this.SNIP_MIN_REMOVED_RECORDS ||
      retained.length === 0
    ) {
      return undefined
    }

    state.records.push(
      createSnipBoundaryRecord(removed.map((record) => record.id))
    )
    const projectedMessages = this.buildProjectedMessages(
      state,
      snapshot,
      attachmentTokenBudget
    )
    const estimatedTokens = this.countProjected(projectedMessages)
    return {
      changed: true,
      projectedMessages,
      estimatedTokens,
      result: {
        changed: true,
        removedRecords: removed.length,
        retainedRecords: retained.length,
        summaryTokenCount: 0,
        estimatedTokens,
      },
    }
  }

  private buildProjectedMessages(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number
  ): ProjectedContextMessage[] {
    return this.projection.project(state, {
      attachmentSnapshot: this.buildProjectionSnapshot(state, snapshot),
      attachmentTokenBudget,
    })
  }

  private buildProjectionSnapshot(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot
  ): ContextAttachmentSnapshot {
    return {
      ...snapshot,
      sessionMemory:
        state.sessionMemory.length > 0
          ? this.sessionMemory.toAttachmentSummaries(state.sessionMemory)
          : snapshot.sessionMemory,
    }
  }

  private compactionSourceRecords(
    activeSlice: readonly ContextTranscriptRecord[]
  ): ContextTranscriptRecord[] {
    return activeSlice.filter(
      (record) => isMessageRecord(record) || isCompactSummaryRecord(record)
    )
  }

  private messageRecordsFromActiveSlice(
    records: readonly ContextTranscriptRecord[]
  ): ContextTranscriptRecord[] {
    return getRecordsAfterCompactBoundary(records).filter(isMessageRecord)
  }

  private replaceActiveMessageRecords(
    records: readonly ContextTranscriptRecord[],
    nextMessageRecords: readonly ContextTranscriptRecord[]
  ): ContextTranscriptRecord[] {
    const nextById = new Map(
      nextMessageRecords.map((record) => [record.id, record])
    )
    return records.map((record) => {
      if (!isMessageRecord(record)) return record
      return nextById.get(record.id) || record
    })
  }

  private sanitizeProjectedMessages(
    projected: ProjectedContextMessage[],
    options?: {
      pendingToolUseIds?: Iterable<string>
      integrityMode?: "strict-adjacent" | "global"
    }
  ): UnifiedMessage[] {
    const unified = projected.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]
    return this.toolIntegrity.sanitizeMessages(unified, {
      mode: options?.integrityMode ?? "global",
      pendingToolUseIds: options?.pendingToolUseIds,
    }).messages
  }

  private countProjected(projected: ProjectedContextMessage[]): number {
    return this.tokenCounter.countMessages(
      projected.map((message) => ({
        role: message.role,
        content: message.content,
      })) as UnifiedMessage[]
    )
  }

  private resolvePressureBudget(
    hardMaxTokens: number,
    options: {
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      systemPromptTokens: number
    }
  ): number {
    const pressureLimits = [
      this.normalizePositiveInteger(options.autoCompactTokenLimit),
      this.normalizePositiveInteger(options.predictiveCompactTokenLimit),
    ]
      .filter((value): value is number => value != null)
      .map((value) =>
        Math.max(
          Math.min(value - options.systemPromptTokens, hardMaxTokens),
          this.MIN_REQUEST_BUDGET
        )
      )
      .filter((value) => value < hardMaxTokens)
    return pressureLimits.length > 0
      ? Math.min(...pressureLimits)
      : hardMaxTokens
  }

  private shouldCompact(
    estimated: number,
    hardMaxTokens: number,
    targetMaxTokens: number
  ): boolean {
    return estimated > hardMaxTokens || estimated >= targetMaxTokens
  }

  private recordPressureTelemetry(
    estimated: number,
    hardMaxTokens: number,
    targetMaxTokens: number
  ): void {
    if (targetMaxTokens < hardMaxTokens && estimated >= targetMaxTokens) {
      this.telemetry.recordEvent({
        event: "compaction.auto_compact_limit_reached",
        metadata: {
          hardMaxTokens,
          autoCompactTokenLimit: targetMaxTokens,
        },
      })
    }
    if (estimated > hardMaxTokens) {
      this.telemetry.recordEvent({
        event: "compaction.predictive_limit_reached",
        metadata: {
          hardMaxTokens,
          estimatedTokens: estimated,
        },
      })
    }
  }

  private recordResultTelemetry(
    snipCompaction: ContextSnipCompactionResult | undefined,
    microcompactCompaction: ToolResultCompactionResult | undefined
  ): void {
    if (snipCompaction?.changed) {
      this.telemetry.recordEvent({
        event: "compaction.snip_applied",
        metadata: {
          removedRecords: snipCompaction.removedRecords,
          retainedRecords: snipCompaction.retainedRecords,
          summaryTokenCount: snipCompaction.summaryTokenCount,
        },
      })
    }
    if (microcompactCompaction?.changed) {
      const triggerEvent: ContextTelemetryEvent =
        microcompactCompaction.trigger === "reactive"
          ? "compaction.microcompact_reactive"
          : microcompactCompaction.trigger === "preflight"
            ? "compaction.microcompact_preflight"
            : "compaction.microcompact_idle"
      this.telemetry.recordEvent({
        event: triggerEvent,
        metadata: {
          clearedToolResults: microcompactCompaction.clearedToolResults,
          compactedRounds: microcompactCompaction.compactedRounds,
          keptRecentRounds: microcompactCompaction.keptRecentRounds,
        },
      })
    }
  }

  private resetDerivedCompactionState(state: ContextConversationState): void {
    if (state.investigationMemory.length > 0) {
      state.investigationMemory = []
    }
    if (state.toolResultReplacementState) {
      state.toolResultReplacementState = {
        seenToolUseIds: [],
        replacementByToolUseId: {},
        storedByToolUseId: {},
        records: [],
      }
    }
    this.nativeCacheEdits.reset(state)
  }

  private cloneState(
    state: ContextConversationState
  ): ContextConversationState {
    return {
      ...state,
      records: state.records.map((record) => ({ ...record })),
      compactionHistory: state.compactionHistory.map((commit) => ({
        ...commit,
        codexReplacementHistory: commit.codexReplacementHistory
          ? {
              ...commit.codexReplacementHistory,
              items: commit.codexReplacementHistory.items.map((item) => ({
                ...item,
              })),
            }
          : undefined,
      })),
      usageLedger: { ...state.usageLedger },
      codexContext: state.codexContext
        ? {
            ...state.codexContext,
            tokenInfo: state.codexContext.tokenInfo
              ? { ...state.codexContext.tokenInfo }
              : undefined,
            referenceContextItem: state.codexContext.referenceContextItem
              ? {
                  ...state.codexContext.referenceContextItem,
                  truncationPolicy: {
                    ...state.codexContext.referenceContextItem.truncationPolicy,
                  },
                }
              : undefined,
            replacementHistory: state.codexContext.replacementHistory
              ? {
                  ...state.codexContext.replacementHistory,
                  items: state.codexContext.replacementHistory.items.map(
                    (item) => ({ ...item })
                  ),
                }
              : undefined,
            truncationPolicy: { ...state.codexContext.truncationPolicy },
          }
        : undefined,
      toolResultReplacementState: state.toolResultReplacementState
        ? {
            seenToolUseIds: [
              ...state.toolResultReplacementState.seenToolUseIds,
            ],
            replacementByToolUseId: {
              ...state.toolResultReplacementState.replacementByToolUseId,
            },
            storedByToolUseId: {
              ...(state.toolResultReplacementState.storedByToolUseId || {}),
            },
            records: [...(state.toolResultReplacementState.records || [])],
          }
        : undefined,
      nativeCacheEditState: state.nativeCacheEditState
        ? {
            toolOrder: [...state.nativeCacheEditState.toolOrder],
            deletedToolUseIds: [
              ...state.nativeCacheEditState.deletedToolUseIds,
            ],
            pinnedEdits: state.nativeCacheEditState.pinnedEdits.map((pin) => ({
              ...pin,
              block: {
                type: "cache_edits",
                edits: pin.block.edits.map((edit) => ({ ...edit })),
              },
            })),
            toolsSentToApi: state.nativeCacheEditState.toolsSentToApi,
          }
        : undefined,
      investigationMemory: state.investigationMemory.map((entry) => ({
        ...entry,
      })),
      sessionMemory: state.sessionMemory.map((entry) => ({ ...entry })),
    }
  }

  private resolveAttachmentBudget(
    effectiveMaxTokens: number,
    hasInvestigationMemory: boolean
  ): number {
    const baseBudget = Math.min(
      this.ATTACHMENT_TOKEN_BUDGET,
      Math.max(
        this.MIN_ATTACHMENT_TOKENS,
        Math.floor(effectiveMaxTokens * 0.18)
      )
    )
    if (!hasInvestigationMemory) return baseBudget
    const proportionalBonus = Math.min(
      this.INVESTIGATION_MEMORY_ATTACHMENT_BONUS,
      Math.floor(effectiveMaxTokens * 0.03)
    )
    return Math.min(
      this.ATTACHMENT_TOKEN_BUDGET + proportionalBonus,
      baseBudget + proportionalBonus
    )
  }

  private resolveSummaryBudgetCap(effectiveMaxTokens: number): number {
    return Math.min(
      this.SUMMARY_TOKEN_BUDGET,
      Math.max(this.MIN_SUMMARY_TOKENS, Math.floor(effectiveMaxTokens * 0.22))
    )
  }

  private estimateBoundaryTokens(commitId: string): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content: this.projection.renderCompactionBoundary({
          id: commitId,
          strategy: "auto",
          createdAt: Date.now(),
          archivedThroughRecordId: commitId,
          archivedMessageCount: 0,
          sourceTokenCount: 0,
          summary: "",
          summaryTokenCount: 0,
          projectedTokenCount: 0,
        }),
      },
    ])
  }

  private estimateSummaryEnvelopeTokens(commitId: string): number {
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content: this.projection.renderCompactionSummary({
          id: commitId,
          strategy: "auto",
          createdAt: Date.now(),
          archivedThroughRecordId: commitId,
          archivedMessageCount: 0,
          sourceTokenCount: 0,
          summary: "",
          summaryTokenCount: 0,
          projectedTokenCount: 0,
        }),
      },
    ])
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }

  private countTextRecords(
    records: readonly ContextTranscriptRecord[]
  ): number {
    return records.filter((record) => {
      if (typeof record.content === "string") {
        return record.content.trim().length > 0
      }
      return record.content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 0
      )
    }).length
  }
}
