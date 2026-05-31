import { Injectable, Logger } from "@nestjs/common"
import { createHash } from "crypto"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import { ContextCollapseService } from "./context-collapse.service"
import {
  ContextCompactionCandidate,
  ContextCompactionPlan,
  ContextCompactionService,
} from "./context-compaction.service"
import {
  isContextCollapseSummaryRecord,
  isMessageRecord,
  stripInternalContextEvents,
} from "./context-transcript-events"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import {
  CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
  CodexContextState,
  CodexRawResponseItemBlock,
  CodexReferenceContextItem,
  ContextCollapseCommit,
  CodexReplacementHistoryItem,
  CodexTruncationPolicy,
  ContextConversationState,
  ContextTranscriptRecord,
  LooseMessageContent,
  UnifiedMessage,
  extractText,
} from "./types"

export const CODEX_SUMMARIZATION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n")

export const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"

const DEFAULT_CODEX_TRUNCATION_POLICY: CodexTruncationPolicy = {
  mode: "bytes",
  limit: 10_000,
}

export interface CodexCompactReferenceInput {
  conversationId?: string
  model?: string
  systemPrompt?: string
  toolDefinitions?: unknown
  contextTokenLimit?: number
  serviceTier?: string
  reasoningEffort?: string
  truncationPolicy?: CodexTruncationPolicy
}

export interface CodexRemoteCompactRequest {
  messages: UnifiedMessage[]
  maxTokens: number
  candidate: ContextCompactionCandidate
  referenceContextItem: CodexReferenceContextItem
  /**
   * Aborted when the surrounding turn is superseded or cancelled. The
   * provider must thread this through to the underlying Codex Responses
   * compact request so a stale compaction does not race the next turn.
   */
  signal: AbortSignal
}

export interface CodexRemoteCompactResult {
  replacementHistory: CodexReplacementHistoryItem[]
}

export type CodexRemoteCompactProvider = (
  request: CodexRemoteCompactRequest
) => Promise<CodexRemoteCompactResult>

@Injectable()
export class CodexContextAdapterService {
  private readonly logger = new Logger(CodexContextAdapterService.name)

  constructor(
    private readonly compaction: ContextCompactionService,
    private readonly contextCollapse: ContextCollapseService,
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService
  ) {}

  ensureState(state: ContextConversationState): CodexContextState {
    if (!state.codexContext) {
      state.codexContext = {
        historyVersion: 0,
        truncationPolicy: { ...DEFAULT_CODEX_TRUNCATION_POLICY },
      }
    }
    if (!state.codexContext.truncationPolicy) {
      state.codexContext.truncationPolicy = {
        ...DEFAULT_CODEX_TRUNCATION_POLICY,
      }
    }
    return state.codexContext
  }

  buildReferenceContextItem(
    input: CodexCompactReferenceInput
  ): CodexReferenceContextItem {
    return {
      conversationId: input.conversationId,
      model: input.model,
      systemPromptHash: input.systemPrompt
        ? this.hashStable(input.systemPrompt)
        : undefined,
      toolSpecHash: input.toolDefinitions
        ? this.hashStable(input.toolDefinitions)
        : undefined,
      contextTokenLimit: input.contextTokenLimit,
      serviceTier: input.serviceTier,
      reasoningEffort: input.reasoningEffort,
      truncationPolicy: {
        ...(input.truncationPolicy || DEFAULT_CODEX_TRUNCATION_POLICY),
      },
      updatedAt: Date.now(),
    }
  }

