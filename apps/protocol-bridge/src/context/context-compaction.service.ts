import { Injectable, Logger } from "@nestjs/common"
import { randomUUID } from "crypto"
import { fingerprintAttachments } from "./attachment-fingerprint"
import { CompactWarningHookService } from "./compact-warning-hook.service"
import { CompactWarningStateService } from "./compact-warning-state.service"
import { PostCompactCleanupService } from "./post-compact-cleanup.service"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  createAttachmentRecord,
  createHookResultRecord,
  deriveCompactionHistoryFromTranscript,
  getRecordsAfterCompactBoundary,
  isContextCollapseSummaryRecord,
  isCompactSummaryRecord,
  isMessageRecord,
} from "./context-transcript-events"
import { ContextCollapseService } from "./context-collapse.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { SessionMemoryCompactionService } from "./session-memory-compaction.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextSessionMemoryEntry,
  ContextTranscriptRecord,
  ProjectedContextMessage,
  ContextProjectionAttachment,
  TextBlock,
  ToolResultBlock,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
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
  snipCompaction?: ContextSnipCompactionResult
}

@Injectable()
export class ContextCompactionService {
  private readonly logger = new Logger(ContextCompactionService.name)
  private readonly MIN_REQUEST_BUDGET = 256
  private readonly MIN_SUMMARY_TOKENS = 64
  private readonly MIN_ATTACHMENT_TOKENS = 128
  private readonly SUMMARY_TOKEN_BUDGET = 2400
  private readonly ATTACHMENT_TOKEN_BUDGET = 2200
  /**
   * Fraction of the pressure budget that a compaction retains as the recent
   * window. The pressure budget is the *trigger* (compact when projected
   * exceeds it); retaining right up to it would leave the post-compaction
   * projection sitting at the trigger again, so the very next tool result
   * re-fires compaction — thrashing that regenerates the LLM summary every few
   * K of growth and compounds summary loss (summary-of-summary). Retaining to
   * a fraction below the trigger leaves growth headroom so compaction fires in
   * larger, less frequent steps (cc compacts to below the threshold, not at
   * it). Keeps ample recent context (e.g. ~100K of a ~131K budget).
   */
  private readonly COMPACTION_RETENTION_RATIO = 0.8
  private readonly INVESTIGATION_MEMORY_ATTACHMENT_BONUS = 320
  private readonly SNIP_MIN_REMOVED_RECORDS = 2
  /**
   * cc-faithful microcompact tuning. Older tool results from read-only /
   * search / shell / web tools are content-cleared once more than
   * MICROCOMPACT_KEEP_RECENT_RESULTS such results exist, keeping the most
   * recent ones verbatim. Small results (< MICROCOMPACT_MIN_RESULT_TOKENS)
   * are left alone — clearing them saves nothing. Marker text mirrors cc's
   * TIME_BASED_MC_CLEARED_MESSAGE.
   */
  private readonly MICROCOMPACT_KEEP_RECENT_RESULTS = 12
  private readonly MICROCOMPACT_MIN_RESULT_TOKENS = 400
  private readonly MICROCOMPACT_CLEARED_MARKER =
    "[Old tool result content cleared]"
  private static readonly MICROCOMPACTABLE_TOOLS = new Set<string>([
    "read_file",
    "read_files",
    "read_project",
    "read_lints",
    "run_terminal_command",
    "grep_search",
    "glob_search",
    "file_search",
    "list_directory",
    "codebase_search",
    "web_search",
    "web_fetch",
  ])

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly projection: ContextProjectionService,
    private readonly attachments: ContextAttachmentBuilderService,
    private readonly usageLedger: ContextUsageLedgerService,
    private readonly sessionMemory: SessionMemoryCompactionService,
    private readonly contextCollapse: ContextCollapseService,
    private readonly telemetry: ContextTelemetryService,
    private readonly compactWarningState: CompactWarningStateService,
    private readonly compactWarningHook: CompactWarningHookService,
    private readonly postCompactCleanup: PostCompactCleanupService
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