  async compactIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      referenceContextItem: CodexReferenceContextItem
      injectionMode: "pre_turn" | "mid_turn"
      hookUserMessage?: string
      hookProvider?: (
        candidate: ContextCompactionCandidate
      ) => Promise<string | undefined>
      remoteCompactProvider: CodexRemoteCompactProvider
      signal: AbortSignal
      meta?: {
        sessionId?: string
        conversationId?: string
        agentId?: string
        querySource?: string
        notifyPromptCacheCompaction?: () => void
      }
    }
  ): Promise<ContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      {
        maxTokens: options.maxTokens,
        systemPromptTokens: options.systemPromptTokens,
        autoCompactTokenLimit: options.autoCompactTokenLimit,
        predictiveCompactTokenLimit: options.predictiveCompactTokenLimit,
        strategy: options.strategy || "auto",
        integrityMode: options.integrityMode,
      }
    )
    if (!candidate) return undefined

    const hookUserMessage =
      options.hookUserMessage || (await options.hookProvider?.(candidate))
    options.signal.throwIfAborted()
    const sourceMessages = this.recordsToMessages([
      ...candidate.archivedRecords,
      ...candidate.retainedRecords,
    ])
    const compactMessages = this.projectCodexMessages(state, sourceMessages, {
      maxTokens: options.maxTokens,
      systemPromptTokens: options.systemPromptTokens,
    })
    const compactResult = await options.remoteCompactProvider({
      messages: compactMessages,
      maxTokens: candidate.summaryBudget,
      candidate,
      referenceContextItem: options.referenceContextItem,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const replacementHistory = this.processRemoteReplacementHistory(
      compactResult.replacementHistory,
      options.injectionMode,
      options.referenceContextItem
    )
    if (replacementHistory.length === 0) {
      throw new Error("Codex remote compact returned empty replacement history")
    }

    const summary = this.buildReplacementSummary(replacementHistory)
    const plan = this.compaction.applyGeneratedSummaryCompaction(
      state,
      snapshot,
      candidate,
      {
        summary,
        hookUserMessage,
        meta: options.meta,
      }
    )
    const anchorRecordId =
      candidate.retainedRecords[candidate.retainedRecords.length - 1]?.id ||
      candidate.archivedRecords[candidate.archivedRecords.length - 1]?.id
    plan.commit.codexReplacementHistory = {
      compactionId: plan.commit.id,
      createdAt: Date.now(),
      injectionMode: options.injectionMode,
      anchorRecordId,
      anchorRecordCount: state.records.length,
      summary,
      items: replacementHistory,
    }

    const codex = this.ensureState(state)
    codex.historyVersion = codex.historyVersion + 1
    codex.tokenInfo = {
      totalTokens: plan.estimatedTokens,
      modelContextWindow: options.maxTokens,
      updatedAt: Date.now(),
    }
    codex.replacementHistory = plan.commit.codexReplacementHistory
    codex.referenceContextItem =
      options.injectionMode === "mid_turn"
        ? options.referenceContextItem
        : undefined
    codex.truncationPolicy = {
      ...options.referenceContextItem.truncationPolicy,
    }

    this.logger.log(
      `Codex compact applied commit=${plan.commit.id} mode=${options.injectionMode} replacementItems=${replacementHistory.length}`
    )
    return plan
  }

  async applyCollapsesIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      referenceContextItem: CodexReferenceContextItem
      remoteCompactProvider: CodexRemoteCompactProvider
      signal: AbortSignal
    }
  ): Promise<ContextCollapseCommit | undefined> {
    options.signal.throwIfAborted()
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      {
        maxTokens: options.maxTokens,
        systemPromptTokens: options.systemPromptTokens,
        autoCompactTokenLimit: options.autoCompactTokenLimit,
        predictiveCompactTokenLimit: options.predictiveCompactTokenLimit,
        strategy: options.strategy || "auto",
        integrityMode: options.integrityMode,
      }
    )
    if (!candidate) return undefined

    const sourceMessages = this.recordsToMessages([
      ...candidate.archivedRecords,
      ...candidate.retainedRecords,
    ])
    const compactMessages = this.projectCodexMessages(state, sourceMessages, {
      maxTokens: options.maxTokens,
      systemPromptTokens: options.systemPromptTokens,
    })
    const compactResult = await options.remoteCompactProvider({
      messages: compactMessages,
      maxTokens: candidate.summaryBudget,
      candidate,
      referenceContextItem: options.referenceContextItem,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const replacementHistory = this.processRemoteReplacementHistory(
      compactResult.replacementHistory,
      "pre_turn",
      options.referenceContextItem
    )
    if (replacementHistory.length === 0) {
      throw new Error(
        "Codex remote collapse returned empty replacement history"
      )
    }

    const summary = this.buildReplacementSummary(replacementHistory)
    const commit = this.contextCollapse.applyGeneratedCollapse(
      state,
      candidate,
      { summary }
    )
    this.logger.log(
      `Codex context collapse applied commit=${commit.id} replacementItems=${replacementHistory.length}`
    )
    return commit
  }

  projectCodexMessages(
    state: ContextConversationState,
    baseMessages: UnifiedMessage[],
    options: {
      maxTokens: number
      systemPromptTokens: number
      pendingToolUseIds?: Iterable<string>
    }
  ): UnifiedMessage[] {
    const codex = this.ensureState(state)
    let messages = baseMessages
    const replacement = codex.replacementHistory
    if (replacement?.items?.length) {
      const replacementMessages = this.replacementHistoryToMessages(
        replacement.items
      )
      if (replacementMessages.length > 0) {
        const postAnchor = this.recordsAfterReplacementAnchor(
          state.records,
          replacement.anchorRecordId
        )
        messages = [
          ...replacementMessages,
          ...this.recordsToMessages(postAnchor),
        ]
      }
    }

    messages = this.prepareMessagesForCodex(messages, codex.truncationPolicy)
    const hardMaxTokens = Math.max(
      256,
      options.maxTokens - options.systemPromptTokens
    )
    if (this.tokenCounter.countMessages(messages) <= hardMaxTokens) {
      return messages
    }

    const retained = this.toolIntegrity.extractWithIntegrity(
      messages,
      hardMaxTokens,
      { mode: "global" }
    )
    return this.prepareMessagesForCodex(retained, codex.truncationPolicy)
  }

  prepareMessagesForCodex(
    messages: UnifiedMessage[],
    policy: CodexTruncationPolicy = DEFAULT_CODEX_TRUNCATION_POLICY
  ): UnifiedMessage[] {
    return messages.map((message) => ({
      ...message,
      content: this.processContentForCodex(message.content, policy),
    })) as UnifiedMessage[]
  }

  private processRemoteReplacementHistory(
    items: CodexReplacementHistoryItem[],
    injectionMode: "pre_turn" | "mid_turn",
    referenceContextItem: CodexReferenceContextItem
  ): CodexReplacementHistoryItem[] {
    const filtered = items.filter((item) =>
      this.shouldKeepRemoteHistoryItem(item)
    )
    if (injectionMode !== "mid_turn") {
      return filtered
    }
    const contextItem = this.referenceContextAsMessage(referenceContextItem)
    const insertionIndex = this.findLastRealUserOrSummaryIndex(filtered)
    if (insertionIndex < 0) {
      return [...filtered, contextItem]
    }
    return [
      ...filtered.slice(0, insertionIndex),
      contextItem,
      ...filtered.slice(insertionIndex),
    ]
  }

  private shouldKeepRemoteHistoryItem(
    item: CodexReplacementHistoryItem
  ): boolean {
    if (item.type === "compaction") return true
    const role = typeof item.role === "string" ? item.role : undefined
    if (role === "developer" || role === "system") return false
    if (role === "assistant") return true
    if (role !== "user") return false
    return this.extractResponseItemText(item).trim().length > 0
  }

  private referenceContextAsMessage(
    reference: CodexReferenceContextItem
  ): CodexReplacementHistoryItem {
    const lines = [
      "Current Codex turn context:",
      reference.model ? `model: ${reference.model}` : undefined,
      reference.conversationId
        ? `conversation_id: ${reference.conversationId}`
        : undefined,
      reference.contextTokenLimit
        ? `context_window: ${reference.contextTokenLimit}`
        : undefined,
      reference.serviceTier
        ? `service_tier: ${reference.serviceTier}`
        : undefined,
      reference.systemPromptHash
        ? `system_prompt_hash: ${reference.systemPromptHash}`
        : undefined,
      reference.toolSpecHash
        ? `tool_spec_hash: ${reference.toolSpecHash}`
        : undefined,
    ].filter((line): line is string => !!line)
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: lines.join("\n") }],
    }
  }

  private findLastRealUserOrSummaryIndex(
    items: CodexReplacementHistoryItem[]
  ): number {
    let lastUserOrSummaryIndex: number | undefined
    let lastCompactionIndex: number | undefined
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!
      if (item.type === "compaction") {
        lastCompactionIndex ??= index
        continue
      }
      if (item.role !== "user") continue
      lastUserOrSummaryIndex ??= index
      if (!this.isSummaryHistoryItem(item)) {
        return index
      }
    }
    return lastUserOrSummaryIndex ?? lastCompactionIndex ?? -1
  }

  private isSummaryHistoryItem(item: CodexReplacementHistoryItem): boolean {
    return this.extractResponseItemText(item).startsWith(
      `${CODEX_SUMMARY_PREFIX}\n`
    )
  }

  private buildReplacementSummary(
    items: CodexReplacementHistoryItem[]
  ): string {
    const body =
      items
        .map((item) => this.extractResponseItemText(item))
        .filter((text) => text.trim().length > 0)
        .join("\n\n")
        .trim() || "(no summary available)"
    return `${CODEX_SUMMARY_PREFIX}\n${this.truncateTextByBytes(body, 32_000)}`
  }

  private replacementHistoryToMessages(
    items: CodexReplacementHistoryItem[]
  ): UnifiedMessage[] {
    return items.flatMap((item) => {
      if (item.type === "compaction") {
        const rawBlock: CodexRawResponseItemBlock = {
          type: CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
          item: this.cloneReplacementItem(item),
        }
        return [
          {
            role: "user",
            content: [rawBlock],
          } as unknown as UnifiedMessage,
        ]
      }
      const role = item.role === "assistant" ? "assistant" : "user"
      const text = this.extractResponseItemText(item).trim()
      if (!text) return []
      return [{ role, content: text } satisfies UnifiedMessage]
    })
  }

  private recordsAfterReplacementAnchor(
    records: readonly ContextTranscriptRecord[],
    anchorRecordId: string | undefined
  ): ContextTranscriptRecord[] {
    const sourceRecords =
      stripInternalContextEvents(records).filter(isMessageRecord)
    if (!anchorRecordId) return []
    const anchorIndex = sourceRecords.findIndex(
      (record) => record.id === anchorRecordId
    )
    if (anchorIndex < 0) return []
    return sourceRecords.slice(anchorIndex + 1)
  }

  private recordsToMessages(
    records: readonly ContextTranscriptRecord[]
  ): UnifiedMessage[] {
    return records
      .filter(
        (record) =>
          isMessageRecord(record) || isContextCollapseSummaryRecord(record)
      )
      .map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[]
  }

  private cloneReplacementItem(
    item: CodexReplacementHistoryItem
  ): CodexReplacementHistoryItem {
    return JSON.parse(JSON.stringify(item)) as CodexReplacementHistoryItem
  }

  private processContentForCodex(
    content: LooseMessageContent,
    policy: CodexTruncationPolicy
  ): LooseMessageContent {
    if (typeof content === "string") {
      return content
    }
    if (!Array.isArray(content)) {
      return content
    }

    return content.flatMap((block) => {
      if (!block || typeof block !== "object") return []
      if (block.type === "image") {
        return []
      }
      if (block.type !== "tool_result") {
        return [{ ...block }]
      }
      const nextBlock = { ...block } as Record<string, unknown>
      nextBlock.content = this.truncateToolResultContent(
        nextBlock.content,
        policy
      )
      return [nextBlock]
    }) as LooseMessageContent
  }

  private truncateToolResultContent(
    content: unknown,
    policy: CodexTruncationPolicy
  ): unknown {
    if (typeof content === "string") {
      return this.truncateTextWithMarker(content, policy)
    }
    if (!Array.isArray(content)) {
      return content
    }
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return []
      const record = { ...(part as Record<string, unknown>) }
      if (record.type === "image") return []
      if (record.type === "text" && typeof record.text === "string") {
        record.text = this.truncateTextWithMarker(record.text, policy)
      }
      return [record]
    })
  }

  private truncateTextWithMarker(
    text: string,
    policy: CodexTruncationPolicy
  ): string {
    return policy.mode === "tokens"
      ? this.truncateTextByTokens(text, policy.limit)
      : this.truncateTextByBytes(text, policy.limit)
  }

  private truncateTextByTokens(text: string, maxTokens: number): string {
    const limit = Math.max(0, Math.floor(maxTokens * 4))
    return this.truncateTextWithByteEstimate(text, limit, true)
  }

  private truncateTextByBytes(text: string, maxBytes: number): string {
    return this.truncateTextWithByteEstimate(
      text,
      Math.max(0, Math.floor(maxBytes)),
      false
    )
  }

  private truncateTextWithByteEstimate(
    text: string,
    maxBytes: number,
    useTokens: boolean
  ): string {
    if (!text) return ""
    const totalBytes = Buffer.byteLength(text, "utf8")
    const totalChars = Array.from(text).length
    if (maxBytes > 0 && totalBytes <= maxBytes) return text
    if (maxBytes === 0) {
      return this.formatTruncationMarker(
        useTokens,
        this.removedUnits(useTokens, totalBytes, totalChars)
      )
    }

    const leftBudget = Math.floor(maxBytes / 2)
    const rightBudget = maxBytes - leftBudget
    const { removedChars, prefix, suffix } = this.splitStringByUtf8Budget(
      text,
      leftBudget,
      rightBudget
    )
    const marker = this.formatTruncationMarker(
      useTokens,
      this.removedUnits(
        useTokens,
        Math.max(0, totalBytes - maxBytes),
        removedChars
      )
    )
    return `${prefix}${marker}${suffix}`
  }

  private splitStringByUtf8Budget(
    text: string,
    beginningBytes: number,
    endBytes: number
  ): { removedChars: number; prefix: string; suffix: string } {
    if (!text) return { removedChars: 0, prefix: "", suffix: "" }
    const totalBytes = Buffer.byteLength(text, "utf8")
    const tailStartTarget = Math.max(0, totalBytes - endBytes)
    let prefixEnd = 0
    let suffixStart = text.length
    let removedChars = 0
    let suffixStarted = false
    let byteOffset = 0
    let codeUnitOffset = 0

    for (const char of text) {
      const charBytes = Buffer.byteLength(char, "utf8")
      const charStart = byteOffset
      const charEnd = byteOffset + charBytes
      const nextCodeUnitOffset = codeUnitOffset + char.length
      if (charEnd <= beginningBytes) {
        prefixEnd = nextCodeUnitOffset
      } else if (charStart >= tailStartTarget) {
        if (!suffixStarted) {
          suffixStart = codeUnitOffset
          suffixStarted = true
        }
      } else {
        removedChars++
      }
      byteOffset = charEnd
      codeUnitOffset = nextCodeUnitOffset
    }

    if (suffixStart < prefixEnd) {
      suffixStart = prefixEnd
    }
    return {
      removedChars,
      prefix: text.slice(0, prefixEnd),
      suffix: text.slice(suffixStart),
    }
  }

  private formatTruncationMarker(
    useTokens: boolean,
    removedCount: number
  ): string {
    return useTokens
      ? `…${removedCount} tokens truncated…`
      : `…${removedCount} chars truncated…`
  }

  private removedUnits(
    useTokens: boolean,
    removedBytes: number,
    removedChars: number
  ): number {
    return useTokens ? Math.ceil(removedBytes / 4) : removedChars
  }

  private extractResponseItemText(item: CodexReplacementHistoryItem): string {
    const content = item.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          const record = part as Record<string, unknown>
          if (typeof record.text === "string") return record.text
          if (typeof record.output_text === "string") return record.output_text
          return ""
        })
        .filter(Boolean)
        .join("\n")
    }
    if (typeof item.summary === "string") return item.summary
    if (typeof item.message === "string") return item.message
    try {
      return extractText(content as LooseMessageContent)
    } catch {
      return ""
    }
  }

  private hashStable(value: unknown): string {
    return createHash("sha256")
      .update(this.stableStringify(value))
      .digest("hex")
      .slice(0, 16)
  }

  private stableStringify(value: unknown): string {
    return JSON.stringify(this.sortJsonValue(value))
  }

  private sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJsonValue(item))
    }
    if (!value || typeof value !== "object") {
      return value
    }
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = this.sortJsonValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }
}