    // cc parity: each new compaction round starts by clearing the
    // warning suppression so the predictive hook can re-evaluate.
    // Suppression is set back on by suppressCompactWarning hooks below
    // (cache_edits emission, applyCompactionPlan, microcompact path).
    if (!options.dryRun) {
      this.compactWarningState.clearCompactWarningSuppression(workingState)
    }

    let projected = this.buildProjectedMessages(
      workingState,
      snapshot,
      attachmentTokenBudget
    )
    const estimated = this.countProjected(projected)
    let snipCompaction: ContextSnipCompactionResult | undefined

    if (this.shouldCompact(estimated, hardMaxTokens, targetMaxTokens)) {
      // Diagnostics: count snip boundaries and the union of removed ids so
      // we can tell whether the projection is actually filtering out the
      // already-snipped tail. Without this, a 410K estimator reading is
      // ambiguous between "projection saw 1800 records" and "projection
      // saw 478 retained but the tokenizer is over-counting".
      let snipBoundaries = 0
      const cumulativeRemovedIds = new Set<string>()
      for (const record of workingState.records) {
        if (
          record.kind === "snip_boundary" ||
          (record as { type?: string }).type === "snip_boundary"
        ) {
          snipBoundaries++
          const ids = (
            record as {
              snipMetadata?: { removedRecordIds?: readonly string[] }
            }
          ).snipMetadata?.removedRecordIds
          if (ids) {
            for (const id of ids) cumulativeRemovedIds.add(id)
          }
        }
      }
      const messageRecordCount = workingState.records.filter(
        (record) =>
          record.kind === "message" ||
          (record as { type?: string }).type === "message" ||
          (!record.kind &&
            (record.role === "user" || record.role === "assistant"))
      ).length
      this.recordPressureTelemetry(estimated, hardMaxTokens, targetMaxTokens, {
        totalRecords: workingState.records.length,
        messageRecords: messageRecordCount,
        snipBoundaries,
        cumulativeRemovedIds: cumulativeRemovedIds.size,
        projectedMessageCount: projected.length,
      })
      // Predictive warning: fire telemetry as we cross the 80% mark
      // before we actually compact. autoCompactTokenLimit is the same
      // ceiling resolvePressureBudget reads against.
      if (!options.dryRun && options.autoCompactTokenLimit) {
        this.compactWarningHook.maybeEmit({
          state: workingState,
          estimatedTokens: estimated,
          autoCompactLimit: options.autoCompactTokenLimit,
        })
      }
    }

    // Boundary model + cc-faithful microcompact (services/compact/
    // microCompact.ts). The projection is the boundary summary followed
    // by every post-boundary record. Under context pressure we
    // additionally content-clear OLD tool results from read/search/shell/
    // web tools: the most recent results stay verbatim, older ones are
    // replaced by a marker. Nothing is lost permanently — state.records
    // keep the full text; this is a per-send projection transform,
    // re-evaluated every round. It keeps context lean between LLM
    // boundary compactions without the over-aggressive whole-history
    // stripping that once collapsed the model's own findings
    // (~133K -> ~33K). True size reduction still comes from
    // compactIfNeeded; the hard-fit below is the last-resort fit.
    if (this.shouldCompact(estimated, hardMaxTokens, targetMaxTokens)) {
      const microcompacted = this.microcompactProjectedToolResults(projected)
      if (microcompacted) {
        projected = microcompacted
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

    this.recordResultTelemetry(snipCompaction)

    return {
      messages: finalMessages,
      projectedMessages: projected,
      estimatedTokens: messageTokens,
      wasCompacted: false,
      snipCompaction,
    }
  }

  private buildHardFitProjection(
    messages: UnifiedMessage[],
    hardMaxTokens: number,
    integrityMode?: "strict-adjacent" | "global",
    _pendingToolUseIds?: Iterable<string>
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

      // findBudgetSafeTruncationPointWithIntegrity already aligns the
      // truncation index so the surviving slice keeps every tool_use
      // adjacent to its tool_result. The ledger guarantees no orphan
      // tool_use exists in the source, so direct slice is sufficient.
      const candidate = messages.slice(truncationIndex)
      if (candidate.length === 0) continue

      const estimatedTokens = this.tokenCounter.countMessages(candidate)
      if (estimatedTokens > hardMaxTokens) continue

      return {
        messages: candidate,
        projectedMessages: candidate.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
          source: "snip",
          // Snip is a tail-truncate (no merging / re-wrapping); the
          // messageId on each retained record stays valid, so propagate
          // it for downstream send-time sibling merge.
          ...(message.messageId ? { messageId: message.messageId } : {}),
          // Same for isMeta — snip preserves the meta semantics of the
          // surviving messages (e.g. a retained compaction summary
          // stays meta, a retained user turn stays not-meta).
          ...(message.isMeta ? { isMeta: true } : {}),
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
    const projectedTokens = this.countProjected(projected)
    if (projectedTokens <= effectiveMaxTokens) {
      this.logger.debug(
        `prepareCompactionCandidate: skipped (projected=${projectedTokens} <= effective=${effectiveMaxTokens}, ` +
          `hardMax=${hardMaxTokens}, sysPrompt=${options.systemPromptTokens}, ` +
          `auto=${options.autoCompactTokenLimit ?? "(none)"}, pred=${options.predictiveCompactTokenLimit ?? "(none)"})`
      )
      return null
    }
    const candidate = this.prepareCandidateForBudget(
      state,
      snapshot,
      effectiveMaxTokens,
      attachmentTokenBudget,
      options.strategy || "auto",
      options.integrityMode
    )
    if (!candidate) {
      this.logger.debug(
        `prepareCompactionCandidate: prepareCandidateForBudget returned null ` +
          `(projected=${projectedTokens}, effective=${effectiveMaxTokens}, ` +
          `attachmentBudget=${attachmentTokenBudget}, strategy=${options.strategy || "auto"})`
      )
    }
    return candidate
  }

  applyGeneratedSummaryCompaction(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    candidate: ContextCompactionCandidate,
    input: {
      summary: string
      hookUserMessage?: string
      emitTelemetry?: boolean
      meta?: {
        sessionId?: string
        conversationId?: string
        agentId?: string
        querySource?: string
        notifyPromptCacheCompaction?: () => void
      }
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
    this.applyCompactionPlan(
      state,
      plan,
      input.emitTelemetry ?? true,
      input.meta
    )
    return plan
  }

  /**
   * Prepare a "partial" compaction candidate around a chosen pivot record,
   * mirroring Claude Code's `partialCompactConversation`
   * (services/compact/compact.ts:801).
   *
   * direction='up_to': summarize every record before `pivotRecordId`, keep
   *   `pivotRecordId` and everything after it. This is the "topic switch"
   *   pivot — the user's most recent message stays as the kept anchor and
   *   all earlier exploration collapses into a summary.
   *
   * direction='from': summarize the records from `pivotRecordId` onward and
   *   keep what came before. Used to roll a long tangent into a summary
   *   while preserving the original mainline.
   *
   * Returns null when:
   *   - the pivot record is missing or out of bounds
   *   - either side of the pivot would be empty after slicing
   *   - tool_use/tool_result integrity cannot be preserved at the pivot
   */
  prepareUpToCompactionCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    options: {
      maxTokens: number
      systemPromptTokens: number
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    return this.prepareDirectionalCandidate(
      state,
      snapshot,
      pivotRecordId,
      "up_to",
      options
    )
  }

  prepareFromCompactionCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    options: {
      maxTokens: number
      systemPromptTokens: number
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    return this.prepareDirectionalCandidate(
      state,
      snapshot,
      pivotRecordId,
      "from",
      options
    )
  }

  private prepareDirectionalCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    direction: "up_to" | "from",
    options: {
      maxTokens: number
      systemPromptTokens: number
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    const hardMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    const attachmentTokenBudget = this.resolveAttachmentBudget(
      hardMaxTokens,
      (snapshot.investigationSummaries?.length ?? 0) > 0
    )
    const activeSlice = this.contextCollapse.projectRecords(
      state,
      getRecordsAfterCompactBoundary(state.records)
    )
    const sourceRecords = this.compactionSourceRecords(activeSlice)
    if (sourceRecords.length === 0) {
      return null
    }

    const pivotIndex = sourceRecords.findIndex(
      (record) => record.id === pivotRecordId
    )
    if (pivotIndex < 0) {
      return null
    }

    let archivedRecords: ContextTranscriptRecord[]
    let retainedRecords: ContextTranscriptRecord[]
    if (direction === "up_to") {
      archivedRecords = sourceRecords.slice(0, pivotIndex)
      retainedRecords = sourceRecords.slice(pivotIndex).filter(isMessageRecord)
    } else {
      archivedRecords = sourceRecords.slice(pivotIndex + 1)
      retainedRecords = sourceRecords
        .slice(0, pivotIndex + 1)
        .filter(isMessageRecord)
    }

    if (archivedRecords.length === 0 || retainedRecords.length === 0) {
      return null
    }

    // Ensure the slice boundary does not split a tool_use / tool_result pair
    // by walking the archived/retained boundary one record outward in the
    // archive direction. The toolIntegrity service exposes
    // findBudgetSafeTruncationPointWithIntegrity, but here we want the
    // pivot-anchored variant: just check whether the surviving
    // tool_use/tool_result references resolve, and reject if they don't.
    const safeArchive =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        sourceRecords.map((record) => ({
          role: record.role,
          content: record.content,
        })) as UnifiedMessage[],
        direction === "up_to"
          ? this.tokenCounter.countMessages(
              sourceRecords.slice(pivotIndex).map((record) => ({
                role: record.role,
                content: record.content,
              })) as UnifiedMessage[]
            )
          : this.tokenCounter.countMessages(
              sourceRecords.slice(0, pivotIndex + 1).map((record) => ({
                role: record.role,
                content: record.content,
              })) as UnifiedMessage[]
            ),
        { mode: options.integrityMode }
      )
    if (
      direction === "up_to" &&
      safeArchive > 0 &&
      safeArchive !== pivotIndex
    ) {
      // Toolchain integrity nudged the boundary; recompute archived/retained.
      archivedRecords = sourceRecords.slice(0, safeArchive)
      retainedRecords = sourceRecords.slice(safeArchive).filter(isMessageRecord)
    }

    const messageRecordsInArchive = archivedRecords.filter(isMessageRecord)
    if (messageRecordsInArchive.length === 0 || retainedRecords.length === 0) {
      return null
    }

    const liveAttachments = this.attachments.buildAttachments(
      this.buildProjectionSnapshot(state, snapshot),
      { maxTokens: attachmentTokenBudget }
    )
    const attachmentFingerprint = fingerprintAttachments(liveAttachments)
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
    const summaryBudget = Math.max(
      this.MIN_SUMMARY_TOKENS,
      Math.min(
        this.resolveSummaryBudgetCap(hardMaxTokens),
        Math.floor(sourceTokenCount / 2)
      )
    )

    return {
      commitId: randomUUID(),
      strategy: options.strategy || "manual",
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
      this.logger.debug(
        `prepareCandidateForBudget: too few source records ` +
          `(source=${sourceRecords.length}, message=${messageRecords.length})`
      )
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
    // Retain to a fraction BELOW the pressure budget (the trigger) so the
    // post-compaction projection has growth headroom and compaction does not
    // immediately re-fire on the next tool result. Only the retention target
    // is reduced; the trigger (skip decision in prepareCompactionCandidate)
    // still uses the full effectiveMaxTokens.
    const retentionBudget = Math.floor(
      effectiveMaxTokens * this.COMPACTION_RETENTION_RATIO
    )
    const targetRecentTokens = Math.max(
      0,
      retentionBudget - envelopeTokens - summaryBudgetCap
    )
    const sourceMessages = sourceRecords.map((record) => ({
      role: record.role,
      content: record.content,
    })) as UnifiedMessage[]
    // Budget-only recent window: the smallest archive that lets the retained
    // suffix fit targetRecentTokens.
    const budgetTruncationIndex = this.tokenCounter.findTruncationIndex(
      sourceMessages,
      targetRecentTokens
    )
    // Integrity-safe point. In long autonomous runs an async / long-running
    // tool's tool_use and tool_result can span the whole window; then there is
    // no orphan-free suffix that also fits budget, so this collapses to
    // archiving (nearly) everything (it advances PAST the budget point). Detect
    // that and instead keep the budget-sized recent window, repairing the
    // orphaned tool_results (whose tool_use is archived into the boundary) into
    // text so the window stays protocol-valid. This preserves recent context
    // across compaction (cc compact_partial semantics) rather than nuking it.
    const integrityTruncationIndex =
      this.toolIntegrity.findBudgetSafeTruncationPointWithIntegrity(
        sourceMessages,
        targetRecentTokens,
        { mode: integrityMode }
      )
    const repairOrphanedRetainedResults =
      integrityTruncationIndex > budgetTruncationIndex
    const truncationIndex = repairOrphanedRetainedResults
      ? budgetTruncationIndex
      : integrityTruncationIndex
    if (truncationIndex <= 0 || truncationIndex >= sourceRecords.length) {
      this.logger.debug(
        `prepareCandidateForBudget: truncationIndex out of range ` +
          `(idx=${truncationIndex}, budgetIdx=${budgetTruncationIndex}, ` +
          `integrityIdx=${integrityTruncationIndex}, sourceLen=${sourceRecords.length}, ` +
          `targetRecent=${targetRecentTokens}, effectiveMax=${effectiveMaxTokens}, ` +
          `envelope=${envelopeTokens}, summaryCap=${summaryBudgetCap}, ` +
          `attachmentTokens=${attachmentTokens})`
      )
      return null
    }

    const archivedRecords = sourceRecords.slice(0, truncationIndex)
    const retainedRecords = sourceRecords
      .slice(truncationIndex)
      .filter(isMessageRecord)
    if (repairOrphanedRetainedResults) {
      // The retained window can hold tool_results whose tool_use is archived
      // (async/long-running pairs spanning the window). We do NOT rewrite the
      // stored records here — replaceMessages reconcile overwrites them by id
      // from Cursor's re-sent transcript, which would undo any rewrite. The
      // orphaned tool_results are instead repaired into text at send time in
      // sanitizeProjectedMessages, which runs every projection and is immune
      // to that overwrite.
      this.logger.debug(
        `prepareCandidateForBudget: integrity cut would over-archive ` +
          `(integrityIdx=${integrityTruncationIndex} > budgetIdx=${budgetTruncationIndex}); ` +
          `kept budget recent window; orphaned tool_results repaired at send`
      )
    }
    if (archivedRecords.length === 0 || retainedRecords.length === 0) {
      this.logger.debug(
        `prepareCandidateForBudget: empty side after split ` +
          `(archived=${archivedRecords.length}, retained=${retainedRecords.length})`
      )
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
    emitTelemetry = true,
    meta?: {
      sessionId?: string
      conversationId?: string
      agentId?: string
      querySource?: string
      notifyPromptCacheCompaction?: () => void
    }
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
    // cc parity: replaced the in-line resetDerivedCompactionState
    // helper with a multi-phase service so cache-edit lifecycle, warn
    // suppression, and prompt-cache baselines all reset together. The
    // service is best-effort per phase — see PostCompactCleanupService
    // for the rationale on why each phase swallows its own failures.
    this.postCompactCleanup.run(state, {
      conversationId: meta?.conversationId,
      sessionId: meta?.sessionId,
      agentId: meta?.agentId,
      querySource: meta?.querySource,
      notifyPromptCacheCompaction: meta?.notifyPromptCacheCompaction,
    })
    // cc parity: a successful boundary compaction is the loudest "I
    // already handled the pressure" signal — suppress the next round
    // of warning telemetry until the predictive hook re-evaluates.
    this.compactWarningState.suppressCompactWarning(state)
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

  /**
   * Repair orphaned tool_result blocks in retained records — those whose
   * tool_use was archived into the compaction boundary. Convert each to a text
   * block (preserving the result content) so the retained recent window stays
   * protocol-valid without its tool_use present. Used when an async /
   * long-running tool pair spans the window and a clean integrity cut would
   * otherwise archive everything, collapsing recent context.
   */
  /**
   * Repair orphaned tool_result blocks at send time — those whose tool_use is
   * not present in the projected message set (archived behind a compaction
   * boundary; partial compaction keeps a recent window that can include a
   * tool_result whose async/long-running tool_use was summarized). Convert
   * each to a text block preserving the result content so the request stays
   * protocol-valid without its tool_use. Applied on the projected/sanitized
   * messages every send — NOT on stored records — so it survives Cursor
   * re-sending the original transcript (replaceMessages reconcile overwrites
   * stored records by id).
   */
  private repairOrphanedToolResults(
    messages: UnifiedMessage[]
  ): UnifiedMessage[] {
    const toolUseIds = new Set<string>()
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isToolUseBlock(block)) {
            toolUseIds.add(block.id)
          }
        }
      }
    }
    let repairedCount = 0
    const repaired = messages.map((message) => {
      if (!Array.isArray(message.content)) return message
      let changed = false
      const content = message.content.map((block) => {
        if (isToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
          changed = true
          repairedCount += 1
          return {
            type: "text",
            text: this.renderOrphanedToolResultText(block),
          } as TextBlock
        }
        return block
      })
      return changed ? { ...message, content } : message
    })
    if (repairedCount > 0) {
      this.logger.debug(
        `repairOrphanedToolResults: repaired ${repairedCount} orphaned tool_result(s) into text for send validity`
      )
    }
    return repaired
  }

  private renderOrphanedToolResultText(block: ToolResultBlock): string {
    const body =
      typeof block.content === "string"
        ? block.content
        : block.content
            .map((inner) => (isTextBlock(inner) ? inner.text : ""))
            .filter((text) => text.length > 0)
            .join("\n")
    return (
      `[Tool result for an earlier tool call now summarized into the ` +
      `compaction summary above]\n${body}`
    )
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
      (record) =>
        isMessageRecord(record) ||
        isCompactSummaryRecord(record) ||
        isContextCollapseSummaryRecord(record)
    )
  }

  private sanitizeProjectedMessages(
    projected: ProjectedContextMessage[],
    _options?: {
      pendingToolUseIds?: Iterable<string>
      integrityMode?: "strict-adjacent" | "global"
    }
  ): UnifiedMessage[] {
    const unified = projected.map((message) => ({
      role: message.role,
      content: message.content,
      // Preserve the Anthropic split-sibling key end-to-end so the
      // send-time normalize pipeline can fold siblings. Other projected
      // sources (boundary / summary / attachment / hook) have no
      // messageId — leaving the field undefined is correct there.
      ...(message.messageId ? { messageId: message.messageId } : {}),
      // cc-style isMeta — boundary / summary / attachment / hook
      // sources are infrastructure plumbing. Carry through so the
      // wire layer / transcript bridge can hide them. Only set when
      // true; absent on real user/assistant turns.
      ...(message.isMeta ? { isMeta: true } : {}),
    })) as UnifiedMessage[]
    // Repair tool_result blocks orphaned by partial compaction (their
    // tool_use was archived behind the boundary). Done here, at send time,
    // rather than on stored records — replaceMessages reconcile overwrites
    // stored records by id from Cursor's re-sent transcript, so a record
    // rewrite would not survive; this projection transform runs every send.
    return this.repairOrphanedToolResults(unified)
  }

  /**
   * cc-faithful microcompact: content-clear OLD tool results from
   * read-only/search/shell/web tools, keeping the most recent
   * MICROCOMPACT_KEEP_RECENT_RESULTS verbatim. Pure transform over the
   * projected view — the underlying transcript records keep their full
   * text, so it is reversible and re-evaluated every send. Returns a new
   * array when something was cleared, otherwise undefined.
   */
  private microcompactProjectedToolResults(
    projected: ProjectedContextMessage[]
  ): ProjectedContextMessage[] | undefined {
    const toolNameById = new Map<string, string>()
    for (const message of projected) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        continue
      }
      for (const block of message.content) {
        const b = block as { type?: string; id?: unknown; name?: unknown }
        if (
          b?.type === "tool_use" &&
          typeof b.id === "string" &&
          typeof b.name === "string"
        ) {
          toolNameById.set(b.id, b.name)
        }
      }
    }

    const clearable: Array<{ messageIndex: number; blockIndex: number }> = []
    projected.forEach((message, messageIndex) => {
      if (!Array.isArray(message.content)) return
      message.content.forEach((block, blockIndex) => {
        const b = block as {
          type?: string
          tool_use_id?: unknown
          content?: unknown
        }
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") {
          return
        }
        const toolName = toolNameById.get(b.tool_use_id)
        if (
          !toolName ||
          !ContextCompactionService.MICROCOMPACTABLE_TOOLS.has(toolName)
        ) {
          return
        }
        const text = this.toolResultBlockText(b.content)
        if (text === this.MICROCOMPACT_CLEARED_MARKER) return
        if (
          this.tokenCounter.countText(text) <
          this.MICROCOMPACT_MIN_RESULT_TOKENS
        ) {
          return
        }
        clearable.push({ messageIndex, blockIndex })
      })
    })

    if (clearable.length <= this.MICROCOMPACT_KEEP_RECENT_RESULTS) {
      return undefined
    }

    const toClear = new Set(
      clearable
        .slice(0, clearable.length - this.MICROCOMPACT_KEEP_RECENT_RESULTS)
        .map((hit) => `${hit.messageIndex}:${hit.blockIndex}`)
    )

    return projected.map((message, messageIndex) => {
      if (!Array.isArray(message.content)) return message
      let touched = false
      const content = message.content.map((block, blockIndex) => {
        if (!toClear.has(`${messageIndex}:${blockIndex}`)) return block
        touched = true
        return {
          ...(block as object),
          content: this.MICROCOMPACT_CLEARED_MARKER,
        }
      })
      return touched
        ? { ...message, content: content as ProjectedContextMessage["content"] }
        : message
    })
  }

  private toolResultBlockText(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const p = part as { text?: unknown }
          return typeof p?.text === "string" ? p.text : ""
        })
        .join("\n")
    }
    return ""
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
    targetMaxTokens: number,
    diagnostics?: {
      totalRecords: number
      messageRecords: number
      snipBoundaries: number
      cumulativeRemovedIds: number
      projectedMessageCount: number
    }
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
      if (diagnostics) {
        this.logger.debug(
          `predictive_limit diag: estimated=${estimated} hardMax=${hardMaxTokens} ` +
            `totalRecords=${diagnostics.totalRecords} ` +
            `messageRecords=${diagnostics.messageRecords} ` +
            `snipBoundaries=${diagnostics.snipBoundaries} ` +
            `cumulativeRemovedIds=${diagnostics.cumulativeRemovedIds} ` +
            `projectedMessages=${diagnostics.projectedMessageCount}`
        )
      }
    }
  }

  private recordResultTelemetry(
    snipCompaction: ContextSnipCompactionResult | undefined
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
      investigationMemory: state.investigationMemory.map((entry) => ({
        ...entry,
      })),
      sessionMemory: state.sessionMemory.map((entry) => ({ ...entry })),
      contextCollapseState: state.contextCollapseState
        ? {
            updatedAt: state.contextCollapseState.updatedAt,
            commits: state.contextCollapseState.commits.map((commit) => ({
              ...commit,
              archivedRecordIds: [...commit.archivedRecordIds],
            })),
          }
        : undefined,
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
