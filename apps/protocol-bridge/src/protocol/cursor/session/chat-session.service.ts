import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import { enforceToolProtocol } from "../../../context/tool-protocol-integrity"
import {
  normalizePathForBoundaryCheck,
  resolveAllowedWorkspaceRoots,
} from "./workspace-root-resolver"
import type {
  ContextCompactionCommit,
  ContextConversationState,
  CodexContextState,
  ContextInvestigationMemoryEntry,
  ContextNativeCacheEditState,
  ContextSessionMemoryEntry,
  ContextTranscriptRecord,
  ContextUsageLedgerState,
  ContextUsageSnapshot,
  InvestigationMemorySummaryLike,
  LooseMessageContent,
} from "../../../context/types"
import {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  deriveCompactionHistoryFromTranscript,
  getActiveCompactCommitFromTranscript,
  isMessageRecord,
  stripInternalContextEvents,
} from "../../../context/context-transcript-events"
import { ToolResultStorageService } from "../../../context/tool-result-storage.service"
import type { BackendType } from "../../../llm/shared/model-router.service"
import { PersistenceService } from "../../../persistence"
import { ParsedCursorRequest } from "../tools/cursor-request-parser"
import type { DeferredToolDescriptor } from "../tools/cursor-tool-mapper"
import type { EditFailureSelection } from "../tools/tool-protocol-helpers"

/**
 * Content block types for messages
 */
export type MessageContent = LooseMessageContent

export interface SessionMessage {
  role: "user" | "assistant"
  content: MessageContent
}

function sanitizeAssistantContentForStorage(content: MessageContent): {
  content: MessageContent | null
  removedThinkingBlocks: number
} {
  if (typeof content === "string") {
    return { content, removedThinkingBlocks: 0 }
  }

  if (!Array.isArray(content)) {
    return { content, removedThinkingBlocks: 0 }
  }

  const blocks = content.flatMap((block) =>
    block && typeof block === "object" ? [{ ...block }] : []
  )

  if (blocks.length === 0) {
    return { content: null, removedThinkingBlocks: 0 }
  }

  const hasNonThinkingContent = blocks.some((block) => {
    const type = block.type
    return type !== "thinking" && type !== "redacted_thinking"
  })

  let removedThinkingBlocks = 0
  const sanitized = blocks.filter((block) => {
    if (block.type === "thinking") {
      if (!hasNonThinkingContent) {
        removedThinkingBlocks++
        return false
      }

      const signature =
        typeof block.signature === "string" ? block.signature.trim() : ""
      if (!signature) {
        removedThinkingBlocks++
        return false
      }

      return true
    }

    if (block.type === "redacted_thinking" && !hasNonThinkingContent) {
      removedThinkingBlocks++
      return false
    }

    return true
  })

  if (sanitized.length === 0) {
    return { content: null, removedThinkingBlocks }
  }

  return {
    content: sanitized as MessageContent,
    removedThinkingBlocks,
  }
}

function sanitizeMessagesForStorage(messages: SessionMessage[]): {
  messages: SessionMessage[]
  removedThinkingBlocks: number
  droppedMessages: number
} {
  const sanitizedMessages: SessionMessage[] = []
  let removedThinkingBlocks = 0
  let droppedMessages = 0

  for (const message of messages) {
    if (message.role !== "assistant") {
      sanitizedMessages.push(message)
      continue
    }

    const sanitized = sanitizeAssistantContentForStorage(message.content)
    removedThinkingBlocks += sanitized.removedThinkingBlocks

    if (sanitized.content == null) {
      droppedMessages++
      continue
    }

    sanitizedMessages.push({
      ...message,
      content: sanitized.content,
    })
  }

  return {
    messages: sanitizedMessages,
    removedThinkingBlocks,
    droppedMessages,
  }
}

function buildUserMessageContent(
  text: string,
  images?: ParsedCursorRequest["attachedImages"]
): MessageContent {
  if (!images?.length) {
    return text
  }

  const blocks: Array<{ type: string; [key: string]: unknown }> = []
  if (text) {
    blocks.push({ type: "text", text })
  }
  for (const image of images) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data,
      },
    })
  }
  return blocks
}

export type SessionTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"

export interface SessionTodoItem {
  id: string
  content: string
  status: SessionTodoStatus
  createdAt: number
  updatedAt: number
  dependencies: string[]
}

export interface InterruptedToolCallInfo {
  toolCallId: string
  toolName: string
  sentAt: Date
}

export interface SessionRestartRecovery {
  restoredAt: Date
  notice: string
  interruptedToolCalls: InterruptedToolCallInfo[]
  interruptedInteractionQueryCount: number
  interruptedSubAgent?: {
    subagentId: string
    parentToolCallId: string
    turnCount: number
    toolCallCount: number
  }
}

export interface SessionActiveToolBatch {
  batchId: string
  toolCallIds: string[]
  assistantText: string
  readOnly: boolean
  startedAt: number
  tools: Array<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    resultSummary?: string
  }>
}

export interface SessionTopLevelContinuationBudget {
  continuationCount: number
  lastHistoryTokens: number
  lastDeltaTokens: number
  startedAt: number
}

export interface SessionTopLevelMutationBarrier {
  mutatingBatchCount: number
  verificationReadOnlyBatchCount: number
  lastEditedPaths: string[]
}

export interface SessionTopLevelAgentTurnState {
  llmTurnCount: number
  readOnlyBatchCount: number
  hasMutatingToolCall: boolean
  lastReadOnlyContinuationHistoryTokens?: number
  stalledReadOnlyContinuationCount: number
  continuationBudget: SessionTopLevelContinuationBudget
  mutationBarrier: SessionTopLevelMutationBarrier
  activeToolBatch?: SessionActiveToolBatch
}

export type SessionBackgroundCommandStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"

export interface SessionBackgroundCommand {
  commandId: string
  originToolCallId: string
  execIds: number[]
  command: string
  cwd: string
  pid?: number
  terminalsFolder?: string
  status: SessionBackgroundCommandStatus
  stdout: string[]
  stderr: string[]
  exitCode?: number
  msToWait?: number
  backgroundReason?: number
  lastTerminalFileLength?: number
  startedAt: number
  updatedAt: number
  completedAt?: number
}

export interface SessionReadSnapshot {
  filePath: string
  startLine?: number
  endLine?: number
  content: string
  capturedAt: number
  sourceToolName: string
  /**
   * Disk mtime (ms since epoch) of the underlying file at the moment the
   * snapshot was captured. Set when `addReadSnapshot` was able to stat the
   * absolute path on the bridge host; left undefined for paths the bridge
   * cannot stat (relative paths without resolved cwd, virtual sources,
   * stat errors).
   *
   * Used by `getLatestReadSnapshot` to detect external disk writes (e.g.
   * shell scripts overwriting a smoke fixture between two `read_file` calls
   * inside one chat session) and treat the snapshot as stale instead of
   * reusing the in-memory copy that no longer matches disk. Without this
   * guard the edit failure-projection (`latest_snapshot_source: read_file`
   * + cached `current_text`) gives the model a phantom view of the file
   * and the next edit_file_v2 round can apply on top of stale content.
   */
  diskMtimeMs?: number
  /** Disk size (bytes) at capture time; co-checked with mtime. */
  diskSizeBytes?: number
}

/**
 * 排队中的 edit_file_v2 调度记录。
 *
 * 当同一 path 上已有 holder（正在 read→write 进程中）时，后续 edit
 * 不直接派发 readArgs，而是入队等待 holder 释放槽。
 */
export interface QueuedEditDispatch {
  toolCallId: string
  path: string
  enqueuedAt: number
}

export interface EditFailureContext extends EditFailureSelection {
  filePath: string
  reason:
    | "missing_content"
    | "empty_target"
    | "range_invalid"
    | "target_not_found"
    | "ambiguous_target"
    | "unsafe_overwrite"
    | "missing_search_replace"
    | "empty_search"
    | "invalid_chunk"
    | "noop_identical"
    | "self_swallowing_replace"
  matchCountInFile?: number
}

/**
 * A workspace root that was added to the session through a non-IDE
 * channel (REST API or `.cursor/agent-vibes.json` config), used by
 * the multi-root boundary check on top of IDE-supplied
 * `projectContext.workspaceFolders`.
 *
 * Mirrors claude-code's `AdditionalWorkingDirectory` shape — same
 * fields, same semantics — so future cross-pollination is cheap.
 */
export interface AdditionalWorkspaceRoot {
  /**
   * Resolved absolute path. After `realpathSync` + macOS
   * `/private/var` normalization. Used as the dedup key in the
   * `additionalRoots` map AND as the value the boundary check
   * compares candidate paths against. Storing the resolved form
   * up-front means we don't have to re-resolve on every read_file.
   */
  path: string
  /**
   * The path the user originally typed / configured, before any
   * normalization. Surfaced in error messages ("the root you added
   * via /add-dir was: ...") so users recognize their own input.
   */
  rawPath: string
  /**
   * Where this root came from — affects who can remove it.
   *
   *  - `'session'`: added at runtime via REST API. Removable by
   *    REST DELETE.
   *  - `'config'`: loaded from `.cursor/agent-vibes.json`.
   *    Replayed every session start; runtime DELETE has no effect
   *    until the config file is edited.
   */
  source: "session" | "config"
  addedAt: number
}

/**
 * Chat session state for bidirectional streaming
 */
export interface ChatSession {
  conversationId: string
  messages: SessionMessage[]
  messageRecords: ContextTranscriptRecord[]
  contextState: ContextConversationState
  topLevelAgentTurnState: SessionTopLevelAgentTurnState
  lastEmittedContextSummaryCompactionId?: string
  lastEmittedContextSummaryCompactionEpoch?: number
  pendingContextSummaryUiUpdate?: {
    compactionId: string
    summary: string
    epoch: number
  }
  model: string
  lastAssistantBackend?: BackendType
  /** @deprecated previous_response_id 现在由 CodexService.turnSessions 管理 */
  lastCodexResponseId?: string
  /** @deprecated previous_response_id 现在由 CodexService.activeTurnContexts 管理 */
  lastCodexRequestSignature?: string
  /** @deprecated warmup payload 现在由 CodexService.warmupPayloadCache 管理 */
  lastCodexWarmupPayload?: Record<string, unknown>
  /** @deprecated previous_response_id 现在由 CodexService.activeTurnContexts 管理 */
  pendingCodexResponseId?: string
  /** @deprecated previous_response_id 现在由 CodexService.activeTurnContexts 管理 */
  pendingCodexRequestSignature?: string
  thinkingLevel: number
  thinkingDetailsRequested: boolean
  isAgentic: boolean
  supportedTools: string[]
  /**
   * Tools that the model has pulled into the core surface via the
   * bridge-internal `discover_tool` mechanism earlier in this session.
   *
   * Background: when defer-loading is enabled (see
   * `tools/tool-defer-policy.ts`), low-frequency / MCP tools are
   * trimmed out of the upstream `tools` payload and instead summarised
   * in the system prompt's `<deferred_tools>` catalog.  When the model
   * needs one of them it calls `discover_tool({ tool_name })`; the
   * bridge serves the call inline (no upstream round-trip) and records
   * the tool name here.  Subsequent turns of the same session restore
   * full schema for any name in this set so the model never needs to
   * discover the same tool twice.
   *
   * Cleared when the session is evicted by `ChatSessionManager`. Naturally
   * bounded by the number of installed tools per workspace (≤ ~80).
   */
  discoveredTools: Set<string>
  /**
   * Snapshot of the most recent deferred-tool catalog handed to the
   * upstream.  Populated by the cursor-connect-stream layer right
   * before each turn's tools array is built, and consulted by the
   * `discover_tool` handler when the model requests a schema.
   *
   * Stored on the session (rather than recomputed on every
   * `discover_tool` call) so the catalog the model "sees" is exactly
   * what we tell it about — even if MCP servers connect/disconnect
   * mid-turn we won't surprise the model with names that disappear or
   * appear from under it.  Re-snapshotted on each new agent turn.
   */
  deferredToolCatalog?: DeferredToolDescriptor[]
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  /** Browser MCP 页面状态，用于在没有页面上下文时拦截依赖页面的工具调用 */
  browserContext?: {
    hasPage: boolean
    lastToolName?: string
    lastUrl?: string
    updatedAt: number
  }
  useWeb: boolean
  requestContextEnv?: ParsedCursorRequest["requestContextEnv"]
  createdAt: Date
  lastActivityAt: Date

  // Pending tool calls waiting for results
  pendingToolCalls: Map<string, PendingToolCall>
  backgroundCommands: Map<string, SessionBackgroundCommand>
  // ExecServerMessage.id -> toolCallId mapping for control messages/tool results
  pendingToolCallByExecId: Map<number, string>
  // Identifies the current BiDi stream; used to detect orphaned tool calls from closed streams
  currentStreamId: string

  /**
   * Path-level edit serialization state (协议侧不保证跨 toolCallId 的
   * readArgs/writeArgs 串行；模型一次产生 N 个 same-path edit_file_v2 时
   * 必须由代理在调度层强制串行，否则 N 个 read_result 会基于同一原文件
   * 返回内容，N 个 writeArgs 各自全量覆盖磁盘，最后一个 write 抹掉所有
   * 前序修改）。
   *
   * editPathHolderByPath: 当前正在 read→write 进程中的 toolCallId（每条 path 至多一个）
   * editPathQueueByPath:  排队中等待派发 readArgs 的 edit 调用（FIFO，按到达顺序）
   *
   * 持有者完成后（无论 consume 成功还是 clear 异常），detach 出口统一调
   * clearEditPathSlot 释放 holder 与 queue 中的归属信息；consume 成功路径
   * 还会调 pickNextEditForPath 派发下一个 readArgs。
   */
  editPathHolderByPath: Map<string, string>
  editPathQueueByPath: Map<string, QueuedEditDispatch[]>

  // Context from initial request
  projectContext?: ParsedCursorRequest["projectContext"]
  codeChunks?: ParsedCursorRequest["codeChunks"]
  cursorRules?: ParsedCursorRequest["cursorRules"]
  selectedCursorRulePaths?: ParsedCursorRequest["selectedCursorRulePaths"]
  selectedCursorRuleNames?: ParsedCursorRequest["selectedCursorRuleNames"]
  activeCursorSkillNames?: string[]
  cursorCommands?: ParsedCursorRequest["cursorCommands"]
  customSystemPrompt?: ParsedCursorRequest["customSystemPrompt"]
  explicitContext?: string
  contextTokenLimit?: number
  contextMaxMode?: boolean
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>

  /**
   * Additional workspace roots that ARE NOT pushed by the IDE through
   * `projectContext.workspaceFolders`. They come from two non-IDE
   * channels:
   *
   *   - `'session'`: runtime extension via the bridge REST API
   *     (`POST /context/:conversationId/working-directories`). User
   *     wants the agent to access a folder that is not in the
   *     Cursor workspace — e.g. a sibling repo for cross-repo
   *     research. Persisted with the session.
   *
   *   - `'config'`: bridge startup loads from the workspace's
   *     `.cursor/agent-vibes.json` (`additionalWorkingDirectories`
   *     array). Survives across sessions; meant for
   *     project-level "always grant access to these paths" config.
   *     Replayed into every new session at creation time.
   *
   * Keyed by **resolved absolute path** (after `realpathSync` and
   * macOS `/private/var` ↔ `/var` normalization), so two different
   * relative-path entries that resolve to the same dir dedup.
   *
   * IDE-pushed folders are NOT stored here — they live on
   * `projectContext.workspaceFolders` and are refreshed on every
   * request. The boundary check (`isPathWithinAllowedRoots`) unions
   * both sources.
   */
  additionalRoots?: Map<string, AdditionalWorkspaceRoot>
  /** True once `.cursor/agent-vibes.json` roots have been replayed for this session. */
  configuredAdditionalRootsLoaded?: boolean

  // Checkpoint tracking for multi-turn conversations
  usedTokens: number
  readPaths: Set<string>
  readSnapshots: SessionReadSnapshot[]
  fileStates: Map<string, { beforeContent: string; afterContent: string }>
  toolMetrics: SessionToolMetrics

  // Message history with blobIds for checkpoint
  messageBlobIds: string[] // SHA-256 hashes from KV storage
  turns: string[] // Turn identifiers (cumulative)
  currentAssistantMessage?: Record<string, unknown> // Current assistant message being built

  // Protocol counters (session-level, monotonically increasing)
  stepId: number // StepStarted/StepCompleted counter
  execId: number // ExecServerMessage.id counter

  // InteractionQuery pending resolvers
  pendingInteractionQueries: Map<
    number,
    {
      resolve: (response: any) => void
      reject: (error: Error) => void
      queryType: string
      payload?: Record<string, unknown>
    }
  >
  interactionQueryId: number // auto-incrementing counter
  todos: SessionTodoItem[]

  // Sub-agent contexts keyed by subagentId. Multiple foreground sub-agents
  // can be active concurrently when the parent dispatches several `task`
  // tool calls in the same batch (see dispatchPreparedToolBatch). Each
  // sub-agent loop owns one entry, lifetime-managed by setSubAgentContext
  // / clearSubAgentContext(subagentId). Background sub-agents are tracked
  // separately by SubagentTaskRegistry; entries here represent only the
  // currently-suspended foreground state machines.
  subAgentContexts: Map<string, SubAgentContext>

  // Recovery notice for unrecoverable in-flight state after proxy restart
  restartRecovery?: SessionRestartRecovery

  // Exact prompt projection metadata for the in-flight request.
  pendingRequestContextLedger?: {
    promptTokenCount: number
    recordedCompactionId?: string
    attachmentFingerprint?: string
  }

  // Tracks the current assistant tool batch. Once the batch is settled, it is
  // kept until the next batch starts so exactly one tool result can claim the
  // follow-up continuation.
  activeAssistantToolBatch?: {
    id: string
    backend: BackendType
    toolCallIds: string[]
    unsettledToolCallIds: string[]
    continuationClaimed?: boolean
  }
}

export interface PendingToolCall {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  historyToolName?: string
  historyToolInput?: Record<string, unknown>
  codexToolCallType?: "function" | "custom"
  toolFamilyHint?: "mcp" | "edit" | "web_fetch"
  modelCallId: string
  startedEmitted: boolean
  sentAt: Date
  execIds: Set<number>
  editApplyWarning?: string
  editFailureContext?: EditFailureContext
  /**
   * Set when `applyEditInputToFileText` collapsed the edit to a
   * literal no-op (search === replace) rather than a real failure.
   * Result formatter reads this to emit a friendly success result
   * (`[edit applied: no-op]`) instead of `[edit_apply_failed]`. Mutex
   * with `editApplyWarning`: when noopReason is set, warning MUST be
   * undefined.
   */
  editNoopReason?: "identical_search_replace"
  beforeContent?: string // File content before edit (for edit tools)
  afterContent?: string // File content after edit (computed from applyEditInputToFileText)
  /**
   * For edit_file_v2 invocations: the resolved target file path used to
   * coordinate path-level serialization (see ChatSession.editPathHolderByPath
   * and ChatSession.editPathQueueByPath). Stored at registration time so the
   * detach path can release the path slot regardless of which exec id triggers
   * cleanup.
   */
  editPath?: string
  // Which BiDi stream this tool call was dispatched on
  streamId: string
  // Shell stream accumulation (for streaming shell output)
  shellStreamOutput?: {
    stdout: string[]
    stderr: string[]
    exitCode?: number
    signal?: string
    started: boolean
  }
  /**
   * When set, this tool call belongs to a sub-agent's LLM turn (not the
   * parent agent). The handleToolResult router uses this marker to route
   * the ExecClientMessage back to the sub-agent worker via
   * SubagentExecBridgeService instead of feeding it into the parent's
   * tool-result continuation pipeline. Value is the subagentId that owns
   * the call.
   */
  subagentOwner?: string
}

export interface SessionToolMetrics {
  completedCalls: number
  shellCalls: number
  editCalls: number
  mcpCalls: number
  otherCalls: number
  totalDurationMs: number
  lastCompletedAt: number | null
}

export interface ChatSessionAnalyticsEntry {
  conversationId: string
  loaded: boolean
  active: boolean
  model: string
  createdAt: string
  lastActivityAt: string
  idleMs: number
  pendingToolCalls: number
  completedToolCalls: number
  shellToolCalls: number
  editToolCalls: number
  mcpToolCalls: number
  otherToolCalls: number
  totalToolDurationMs: number
  avgToolDurationMs: number | null
  readFiles: number
  editedFiles: number
  linesAdded: number
  linesRemoved: number
  contextTokenLimit: number | null
  contextMaxMode: boolean | null
  usedContextTokens: number | null
  contextUsagePct: number | null
  requestedMaxOutputTokens: number | null
  subAgentTurns: number
  subAgentToolCalls: number
}

export interface ChatSessionAnalyticsSummary {
  timestamp: string
  totals: {
    totalSessions: number
    activeSessions: number
    loadedSessions: number
    persistedOnlySessions: number
    pendingToolCalls: number
    completedToolCalls: number
    totalToolDurationMs: number
    avgToolDurationMs: number | null
    readFiles: number
    editedFiles: number
    linesAdded: number
    linesRemoved: number
    lastActivityAt: string | null
  }
  sessions: ChatSessionAnalyticsEntry[]
}

/**
 * Sub-agent execution context for the task tool.
 * Stored in the parent ChatSession while a sub-agent is running.
 *
 * Event-driven state machine: the sub-agent loop is NOT a blocking loop.
 * Instead, each phase dispatches exec messages and returns. When the bidi
 * handler receives the tool results, it calls back into the sub-agent to
 * start the next LLM turn.
 */
export interface SubAgentContext {
  /** The task tool call ID in the parent */
  parentToolCallId: string
  /** For Cursor UI correlation */
  parentModelCallId: string
  /** Unique sub-agent identifier */
  subagentId: string
  /** Sub-agent conversation history (Anthropic format) */
  messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  /** LLM model for the sub-agent */
  model: string
  /** Tool definitions available to the sub-agent */
  tools: unknown[]
  /** Accumulated text from the current sub-agent turn */
  accumulatedText: string
  /** Tool call IDs that belong to this sub-agent (for routing results) */
  pendingToolCallIds: Set<string>
  /** Start time for duration tracking */
  startTime: number
  /** Number of LLM turns completed */
  turnCount: number
  /** Total tool calls made by the sub-agent */
  toolCallCount: number
  /** Modified file paths (for SubagentStopRequestQuery) */
  modifiedFiles: string[]
  /** Whether the parent task tool has been settled while the sub-agent continues in background */
  isBackground?: boolean
  /** Timestamp when the sub-agent was backgrounded */
  backgroundedAt?: number

  // ── Event-driven state machine fields ──

  /** Tool calls from the current LLM turn, pending dispatch & results */
  currentTurnToolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  /** Tool results collected so far for the current turn */
  pendingToolResults: Map<string, SubAgentToolResult>
  /** IDs of tools we are still waiting for (subset of currentTurnToolCalls) */
  expectedToolCallIds: Set<string>

  /**
   * Accumulated `agent.v1.ConversationStep` proto values produced as the
   * sub-agent runs — assistant text, thinking, tool calls. Filled into
   * `TaskSuccess.conversationSteps` when the parent task tool settles
   * so the IDE's parent task bubble can expand into the per-step detail
   * accordion. Mirrors claude-code's per-turn step tracking. Stored as
   * unknown[] because the proto type is private to cursor-grpc.service. */
  conversationSteps: unknown[]

  /**
   * Snapshot of allowed workspace roots captured when this sub-agent
   * was spawned. Used for prompt injection and restart persistence so
   * in-flight sub-agents do not silently inherit parent-session root
   * changes made after spawn.
   */
  allowedWorkspaceRoots?: string[]
}

export interface SubAgentToolResult {
  toolCallId: string
  content: string
  resultData: Buffer
  resultCase: string
}

interface PersistedPendingToolCall {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  historyToolName?: string
  historyToolInput?: Record<string, unknown>
  codexToolCallType?: "function" | "custom"
  toolFamilyHint?: "mcp" | "edit" | "web_fetch"
  modelCallId: string
  startedEmitted: boolean
  sentAt: number
  execIds: number[]
  editApplyWarning?: string
  editFailureContext?: EditFailureContext
  /** Mirror of {@link PendingToolCall.editNoopReason} for persistence. */
  editNoopReason?: "identical_search_replace"
  beforeContent?: string
  shellStreamOutput?: {
    stdout: string[]
    stderr: string[]
    exitCode?: number
    signal?: string
    started: boolean
  }
}

interface PersistedBackgroundCommand {
  commandId: string
  originToolCallId: string
  execIds: number[]
  command: string
  cwd: string
  pid?: number
  terminalsFolder?: string
  status: SessionBackgroundCommandStatus
  stdout: string[]
  stderr: string[]
  exitCode?: number
  msToWait?: number
  backgroundReason?: number
  lastTerminalFileLength?: number
  startedAt: number
  updatedAt: number
  completedAt?: number
}

interface PersistedSubAgentContext {
  parentToolCallId: string
  parentModelCallId: string
  subagentId: string
  messages: Array<{ role: "user" | "assistant"; content: MessageContent }>
  model: string
  tools: unknown[]
  accumulatedText: string
  pendingToolCallIds: string[]
  startTime: number
  turnCount: number
  toolCallCount: number
  modifiedFiles: string[]
  isBackground?: boolean
  backgroundedAt?: number
  currentTurnToolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
  }>
  expectedToolCallIds: string[]
  allowedWorkspaceRoots?: string[]
}

interface PersistedSessionRestartRecovery {
  restoredAt: number
  notice: string
  interruptedToolCalls: Array<{
    toolCallId: string
    toolName: string
    sentAt: number
  }>
  interruptedInteractionQueryCount: number
  interruptedSubAgent?: {
    subagentId: string
    parentToolCallId: string
    turnCount: number
    toolCallCount: number
  }
}

interface PersistedActiveToolBatch {
  batchId: string
  toolCallIds: string[]
  assistantText: string
  readOnly: boolean
  startedAt: number
  tools: Array<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    resultSummary?: string
  }>
}

interface PersistedTopLevelAgentTurnState {
  llmTurnCount: number
  readOnlyBatchCount: number
  hasMutatingToolCall: boolean
  lastReadOnlyContinuationHistoryTokens?: number
  stalledReadOnlyContinuationCount: number
  continuationBudget?: SessionTopLevelContinuationBudget
  mutationBarrier?: SessionTopLevelMutationBarrier
  activeToolBatch?: PersistedActiveToolBatch
}

interface PersistedChatSessionV1 {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
  conversationId: string
  messages: SessionMessage[]
  messageRecords?: ContextTranscriptRecord[]
  contextState?: ContextConversationState
  topLevelAgentTurnState?: PersistedTopLevelAgentTurnState
  lastEmittedContextSummaryCompactionId?: string
  lastEmittedContextSummaryCompactionEpoch?: number
  lastContextSummaryCompactionEpoch?: number
  model: string
  lastAssistantBackend?: BackendType
  lastCodexResponseId?: string
  lastCodexRequestSignature?: string
  thinkingLevel: number
  thinkingDetailsRequested?: boolean
  isAgentic: boolean
  supportedTools: string[]
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  useWeb: boolean
  requestContextEnv?: ParsedCursorRequest["requestContextEnv"]
  createdAt: number
  lastActivityAt: number
  pendingToolCalls: PersistedPendingToolCall[]
  backgroundCommands?: PersistedBackgroundCommand[]
  pendingInteractionQueryCount: number
  projectContext?: ParsedCursorRequest["projectContext"]
  codeChunks?: ParsedCursorRequest["codeChunks"]
  // Legacy only: request-scoped rules used to be persisted, but are now
  // intentionally ignored on restore.
  cursorRules?: ParsedCursorRequest["cursorRules"] | string[]
  cursorCommands?: ParsedCursorRequest["cursorCommands"]
  customSystemPrompt?: ParsedCursorRequest["customSystemPrompt"]
  explicitContext?: string
  contextTokenLimit?: number
  contextMaxMode?: boolean
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>
  /**
   * Persisted form of `ChatSession.additionalRoots`. Stored as an
   * array (Map doesn't round-trip through JSON) and rebuilt into a
   * Map on load. Only `'session'` source entries actually survive
   * the round-trip — `'config'` entries are re-derived from
   * `.cursor/agent-vibes.json` at session start, so persisting them
   * would cause stale config to silently linger after the file is
   * edited.
   */
  additionalRoots?: AdditionalWorkspaceRoot[]
  usedTokens: number
  readPaths: string[]
  readSnapshots?: SessionReadSnapshot[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  toolMetrics?: SessionToolMetrics
  messageBlobIds: string[]
  turns: string[]
  currentAssistantMessage?: Record<string, unknown>
  stepId: number
  execId: number
  interactionQueryId: number
  todos: SessionTodoItem[]
  /**
   * @deprecated since 2026-05 — single-context schema. Read-only for
   * backwards-compatible deserialization of pre-multi-subagent session
   * snapshots. New writes use {@link subAgentContexts}.
   */
  subAgentContext?: PersistedSubAgentContext
  /**
   * Multi-subagent persistence schema. Each entry is one foreground
   * sub-agent that was active at the time of the snapshot. The bridge
   * does not currently restart sub-agent state machines on cold start
   * (cf. `deserializeSession` — restart recovery only marks them as
   * interrupted), so this is consumed exclusively by the recovery
   * synthesis path.
   */
  subAgentContexts?: PersistedSubAgentContext[]
  restartRecovery?: PersistedSessionRestartRecovery
}

@Injectable()
export class ChatSessionManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatSessionManager.name)
  private readonly sessions = new Map<string, ChatSession>()
  private readonly ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000 // 30 minutes
  private readonly PERSISTED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
  private readonly PERSIST_FLUSH_INTERVAL_MS = 15 * 1000
  private readonly PERSIST_DEBOUNCE_MS = 250
  private readonly MAX_READ_SNAPSHOTS_PER_SESSION = 24
  private readonly MAX_READ_SNAPSHOTS_PER_FILE = 6
  private readonly MAX_READ_SNAPSHOT_CHARS = 80_000
  private readonly scheduledPersistTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private cleanupInterval!: ReturnType<typeof setInterval>
  private persistFlushInterval!: ReturnType<typeof setInterval>

  /**
   * Optional cleanup callback fired when a session is removed.
   * The orchestration layer registers this to call ProviderAdapter.dispose(),
   * releasing provider-specific resources (e.g., Codex WebSocket connections).
   */
  private onSessionCleanupHandler?: (
    conversationId: string,
    session: ChatSession
  ) => void

  constructor(
    private readonly persistence: PersistenceService,
    private readonly toolResultStorage: ToolResultStorageService
  ) {}

  onModuleInit(): void {
    this.cleanupOldPersistedSessions()

    this.cleanupInterval = setInterval(
      () => this.cleanupExpiredSessions(),
      5 * 60 * 1000
    )
    this.persistFlushInterval = setInterval(
      () => this.persistAllSessions(),
      this.PERSIST_FLUSH_INTERVAL_MS
    )
    this.cleanupInterval.unref?.()
    this.persistFlushInterval.unref?.()
  }

  /**
   * Register a callback to be invoked when a session is removed (expired or deleted).
   * Used by the orchestration layer to release provider-specific resources
   * (e.g., ProviderAdapter.dispose() for Codex WebSocket connections).
   */
  registerSessionCleanupHandler(
    handler: (conversationId: string, session: ChatSession) => void
  ): void {
    this.onSessionCleanupHandler = handler
  }

  onModuleDestroy(): void {
    this.persistAllSessions()

    for (const timer of this.scheduledPersistTimers.values()) {
      clearTimeout(timer)
    }
    this.scheduledPersistTimers.clear()

    clearInterval(this.cleanupInterval)
    clearInterval(this.persistFlushInterval)
    // PersistenceService handles DB cleanup
  }

  private cleanupOldPersistedSessions(): void {
    if (!this.persistence.isReady) return
    const cutoff = Date.now() - this.PERSISTED_SESSION_TTL_MS
    try {
      const expiredRows = this.persistence
        .prepare(
          `SELECT conversation_id
             FROM cursor_sessions
            WHERE last_activity_at < ?`
        )
        .all(cutoff) as Array<{ conversation_id: string }>
      const result = this.persistence
        .prepare(`DELETE FROM cursor_sessions WHERE last_activity_at < ?`)
        .run(cutoff)
      if (result.changes > 0) {
        for (const row of expiredRows) {
          this.deleteToolResultStorage(row.conversation_id)
        }
        this.logger.log(
          `Cleaned up ${result.changes} expired persisted session(s)`
        )
      }
    } catch (error) {
      this.logger.error(
        `Failed to cleanup persisted sessions: ${String(error)}`
      )
    }
  }

  private schedulePersist(conversationId: string): void {
    const existingTimer = this.scheduledPersistTimers.get(conversationId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.scheduledPersistTimers.delete(conversationId)
      this.persistSession(conversationId)
    }, this.PERSIST_DEBOUNCE_MS)
    timer.unref?.()
    this.scheduledPersistTimers.set(conversationId, timer)
  }

  private clearScheduledPersist(conversationId: string): void {
    const timer = this.scheduledPersistTimers.get(conversationId)
    if (!timer) return
    clearTimeout(timer)
    this.scheduledPersistTimers.delete(conversationId)
  }

  private persistAllSessions(): void {
    for (const conversationId of this.sessions.keys()) {
      this.persistSession(conversationId)
    }
    this.cleanupOldPersistedSessions()
  }

  persistSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return

    const now = Date.now()
    const state = this.serializeSession(session)

    try {
      this.persistence
        .prepare(
          `INSERT INTO cursor_sessions (
             conversation_id,
             state_json,
             created_at,
             updated_at,
             last_activity_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             state_json = excluded.state_json,
             updated_at = excluded.updated_at,
             last_activity_at = excluded.last_activity_at`
        )
        .run(
          conversationId,
          JSON.stringify(state),
          session.createdAt.getTime(),
          now,
          session.lastActivityAt.getTime()
        )
    } catch (error) {
      this.logger.error(
        `Failed to persist session ${conversationId}: ${String(error)}`
      )
    }
  }

  private loadPersistedSession(
    conversationId: string
  ): ChatSession | undefined {
    try {
      const row = this.persistence
        .prepare(
          `SELECT state_json, last_activity_at
           FROM cursor_sessions
           WHERE conversation_id = ?`
        )
        .get(conversationId) as
        | { state_json: string; last_activity_at: number }
        | undefined

      if (!row) return undefined

      if (Date.now() - row.last_activity_at > this.PERSISTED_SESSION_TTL_MS) {
        this.deletePersistedSession(conversationId)
        this.deleteToolResultStorage(conversationId)
        return undefined
      }

      const persisted = JSON.parse(row.state_json) as PersistedChatSessionV1
      const session = this.deserializeSession(persisted)
      this.sessions.set(conversationId, session)
      this.logger.log(
        `>>> Restored persisted session: ${conversationId} ` +
          `(messages=${session.messages.length}, records=${session.messageRecords.length}, turns=${session.turns.length}, pending=${session.pendingToolCalls.size})`
      )
      this.schedulePersist(conversationId)
      return session
    } catch (error) {
      this.logger.error(
        `Failed to load persisted session ${conversationId}: ${String(error)}`
      )
      return undefined
    }
  }

  private deletePersistedSession(conversationId: string): void {
    try {
      this.persistence
        .prepare(`DELETE FROM cursor_sessions WHERE conversation_id = ?`)
        .run(conversationId)
    } catch (error) {
      this.logger.error(
        `Failed to delete persisted session ${conversationId}: ${String(error)}`
      )
    }
  }

  private deleteToolResultStorage(conversationId: string): void {
    try {
      this.toolResultStorage.deleteConversation(conversationId)
    } catch (error) {
      this.logger.warn(
        `Failed to delete stored tool results for ${conversationId}: ${String(error)}`
      )
    }
  }

  private toTimestamp(
    value: Date | number | undefined,
    fallback: number = Date.now()
  ): number {
    if (value instanceof Date) {
      const ms = value.getTime()
      return Number.isFinite(ms) ? ms : fallback
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
    return fallback
  }

  private createEmptyToolMetrics(): SessionToolMetrics {
    return {
      completedCalls: 0,
      shellCalls: 0,
      editCalls: 0,
      mcpCalls: 0,
      otherCalls: 0,
      totalDurationMs: 0,
      lastCompletedAt: null,
    }
  }

  private createEmptyTopLevelAgentTurnState(): SessionTopLevelAgentTurnState {
    return {
      llmTurnCount: 1,
      readOnlyBatchCount: 0,
      hasMutatingToolCall: false,
      stalledReadOnlyContinuationCount: 0,
      continuationBudget: {
        continuationCount: 0,
        lastHistoryTokens: 0,
        lastDeltaTokens: 0,
        startedAt: Date.now(),
      },
      mutationBarrier: {
        mutatingBatchCount: 0,
        verificationReadOnlyBatchCount: 0,
        lastEditedPaths: [],
      },
    }
  }

  private toNonNegativeInt(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0
  }

  private normalizeToolMetrics(value: unknown): SessionToolMetrics {
    const metrics =
      value && typeof value === "object"
        ? (value as Partial<SessionToolMetrics>)
        : {}
    return {
      completedCalls: this.toNonNegativeInt(metrics.completedCalls),
      shellCalls: this.toNonNegativeInt(metrics.shellCalls),
      editCalls: this.toNonNegativeInt(metrics.editCalls),
      mcpCalls: this.toNonNegativeInt(metrics.mcpCalls),
      otherCalls: this.toNonNegativeInt(metrics.otherCalls),
      totalDurationMs: this.toNonNegativeInt(metrics.totalDurationMs),
      lastCompletedAt:
        typeof metrics.lastCompletedAt === "number" &&
        Number.isFinite(metrics.lastCompletedAt)
          ? Math.max(0, Math.round(metrics.lastCompletedAt))
          : null,
    }
  }

  private classifyToolCall(
    toolCall: Pick<PendingToolCall, "toolName" | "toolFamilyHint">
  ): "shell" | "edit" | "mcp" | "other" {
    const toolName = toolCall.toolName.toLowerCase()
    if (
      toolCall.toolFamilyHint === "edit" ||
      toolName === "edit_file_v2" ||
      toolName === "edit"
    ) {
      return "edit"
    }
    if (toolCall.toolFamilyHint === "mcp") {
      return "mcp"
    }
    if (
      toolName.includes("run_terminal_command") ||
      toolName.includes("write_shell_stdin")
    ) {
      return "shell"
    }
    return "other"
  }

  private toDiffLines(content: string): string[] {
    if (!content) return []
    const lines = content.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop()
    }
    return lines
  }

  private countLineDelta(
    beforeContent: string,
    afterContent: string
  ): { linesAdded: number; linesRemoved: number } {
    const beforeLines = this.toDiffLines(beforeContent)
    const afterLines = this.toDiffLines(afterContent)

    let prefix = 0
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix++
    }

    let beforeEnd = beforeLines.length - 1
    let afterEnd = afterLines.length - 1
    while (
      beforeEnd >= prefix &&
      afterEnd >= prefix &&
      beforeLines[beforeEnd] === afterLines[afterEnd]
    ) {
      beforeEnd--
      afterEnd--
    }

    const beforeRemaining = beforeLines.slice(prefix, beforeEnd + 1)
    const afterRemaining = afterLines.slice(prefix, afterEnd + 1)

    if (beforeRemaining.length === 0 || afterRemaining.length === 0) {
      return {
        linesAdded: afterRemaining.length,
        linesRemoved: beforeRemaining.length,
      }
    }

    const maxCells = 1_000_000
    if (beforeRemaining.length * afterRemaining.length > maxCells) {
      return {
        linesAdded: afterRemaining.length,
        linesRemoved: beforeRemaining.length,
      }
    }

    let previous: number[] = new Array<number>(afterRemaining.length + 1).fill(
      0
    )
    for (const beforeLine of beforeRemaining) {
      const current: number[] = new Array<number>(
        afterRemaining.length + 1
      ).fill(0)
      for (let index = 1; index <= afterRemaining.length; index++) {
        current[index] =
          beforeLine === afterRemaining[index - 1]
            ? (previous[index - 1] ?? 0) + 1
            : Math.max(previous[index] ?? 0, current[index - 1] ?? 0)
      }
      previous = current
    }

    const lcsLength: number = previous[afterRemaining.length] ?? 0
    return {
      linesAdded: afterRemaining.length - lcsLength,
      linesRemoved: beforeRemaining.length - lcsLength,
    }
  }

  private getSessionLineChangeStats(session: ChatSession): {
    linesAdded: number
    linesRemoved: number
  } {
    let linesAdded = 0
    let linesRemoved = 0

    for (const state of session.fileStates.values()) {
      const delta = this.countLineDelta(state.beforeContent, state.afterContent)
      linesAdded += delta.linesAdded
      linesRemoved += delta.linesRemoved
    }

    return { linesAdded, linesRemoved }
  }

  private buildAnalyticsEntry(
    conversationId: string,
    session: ChatSession,
    loaded: boolean,
    now: number
  ): ChatSessionAnalyticsEntry {
    const lineStats = this.getSessionLineChangeStats(session)
    const idleMs = Math.max(0, now - session.lastActivityAt.getTime())
    const contextTokenLimit =
      typeof session.contextTokenLimit === "number" &&
      Number.isFinite(session.contextTokenLimit)
        ? Math.max(0, Math.round(session.contextTokenLimit))
        : null
    const usedContextTokens =
      typeof session.usedContextTokens === "number" &&
      Number.isFinite(session.usedContextTokens)
        ? Math.max(0, Math.round(session.usedContextTokens))
        : null
    const requestedMaxOutputTokens =
      typeof session.requestedMaxOutputTokens === "number" &&
      Number.isFinite(session.requestedMaxOutputTokens)
        ? Math.max(0, Math.round(session.requestedMaxOutputTokens))
        : null
    const contextMaxMode =
      typeof session.contextMaxMode === "boolean"
        ? session.contextMaxMode
        : null
    const contextUsagePct =
      contextTokenLimit && usedContextTokens != null && contextTokenLimit > 0
        ? Math.round((usedContextTokens / contextTokenLimit) * 1000) / 10
        : null

    return {
      conversationId,
      loaded,
      active: idleMs < this.ACTIVE_SESSION_WINDOW_MS,
      model: session.model || "(unknown)",
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      idleMs,
      pendingToolCalls: session.pendingToolCalls.size,
      completedToolCalls: session.toolMetrics.completedCalls,
      shellToolCalls: session.toolMetrics.shellCalls,
      editToolCalls: session.toolMetrics.editCalls,
      mcpToolCalls: session.toolMetrics.mcpCalls,
      otherToolCalls: session.toolMetrics.otherCalls,
      totalToolDurationMs: session.toolMetrics.totalDurationMs,
      avgToolDurationMs:
        session.toolMetrics.completedCalls > 0
          ? Math.round(
              (session.toolMetrics.totalDurationMs /
                session.toolMetrics.completedCalls) *
                10
            ) / 10
          : null,
      readFiles: session.readPaths.size,
      editedFiles: session.fileStates.size,
      linesAdded: lineStats.linesAdded,
      linesRemoved: lineStats.linesRemoved,
      contextTokenLimit,
      contextMaxMode,
      usedContextTokens,
      contextUsagePct,
      requestedMaxOutputTokens,
      subAgentTurns: this.sumSubAgentMetric(session, "turnCount"),
      subAgentToolCalls: this.sumSubAgentMetric(session, "toolCallCount"),
    }
  }

  private serializeSession(session: ChatSession): PersistedChatSessionV1 {
    return {
      version: 13,
      conversationId: session.conversationId,
      messages: session.messages,
      messageRecords: session.messageRecords,
      contextState: {
        ...session.contextState,
        compactionHistory: deriveCompactionHistoryFromTranscript(
          session.contextState.records
        ),
        activeCompactionId: getActiveCompactCommitFromTranscript(
          session.contextState.records
        )?.id,
        nativeCacheEditState: {
          toolOrder: [],
          deletedToolUseIds: [],
          pinnedEdits: [],
          toolsSentToApi: false,
        },
      },
      topLevelAgentTurnState: {
        llmTurnCount: session.topLevelAgentTurnState.llmTurnCount,
        readOnlyBatchCount: session.topLevelAgentTurnState.readOnlyBatchCount,
        hasMutatingToolCall: session.topLevelAgentTurnState.hasMutatingToolCall,
        lastReadOnlyContinuationHistoryTokens:
          session.topLevelAgentTurnState.lastReadOnlyContinuationHistoryTokens,
        stalledReadOnlyContinuationCount:
          session.topLevelAgentTurnState.stalledReadOnlyContinuationCount,
        continuationBudget: {
          continuationCount:
            session.topLevelAgentTurnState.continuationBudget.continuationCount,
          lastHistoryTokens:
            session.topLevelAgentTurnState.continuationBudget.lastHistoryTokens,
          lastDeltaTokens:
            session.topLevelAgentTurnState.continuationBudget.lastDeltaTokens,
          startedAt:
            session.topLevelAgentTurnState.continuationBudget.startedAt,
        },
        mutationBarrier: {
          mutatingBatchCount:
            session.topLevelAgentTurnState.mutationBarrier.mutatingBatchCount,
          verificationReadOnlyBatchCount:
            session.topLevelAgentTurnState.mutationBarrier
              .verificationReadOnlyBatchCount,
          lastEditedPaths: [
            ...session.topLevelAgentTurnState.mutationBarrier.lastEditedPaths,
          ],
        },
        activeToolBatch: session.topLevelAgentTurnState.activeToolBatch
          ? {
              batchId: session.topLevelAgentTurnState.activeToolBatch.batchId,
              toolCallIds: [
                ...session.topLevelAgentTurnState.activeToolBatch.toolCallIds,
              ],
              assistantText:
                session.topLevelAgentTurnState.activeToolBatch.assistantText,
              readOnly: session.topLevelAgentTurnState.activeToolBatch.readOnly,
              startedAt:
                session.topLevelAgentTurnState.activeToolBatch.startedAt,
              tools: session.topLevelAgentTurnState.activeToolBatch.tools.map(
                (tool) => ({
                  toolCallId: tool.toolCallId,
                  toolName: tool.toolName,
                  input: tool.input,
                  resultSummary: tool.resultSummary,
                })
              ),
            }
          : undefined,
      },
      lastEmittedContextSummaryCompactionId:
        session.lastEmittedContextSummaryCompactionId,
      lastEmittedContextSummaryCompactionEpoch:
        session.lastEmittedContextSummaryCompactionEpoch,
      lastContextSummaryCompactionEpoch:
        session.pendingContextSummaryUiUpdate?.epoch ??
        session.contextState.compactionEpoch,
      model: session.model,
      lastAssistantBackend: session.lastAssistantBackend,
      lastCodexResponseId: session.lastCodexResponseId,
      lastCodexRequestSignature: session.lastCodexRequestSignature,
      thinkingLevel: session.thinkingLevel,
      thinkingDetailsRequested: session.thinkingDetailsRequested,
      isAgentic: session.isAgentic,
      supportedTools: session.supportedTools,
      mcpToolDefs: session.mcpToolDefs,
      useWeb: session.useWeb,
      requestContextEnv: session.requestContextEnv,
      createdAt: this.toTimestamp(session.createdAt),
      lastActivityAt: this.toTimestamp(session.lastActivityAt),
      pendingToolCalls: Array.from(session.pendingToolCalls.values()).map(
        (toolCall) => ({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          toolInput: toolCall.toolInput,
          historyToolName: toolCall.historyToolName,
          historyToolInput: toolCall.historyToolInput,
          codexToolCallType: toolCall.codexToolCallType,
          toolFamilyHint: toolCall.toolFamilyHint,
          modelCallId: toolCall.modelCallId,
          startedEmitted: toolCall.startedEmitted,
          sentAt: this.toTimestamp(toolCall.sentAt),
          execIds: Array.from(toolCall.execIds),
          editApplyWarning: toolCall.editApplyWarning,
          editFailureContext: toolCall.editFailureContext,
          editNoopReason: toolCall.editNoopReason,
          beforeContent: toolCall.beforeContent,
          shellStreamOutput: toolCall.shellStreamOutput
            ? {
                stdout: [...toolCall.shellStreamOutput.stdout],
                stderr: [...toolCall.shellStreamOutput.stderr],
                exitCode: toolCall.shellStreamOutput.exitCode,
                signal: toolCall.shellStreamOutput.signal,
                started: toolCall.shellStreamOutput.started,
              }
            : undefined,
        })
      ),
      backgroundCommands: Array.from(session.backgroundCommands.values()).map(
        (command) => ({
          commandId: command.commandId,
          originToolCallId: command.originToolCallId,
          execIds: [...command.execIds],
          command: command.command,
          cwd: command.cwd,
          pid: command.pid,
          terminalsFolder: command.terminalsFolder,
          status: command.status,
          stdout: [...command.stdout],
          stderr: [...command.stderr],
          exitCode: command.exitCode,
          msToWait: command.msToWait,
          backgroundReason: command.backgroundReason,
          lastTerminalFileLength: command.lastTerminalFileLength,
          startedAt: command.startedAt,
          updatedAt: command.updatedAt,
          completedAt: command.completedAt,
        })
      ),
      pendingInteractionQueryCount: session.pendingInteractionQueries.size,
      projectContext: session.projectContext,
      codeChunks: session.codeChunks,
      cursorCommands: session.cursorCommands,
      customSystemPrompt: session.customSystemPrompt,
      explicitContext: session.explicitContext,
      contextTokenLimit: session.contextTokenLimit,
      contextMaxMode: session.contextMaxMode,
      usedContextTokens: session.usedContextTokens,
      requestedMaxOutputTokens: session.requestedMaxOutputTokens,
      requestedModelParameters: session.requestedModelParameters,
      usedTokens: session.usedTokens,
      // Persist only `source='session'` additionalRoots — `'config'`
      // entries get replayed from `.cursor/agent-vibes.json` on load
      // so we don't want stale snapshots overriding fresh config.
      additionalRoots: session.additionalRoots
        ? Array.from(session.additionalRoots.values()).filter(
            (r) => r.source === "session"
          )
        : undefined,
      readPaths: Array.from(session.readPaths),
      readSnapshots: session.readSnapshots.map((snapshot) => ({ ...snapshot })),
      fileStates: Array.from(session.fileStates.entries()).map(
        ([filePath, state]) => ({
          path: filePath,
          beforeContent: state.beforeContent,
          afterContent: state.afterContent,
        })
      ),
      toolMetrics: { ...session.toolMetrics },
      messageBlobIds: [...session.messageBlobIds],
      turns: [...session.turns],
      currentAssistantMessage: session.currentAssistantMessage,
      stepId: session.stepId,
      execId: session.execId,
      interactionQueryId: session.interactionQueryId,
      todos: [...session.todos],
      subAgentContexts:
        session.subAgentContexts.size > 0
          ? Array.from(session.subAgentContexts.values()).map((ctx) =>
              this.persistSubAgentContext(ctx)
            )
          : undefined,
      restartRecovery: session.restartRecovery
        ? {
            restoredAt: this.toTimestamp(session.restartRecovery.restoredAt),
            notice: session.restartRecovery.notice,
            interruptedToolCalls:
              session.restartRecovery.interruptedToolCalls.map((toolCall) => ({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                sentAt: this.toTimestamp(toolCall.sentAt),
              })),
            interruptedInteractionQueryCount:
              session.restartRecovery.interruptedInteractionQueryCount,
            interruptedSubAgent: session.restartRecovery.interruptedSubAgent,
          }
        : undefined,
    }
  }

  private buildRestartRecovery(
    persisted: PersistedChatSessionV1
  ): SessionRestartRecovery | undefined {
    const pendingInterruptedToolCalls = Array.isArray(
      persisted.pendingToolCalls
    )
      ? persisted.pendingToolCalls.map((toolCall) => ({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          sentAt: new Date(this.toTimestamp(toolCall.sentAt)),
        }))
      : []
    const pendingInteractionQueryCount =
      typeof persisted.pendingInteractionQueryCount === "number" &&
      persisted.pendingInteractionQueryCount > 0
        ? persisted.pendingInteractionQueryCount
        : 0

    if (persisted.restartRecovery) {
      const interruptedToolCalls =
        persisted.restartRecovery.interruptedToolCalls.map((toolCall) => ({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          sentAt: new Date(this.toTimestamp(toolCall.sentAt)),
        }))
      const knownInterruptedIds = new Set(
        interruptedToolCalls.map((toolCall) => toolCall.toolCallId)
      )
      for (const pendingToolCall of pendingInterruptedToolCalls) {
        if (knownInterruptedIds.has(pendingToolCall.toolCallId)) continue
        interruptedToolCalls.push(pendingToolCall)
      }

      let notice = persisted.restartRecovery.notice
      if (pendingInterruptedToolCalls.length > 0) {
        const sampleNames = pendingInterruptedToolCalls
          .slice(0, 3)
          .map((toolCall) => toolCall.toolName || toolCall.toolCallId)
        notice +=
          `\nPending tool calls from the last saved stream were also interrupted: ` +
          sampleNames.join(", ")
        if (pendingInterruptedToolCalls.length > sampleNames.length) {
          notice += `, +${pendingInterruptedToolCalls.length - sampleNames.length} more`
        }
      }

      return {
        restoredAt: new Date(
          this.toTimestamp(persisted.restartRecovery.restoredAt)
        ),
        notice,
        interruptedToolCalls,
        interruptedInteractionQueryCount:
          persisted.restartRecovery.interruptedInteractionQueryCount +
          pendingInteractionQueryCount,
        interruptedSubAgent: persisted.restartRecovery.interruptedSubAgent,
      }
    }

    const interruptedToolCalls = pendingInterruptedToolCalls
    const interruptedInteractionQueryCount = pendingInteractionQueryCount
    // Pick a representative interrupted sub-agent for the recovery
    // notice. New persistence schema uses `subAgentContexts: []` (one
    // entry per concurrent foreground sub-agent); legacy snapshots used
    // singular `subAgentContext`. We accept both and surface the first
    // foreground (non-background) entry — that's the one most likely to
    // have user-visible work in flight at restart time.
    const interruptedSubAgentSource: PersistedSubAgentContext | undefined =
      (Array.isArray(persisted.subAgentContexts) &&
        persisted.subAgentContexts.find((entry) => !entry.isBackground)) ||
      (Array.isArray(persisted.subAgentContexts)
        ? persisted.subAgentContexts[0]
        : undefined) ||
      persisted.subAgentContext

    const interruptedSubAgent = interruptedSubAgentSource
      ? {
          subagentId: interruptedSubAgentSource.subagentId,
          parentToolCallId: interruptedSubAgentSource.parentToolCallId,
          turnCount: interruptedSubAgentSource.turnCount,
          toolCallCount: interruptedSubAgentSource.toolCallCount,
        }
      : undefined

    if (
      interruptedToolCalls.length === 0 &&
      interruptedInteractionQueryCount === 0 &&
      !interruptedSubAgent
    ) {
      return undefined
    }

    const details: string[] = []
    if (interruptedToolCalls.length > 0) {
      const sampleNames = interruptedToolCalls
        .slice(0, 3)
        .map((toolCall) => toolCall.toolName || toolCall.toolCallId)
      let toolSummary = `${interruptedToolCalls.length} pending tool call(s) were aborted`
      if (sampleNames.length > 0) {
        toolSummary += ` (${sampleNames.join(", ")}`
        if (interruptedToolCalls.length > sampleNames.length) {
          toolSummary += `, +${interruptedToolCalls.length - sampleNames.length} more`
        }
        toolSummary += `)`
      }
      details.push(toolSummary)
    }
    if (interruptedInteractionQueryCount > 0) {
      details.push(
        `${interruptedInteractionQueryCount} pending interaction quer${
          interruptedInteractionQueryCount === 1 ? "y was" : "ies were"
        } dropped`
      )
    }
    if (interruptedSubAgent) {
      details.push(
        `sub-agent ${interruptedSubAgent.subagentId} was interrupted`
      )
    }

    return {
      restoredAt: new Date(),
      notice:
        `Proxy restarted before the previous turn finished. ${details.join("; ")}.` +
        ` Please retry the interrupted action if needed.`,
      interruptedToolCalls,
      interruptedInteractionQueryCount,
      interruptedSubAgent,
    }
  }

  private createTranscriptRecord(
    message: SessionMessage,
    createdAt: number = Date.now()
  ): ContextTranscriptRecord {
    return {
      id: crypto.randomUUID(),
      role: message.role,
      kind: "message",
      content: message.content,
      createdAt,
    }
  }

  private createContextState(
    records: ContextTranscriptRecord[]
  ): ContextConversationState {
    return {
      records: [...records],
      compactionHistory: [],
      activeCompactionId: undefined,
      compactionEpoch: 0,
      lastAppliedCompaction: undefined,
      usageLedger: {},
      codexContext: this.createCodexContextState(),
      toolResultReplacementState: {
        seenToolUseIds: [],
        replacementByToolUseId: {},
        storedByToolUseId: {},
        records: [],
      },
      nativeCacheEditState: {
        toolOrder: [],
        deletedToolUseIds: [],
        pinnedEdits: [],
        toolsSentToApi: false,
      },
      investigationMemory: [],
      sessionMemory: [],
    }
  }

  private createCodexContextState(): CodexContextState {
    return {
      historyVersion: 0,
      truncationPolicy: {
        mode: "bytes",
        limit: 10_000,
      },
    }
  }

  private normalizeCodexContextState(value: unknown): CodexContextState {
    const input =
      value && typeof value === "object"
        ? (value as Partial<CodexContextState>)
        : {}
    const truncationPolicy =
      input.truncationPolicy &&
      typeof input.truncationPolicy === "object" &&
      (input.truncationPolicy.mode === "bytes" ||
        input.truncationPolicy.mode === "tokens") &&
      typeof input.truncationPolicy.limit === "number" &&
      Number.isFinite(input.truncationPolicy.limit) &&
      input.truncationPolicy.limit > 0
        ? {
            mode: input.truncationPolicy.mode,
            limit: Math.floor(input.truncationPolicy.limit),
          }
        : {
            mode: "bytes" as const,
            limit: 10_000,
          }
    return {
      historyVersion:
        typeof input.historyVersion === "number" && input.historyVersion >= 0
          ? Math.floor(input.historyVersion)
          : 0,
      tokenInfo:
        input.tokenInfo &&
        typeof input.tokenInfo === "object" &&
        typeof input.tokenInfo.totalTokens === "number"
          ? {
              totalTokens: Math.max(0, Math.floor(input.tokenInfo.totalTokens)),
              modelContextWindow:
                typeof input.tokenInfo.modelContextWindow === "number"
                  ? Math.max(0, Math.floor(input.tokenInfo.modelContextWindow))
                  : undefined,
              updatedAt:
                typeof input.tokenInfo.updatedAt === "number"
                  ? input.tokenInfo.updatedAt
                  : Date.now(),
            }
          : undefined,
      referenceContextItem:
        input.referenceContextItem &&
        typeof input.referenceContextItem === "object"
          ? {
              ...input.referenceContextItem,
              truncationPolicy,
              updatedAt:
                typeof input.referenceContextItem.updatedAt === "number"
                  ? input.referenceContextItem.updatedAt
                  : Date.now(),
            }
          : undefined,
      replacementHistory:
        input.replacementHistory &&
        typeof input.replacementHistory === "object" &&
        typeof input.replacementHistory.compactionId === "string" &&
        Array.isArray(input.replacementHistory.items)
          ? {
              ...input.replacementHistory,
              anchorRecordCount:
                typeof input.replacementHistory.anchorRecordCount === "number"
                  ? Math.max(
                      0,
                      Math.floor(input.replacementHistory.anchorRecordCount)
                    )
                  : 0,
              createdAt:
                typeof input.replacementHistory.createdAt === "number"
                  ? input.replacementHistory.createdAt
                  : Date.now(),
              injectionMode:
                input.replacementHistory.injectionMode === "mid_turn"
                  ? "mid_turn"
                  : "pre_turn",
              summary:
                typeof input.replacementHistory.summary === "string"
                  ? input.replacementHistory.summary
                  : "",
              items: input.replacementHistory.items.flatMap((item) =>
                item && typeof item === "object" ? [{ ...item }] : []
              ),
            }
          : undefined,
      truncationPolicy,
    }
  }

  private normalizeInvestigationMemoryEntry(
    value: unknown
  ): ContextInvestigationMemoryEntry {
    const entry =
      value && typeof value === "object"
        ? (value as Partial<ContextInvestigationMemoryEntry>)
        : {}

    return {
      batchId:
        typeof entry.batchId === "string" && entry.batchId.trim().length > 0
          ? entry.batchId.trim()
          : `recovered_${crypto.randomUUID()}`,
      label: typeof entry.label === "string" ? entry.label : "",
      details: typeof entry.details === "string" ? entry.details : "",
      toolCallIds: Array.isArray(entry.toolCallIds)
        ? entry.toolCallIds.filter(
            (toolCallId): toolCallId is string =>
              typeof toolCallId === "string" && toolCallId.trim().length > 0
          )
        : [],
      toolCount:
        typeof entry.toolCount === "number" && Number.isFinite(entry.toolCount)
          ? Math.max(0, Math.floor(entry.toolCount))
          : 0,
      readOnly: entry.readOnly === true,
      createdAt:
        typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
          ? entry.createdAt
          : Date.now(),
    }
  }

  private normalizeSessionMemoryEntry(
    value: unknown
  ): ContextSessionMemoryEntry {
    const entry =
      value && typeof value === "object"
        ? (value as Partial<ContextSessionMemoryEntry>)
        : {}
    const kind =
      entry.kind === "objective" ||
      entry.kind === "decision" ||
      entry.kind === "progress" ||
      entry.kind === "file" ||
      entry.kind === "constraint" ||
      entry.kind === "verification" ||
      entry.kind === "risk" ||
      entry.kind === "command" ||
      entry.kind === "sub_agent" ||
      entry.kind === "open_item"
        ? entry.kind
        : "progress"

    return {
      id:
        typeof entry.id === "string" && entry.id.trim().length > 0
          ? entry.id.trim()
          : `recovered_${crypto.randomUUID()}`,
      kind,
      text: typeof entry.text === "string" ? entry.text : "",
      sourceCompactionId:
        typeof entry.sourceCompactionId === "string"
          ? entry.sourceCompactionId
          : "",
      sourceRecordId:
        typeof entry.sourceRecordId === "string"
          ? entry.sourceRecordId
          : undefined,
      createdAt:
        typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
          ? entry.createdAt
          : Date.now(),
      weight:
        typeof entry.weight === "number" && Number.isFinite(entry.weight)
          ? Math.max(0, Math.floor(entry.weight))
          : 1,
    }
  }

  private normalizeNativeCacheEditState(
    value: unknown
  ): ContextNativeCacheEditState {
    const state =
      value && typeof value === "object"
        ? (value as Partial<ContextNativeCacheEditState>)
        : {}
    return {
      toolOrder: Array.isArray(state.toolOrder)
        ? state.toolOrder.filter(
            (toolUseId): toolUseId is string =>
              typeof toolUseId === "string" && toolUseId.trim().length > 0
          )
        : [],
      deletedToolUseIds: Array.isArray(state.deletedToolUseIds)
        ? state.deletedToolUseIds.filter(
            (toolUseId): toolUseId is string =>
              typeof toolUseId === "string" && toolUseId.trim().length > 0
          )
        : [],
      pinnedEdits: Array.isArray(state.pinnedEdits)
        ? state.pinnedEdits.flatMap((pin) => {
            if (!pin || typeof pin !== "object") return []
            const candidate = pin
            const edits = Array.isArray(candidate.block?.edits)
              ? candidate.block.edits.filter(
                  (
                    edit
                  ): edit is {
                    type: "delete"
                    cache_reference: string
                  } =>
                    edit?.type === "delete" &&
                    typeof edit.cache_reference === "string" &&
                    edit.cache_reference.trim().length > 0
                )
              : []
            if (edits.length === 0) return []
            return [
              {
                targetRecordId:
                  typeof candidate.targetRecordId === "string"
                    ? candidate.targetRecordId
                    : undefined,
                targetMessageIndex:
                  typeof candidate.targetMessageIndex === "number" &&
                  Number.isFinite(candidate.targetMessageIndex)
                    ? Math.max(0, Math.floor(candidate.targetMessageIndex))
                    : 0,
                block: {
                  type: "cache_edits" as const,
                  edits,
                },
                createdAt:
                  typeof candidate.createdAt === "number" &&
                  Number.isFinite(candidate.createdAt)
                    ? candidate.createdAt
                    : Date.now(),
              },
            ]
          })
        : [],
      toolsSentToApi: state.toolsSentToApi === true,
    }
  }

  private normalizeCompactionHistory(
    state: ContextConversationState,
    persistedVersion: PersistedChatSessionV1["version"]
  ): {
    compactionHistory: ContextCompactionCommit[]
    activeCompactionId?: string
  } {
    const history = Array.isArray(state.compactionHistory)
      ? state.compactionHistory.filter(
          (commit): commit is ContextCompactionCommit =>
            !!commit &&
            typeof commit === "object" &&
            typeof commit.id === "string" &&
            commit.id.trim().length > 0 &&
            typeof commit.archivedThroughRecordId === "string" &&
            commit.archivedThroughRecordId.trim().length > 0 &&
            typeof commit.summary === "string"
        )
      : []
    const activeCompactionId =
      typeof state.activeCompactionId === "string" &&
      state.activeCompactionId.trim().length > 0
        ? state.activeCompactionId
        : undefined
    const activeCommit = activeCompactionId
      ? history.find((commit) => commit.id === activeCompactionId)
      : undefined

    if (persistedVersion >= 8) {
      return {
        compactionHistory: history,
        activeCompactionId: activeCommit?.id,
      }
    }

    return activeCommit
      ? {
          compactionHistory: [
            {
              ...activeCommit,
              parentCompactionId: undefined,
            },
          ],
          activeCompactionId: activeCommit.id,
        }
      : {
          compactionHistory: [],
          activeCompactionId: undefined,
        }
  }

  private hasContextEventRecords(
    records: readonly ContextTranscriptRecord[] | undefined
  ): boolean {
    return records != null && records.some((record) => !isMessageRecord(record))
  }

  private normalizeTranscriptRecords(
    records: readonly ContextTranscriptRecord[]
  ): ContextTranscriptRecord[] {
    return records.flatMap((record) => {
      if (!record || typeof record !== "object") return []
      if (!record.kind) {
        return [{ ...record, kind: "message" as const }]
      }
      return [{ ...record }]
    })
  }

  private migrateCompactionStateToTranscript(
    rawContextState: ContextConversationState,
    messageRecords: ContextTranscriptRecord[],
    normalizedCompactionState:
      | {
          compactionHistory: ContextCompactionCommit[]
          activeCompactionId?: string
        }
      | undefined
  ): ContextTranscriptRecord[] {
    const rawRecords = this.normalizeTranscriptRecords(rawContextState.records)
    if (this.hasContextEventRecords(rawRecords)) {
      return rawRecords
    }

    const activeCommit = normalizedCompactionState?.activeCompactionId
      ? normalizedCompactionState.compactionHistory.find(
          (commit) => commit.id === normalizedCompactionState.activeCompactionId
        )
      : undefined
    if (!activeCommit) {
      return messageRecords
    }

    const retainedRecords = stripInternalContextEvents(rawRecords)
    const createdAt = activeCommit.createdAt || Date.now()
    return [
      createCompactBoundaryRecord(activeCommit, createdAt),
      createCompactSummaryRecord(activeCommit, createdAt + 1),
      ...retainedRecords,
    ]
  }

  private syncMessagesFromRecords(
    records: ContextTranscriptRecord[]
  ): SessionMessage[] {
    return records.filter(isMessageRecord).map((record) => ({
      role: record.role,
      content: record.content,
    }))
  }

  private messageContentEqual(
    left: MessageContent,
    right: MessageContent
  ): boolean {
    if (left === right) return true
    if (typeof left !== typeof right) return false
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }

  private messagesEqual(left: SessionMessage, right: SessionMessage): boolean {
    return (
      left.role === right.role &&
      this.messageContentEqual(left.content, right.content)
    )
  }

  private hasStableRecordProjection(
    previousRecords: ContextTranscriptRecord[],
    nextRecords: ContextTranscriptRecord[],
    throughRecordId: string
  ): boolean {
    const previousIndex = previousRecords.findIndex(
      (record) => record.id === throughRecordId
    )
    const nextIndex = nextRecords.findIndex(
      (record) => record.id === throughRecordId
    )
    if (previousIndex < 0 || nextIndex < 0) {
      return false
    }

    const previousSuffix = previousRecords.slice(previousIndex)
    const nextSuffix = nextRecords.slice(
      nextIndex,
      nextIndex + previousSuffix.length
    )
    if (previousSuffix.length !== nextSuffix.length) {
      return false
    }

    for (let index = 0; index < previousSuffix.length; index++) {
      if (previousSuffix[index]?.id !== nextSuffix[index]?.id) {
        return false
      }
    }

    return true
  }

  private syncContextRecordsFromMessageRecords(
    state: ContextConversationState,
    messageRecords: ContextTranscriptRecord[]
  ): void {
    const activeCommit = getActiveCompactCommitFromTranscript(state.records)
    if (!activeCommit) {
      state.records = messageRecords.map((record) => ({
        ...record,
        kind: record.kind || "message",
      }))
      state.compactionHistory = []
      state.activeCompactionId = undefined
      state.codexContext = {
        ...(state.codexContext || this.createCodexContextState()),
        historyVersion: (state.codexContext?.historyVersion || 0) + 1,
        replacementHistory: undefined,
      }
      return
    }

    const visibleById = new Map(
      messageRecords.map((record) => [record.id, record])
    )
    const knownMessageIds = new Set<string>()
    const synced = state.records.map((record) => {
      if (!isMessageRecord(record)) return record
      knownMessageIds.add(record.id)
      const visible = visibleById.get(record.id)
      return visible ? { ...visible, kind: "message" as const } : record
    })
    const lastStateMessage = [...state.records]
      .reverse()
      .find((record) => isMessageRecord(record))
    const lastVisibleIndex = lastStateMessage
      ? messageRecords.findIndex((record) => record.id === lastStateMessage.id)
      : -1
    const appended =
      lastVisibleIndex >= 0
        ? messageRecords
            .slice(lastVisibleIndex + 1)
            .filter((record) => !knownMessageIds.has(record.id))
        : messageRecords.filter((record) => !knownMessageIds.has(record.id))
    state.records = [
      ...synced,
      ...appended.map((record) => ({
        ...record,
        kind: "message" as const,
      })),
    ]
    state.compactionHistory = deriveCompactionHistoryFromTranscript(
      state.records
    )
    state.activeCompactionId = activeCommit.id
  }

  private reconcileMessageRecords(
    existing: ContextTranscriptRecord[],
    nextMessages: SessionMessage[]
  ): ContextTranscriptRecord[] {
    let prefix = 0
    while (
      prefix < existing.length &&
      prefix < nextMessages.length &&
      this.messagesEqual(existing[prefix]!, nextMessages[prefix]!)
    ) {
      prefix++
    }

    let existingSuffix = existing.length - 1
    let nextSuffix = nextMessages.length - 1
    while (
      existingSuffix >= prefix &&
      nextSuffix >= prefix &&
      this.messagesEqual(existing[existingSuffix]!, nextMessages[nextSuffix]!)
    ) {
      existingSuffix--
      nextSuffix--
    }

    const reconciled: ContextTranscriptRecord[] = []
    reconciled.push(...existing.slice(0, prefix))
    for (let i = prefix; i <= nextSuffix; i++) {
      reconciled.push(this.createTranscriptRecord(nextMessages[i]!))
    }
    if (existingSuffix + 1 < existing.length) {
      reconciled.push(...existing.slice(existingSuffix + 1))
    }
    return reconciled
  }

  private isContextStateCompatible(
    state: ContextConversationState,
    records: ContextTranscriptRecord[],
    previousRecords: ContextTranscriptRecord[] = state.records
  ): boolean {
    if (getActiveCompactCommitFromTranscript(state.records)) {
      return true
    }
    if (
      typeof state.activeCompactionId === "string" ||
      (Array.isArray(state.compactionHistory) &&
        state.compactionHistory.length > 0)
    ) {
      return true
    }

    const stateMessageRecords = stripInternalContextEvents(previousRecords)
    if (stateMessageRecords.length === 0) return true
    return this.hasStableRecordProjection(
      stateMessageRecords,
      records,
      stateMessageRecords[0]!.id
    )
  }

  private shouldRetainUsageLedger(
    state: ContextConversationState,
    records: ContextTranscriptRecord[],
    previousRecords: ContextTranscriptRecord[] = state.records
  ): boolean {
    const anchorRecordId = state.usageLedger.anchorRecordId
    if (!anchorRecordId) return true
    if (getActiveCompactCommitFromTranscript(state.records)) {
      return records.some((record) => record.id === anchorRecordId)
    }

    return this.hasStableRecordProjection(
      previousRecords,
      records,
      anchorRecordId
    )
  }

  private deserializeSession(persisted: PersistedChatSessionV1): ChatSession {
    const now = Date.now()
    const createdAt = new Date(this.toTimestamp(persisted.createdAt, now))
    const lastActivityAt = new Date(
      this.toTimestamp(persisted.lastActivityAt, createdAt.getTime())
    )
    const baseMessages = Array.isArray(persisted.messages)
      ? persisted.messages
      : []
    const messageRecords =
      Array.isArray(persisted.messageRecords) &&
      persisted.messageRecords.length > 0
        ? persisted.messageRecords
        : baseMessages.map((message, index) =>
            this.createTranscriptRecord(
              message,
              createdAt.getTime() + index * 1000
            )
          )
    const rawContextState =
      persisted.contextState && typeof persisted.contextState === "object"
        ? persisted.contextState
        : undefined
    const normalizedCompactionState = rawContextState
      ? this.normalizeCompactionHistory(rawContextState, persisted.version)
      : undefined
    const migratedContextRecords = rawContextState
      ? this.migrateCompactionStateToTranscript(
          rawContextState,
          messageRecords,
          normalizedCompactionState
        )
      : undefined
    const contextState =
      rawContextState &&
      Array.isArray(rawContextState.records) &&
      this.isContextStateCompatible(
        rawContextState,
        messageRecords,
        rawContextState.records
      )
        ? {
            ...rawContextState,
            records: migratedContextRecords || messageRecords,
            compactionHistory: deriveCompactionHistoryFromTranscript(
              migratedContextRecords || []
            ),
            activeCompactionId: getActiveCompactCommitFromTranscript(
              migratedContextRecords || []
            )?.id,
            compactionEpoch:
              typeof rawContextState.compactionEpoch === "number" &&
              rawContextState.compactionEpoch >= 0
                ? rawContextState.compactionEpoch
                : 0,
            lastAppliedCompaction:
              rawContextState.lastAppliedCompaction &&
              typeof rawContextState.lastAppliedCompaction === "object" &&
              (typeof rawContextState.lastAppliedCompaction.compactionId ===
                "string" ||
                typeof rawContextState.activeCompactionId === "string")
                ? {
                    recordCount:
                      typeof rawContextState.lastAppliedCompaction
                        .recordCount === "number" &&
                      rawContextState.lastAppliedCompaction.recordCount >= 0
                        ? rawContextState.lastAppliedCompaction.recordCount
                        : messageRecords.length,
                    attachmentFingerprint:
                      typeof rawContextState.lastAppliedCompaction
                        .attachmentFingerprint === "string"
                        ? rawContextState.lastAppliedCompaction
                            .attachmentFingerprint
                        : "",
                    appliedAt:
                      typeof rawContextState.lastAppliedCompaction.appliedAt ===
                      "number"
                        ? rawContextState.lastAppliedCompaction.appliedAt
                        : Date.now(),
                    compactionId:
                      typeof rawContextState.lastAppliedCompaction
                        .compactionId === "string"
                        ? rawContextState.lastAppliedCompaction.compactionId
                        : (rawContextState.activeCompactionId as string),
                    epoch:
                      typeof rawContextState.lastAppliedCompaction.epoch ===
                        "number" &&
                      rawContextState.lastAppliedCompaction.epoch >= 0
                        ? rawContextState.lastAppliedCompaction.epoch
                        : typeof rawContextState.compactionEpoch === "number"
                          ? rawContextState.compactionEpoch
                          : 0,
                  }
                : undefined,
            usageLedger: this.shouldRetainUsageLedger(
              rawContextState,
              messageRecords,
              rawContextState.records
            )
              ? rawContextState.usageLedger
              : {},
            codexContext: this.normalizeCodexContextState(
              rawContextState.codexContext
            ),
            toolResultReplacementState:
              rawContextState.toolResultReplacementState
                ? {
                    seenToolUseIds: Array.isArray(
                      rawContextState.toolResultReplacementState.seenToolUseIds
                    )
                      ? [
                          ...rawContextState.toolResultReplacementState
                            .seenToolUseIds,
                        ]
                      : [],
                    replacementByToolUseId:
                      rawContextState.toolResultReplacementState
                        .replacementByToolUseId &&
                      typeof rawContextState.toolResultReplacementState
                        .replacementByToolUseId === "object"
                        ? {
                            ...rawContextState.toolResultReplacementState
                              .replacementByToolUseId,
                          }
                        : {},
                    storedByToolUseId:
                      rawContextState.toolResultReplacementState
                        .storedByToolUseId &&
                      typeof rawContextState.toolResultReplacementState
                        .storedByToolUseId === "object"
                        ? {
                            ...rawContextState.toolResultReplacementState
                              .storedByToolUseId,
                          }
                        : {},
                    records: Array.isArray(
                      rawContextState.toolResultReplacementState.records
                    )
                      ? [...rawContextState.toolResultReplacementState.records]
                      : [],
                  }
                : {
                    seenToolUseIds: [],
                    replacementByToolUseId: {},
                    storedByToolUseId: {},
                    records: [],
                  },
            nativeCacheEditState: this.normalizeNativeCacheEditState(
              rawContextState.nativeCacheEditState
            ),
            investigationMemory: Array.isArray(
              rawContextState.investigationMemory
            )
              ? rawContextState.investigationMemory.map((entry) =>
                  this.normalizeInvestigationMemoryEntry(entry)
                )
              : [],
            sessionMemory: Array.isArray(rawContextState.sessionMemory)
              ? rawContextState.sessionMemory.map((entry) =>
                  this.normalizeSessionMemoryEntry(entry)
                )
              : [],
          }
        : this.createContextState(messageRecords)
    this.syncContextRecordsFromMessageRecords(contextState, messageRecords)
    if (contextState.lastAppliedCompaction) {
      contextState.lastAppliedCompaction = {
        ...contextState.lastAppliedCompaction,
        recordCount: contextState.records.length,
      }
    }

    const topLevelAgentTurnState = persisted.topLevelAgentTurnState
      ? {
          llmTurnCount:
            typeof persisted.topLevelAgentTurnState.llmTurnCount === "number" &&
            persisted.topLevelAgentTurnState.llmTurnCount > 0
              ? persisted.topLevelAgentTurnState.llmTurnCount
              : 1,
          readOnlyBatchCount:
            typeof persisted.topLevelAgentTurnState.readOnlyBatchCount ===
              "number" &&
            persisted.topLevelAgentTurnState.readOnlyBatchCount >= 0
              ? persisted.topLevelAgentTurnState.readOnlyBatchCount
              : 0,
          hasMutatingToolCall:
            persisted.topLevelAgentTurnState.hasMutatingToolCall === true,
          lastReadOnlyContinuationHistoryTokens:
            typeof persisted.topLevelAgentTurnState
              .lastReadOnlyContinuationHistoryTokens === "number" &&
            Number.isFinite(
              persisted.topLevelAgentTurnState
                .lastReadOnlyContinuationHistoryTokens
            ) &&
            persisted.topLevelAgentTurnState
              .lastReadOnlyContinuationHistoryTokens >= 0
              ? persisted.topLevelAgentTurnState
                  .lastReadOnlyContinuationHistoryTokens
              : undefined,
          stalledReadOnlyContinuationCount:
            typeof persisted.topLevelAgentTurnState
              .stalledReadOnlyContinuationCount === "number" &&
            persisted.topLevelAgentTurnState.stalledReadOnlyContinuationCount >=
              0
              ? persisted.topLevelAgentTurnState
                  .stalledReadOnlyContinuationCount
              : 0,
          continuationBudget:
            persisted.topLevelAgentTurnState.continuationBudget &&
            typeof persisted.topLevelAgentTurnState.continuationBudget ===
              "object"
              ? {
                  continuationCount:
                    typeof persisted.topLevelAgentTurnState.continuationBudget
                      .continuationCount === "number" &&
                    persisted.topLevelAgentTurnState.continuationBudget
                      .continuationCount >= 0
                      ? persisted.topLevelAgentTurnState.continuationBudget
                          .continuationCount
                      : 0,
                  lastHistoryTokens:
                    typeof persisted.topLevelAgentTurnState.continuationBudget
                      .lastHistoryTokens === "number" &&
                    persisted.topLevelAgentTurnState.continuationBudget
                      .lastHistoryTokens >= 0
                      ? persisted.topLevelAgentTurnState.continuationBudget
                          .lastHistoryTokens
                      : 0,
                  lastDeltaTokens:
                    typeof persisted.topLevelAgentTurnState.continuationBudget
                      .lastDeltaTokens === "number" &&
                    persisted.topLevelAgentTurnState.continuationBudget
                      .lastDeltaTokens >= 0
                      ? persisted.topLevelAgentTurnState.continuationBudget
                          .lastDeltaTokens
                      : 0,
                  startedAt:
                    typeof persisted.topLevelAgentTurnState.continuationBudget
                      .startedAt === "number" &&
                    Number.isFinite(
                      persisted.topLevelAgentTurnState.continuationBudget
                        .startedAt
                    ) &&
                    persisted.topLevelAgentTurnState.continuationBudget
                      .startedAt > 0
                      ? persisted.topLevelAgentTurnState.continuationBudget
                          .startedAt
                      : Date.now(),
                }
              : {
                  continuationCount: 0,
                  lastHistoryTokens: 0,
                  lastDeltaTokens: 0,
                  startedAt: Date.now(),
                },
          mutationBarrier:
            persisted.topLevelAgentTurnState.mutationBarrier &&
            typeof persisted.topLevelAgentTurnState.mutationBarrier === "object"
              ? {
                  mutatingBatchCount:
                    typeof persisted.topLevelAgentTurnState.mutationBarrier
                      .mutatingBatchCount === "number" &&
                    persisted.topLevelAgentTurnState.mutationBarrier
                      .mutatingBatchCount >= 0
                      ? persisted.topLevelAgentTurnState.mutationBarrier
                          .mutatingBatchCount
                      : 0,
                  verificationReadOnlyBatchCount:
                    typeof persisted.topLevelAgentTurnState.mutationBarrier
                      .verificationReadOnlyBatchCount === "number" &&
                    persisted.topLevelAgentTurnState.mutationBarrier
                      .verificationReadOnlyBatchCount >= 0
                      ? persisted.topLevelAgentTurnState.mutationBarrier
                          .verificationReadOnlyBatchCount
                      : 0,
                  lastEditedPaths: Array.isArray(
                    persisted.topLevelAgentTurnState.mutationBarrier
                      .lastEditedPaths
                  )
                    ? persisted.topLevelAgentTurnState.mutationBarrier.lastEditedPaths
                        .filter(
                          (value): value is string =>
                            typeof value === "string" && value.trim().length > 0
                        )
                        .map((value) => value.trim())
                    : [],
                }
              : {
                  mutatingBatchCount: 0,
                  verificationReadOnlyBatchCount: 0,
                  lastEditedPaths: [],
                },
          activeToolBatch: persisted.topLevelAgentTurnState.activeToolBatch
            ? {
                batchId:
                  persisted.topLevelAgentTurnState.activeToolBatch.batchId,
                toolCallIds: Array.isArray(
                  persisted.topLevelAgentTurnState.activeToolBatch.toolCallIds
                )
                  ? [
                      ...persisted.topLevelAgentTurnState.activeToolBatch
                        .toolCallIds,
                    ]
                  : [],
                assistantText:
                  persisted.topLevelAgentTurnState.activeToolBatch
                    .assistantText || "",
                readOnly:
                  persisted.topLevelAgentTurnState.activeToolBatch.readOnly ===
                  true,
                startedAt:
                  typeof persisted.topLevelAgentTurnState.activeToolBatch
                    .startedAt === "number"
                    ? persisted.topLevelAgentTurnState.activeToolBatch.startedAt
                    : Date.now(),
                tools: Array.isArray(
                  persisted.topLevelAgentTurnState.activeToolBatch.tools
                )
                  ? persisted.topLevelAgentTurnState.activeToolBatch.tools.map(
                      (tool) => ({
                        toolCallId: tool.toolCallId,
                        toolName: tool.toolName,
                        input:
                          tool.input &&
                          typeof tool.input === "object" &&
                          !Array.isArray(tool.input)
                            ? tool.input
                            : {},
                        resultSummary:
                          typeof tool.resultSummary === "string"
                            ? tool.resultSummary
                            : undefined,
                      })
                    )
                  : [],
              }
            : undefined,
        }
      : this.createEmptyTopLevelAgentTurnState()

    // Codex response chains are bound to slot assignments within a single
    // bridge process lifetime. After a restart, slots may be reassigned and
    // server-side response caches expire, so restoring these fields would
    // cause continuation requests to fail with 400 "Previous response not found".
    const restoredLastCodexRequestSignature: string | undefined = undefined
    const restoredLastCodexResponseId: string | undefined = undefined

    return {
      conversationId: persisted.conversationId,
      messages: this.syncMessagesFromRecords(messageRecords),
      messageRecords,
      contextState,
      topLevelAgentTurnState,
      lastEmittedContextSummaryCompactionId:
        typeof persisted.lastEmittedContextSummaryCompactionId === "string" &&
        persisted.lastEmittedContextSummaryCompactionId.trim().length > 0
          ? persisted.lastEmittedContextSummaryCompactionId.trim()
          : undefined,
      lastEmittedContextSummaryCompactionEpoch:
        typeof persisted.lastEmittedContextSummaryCompactionEpoch ===
          "number" && persisted.lastEmittedContextSummaryCompactionEpoch >= 0
          ? persisted.lastEmittedContextSummaryCompactionEpoch
          : undefined,
      pendingContextSummaryUiUpdate: undefined,
      // Note: We do NOT run enforceToolProtocol here.
      // Deserialized sessions may have legitimate interrupted tool calls that
      // should be handled by repairInterruptedToolProtocol() with proper
      // restart recovery context, not by generic synthetic tool_result injection.
      model: persisted.model || "claude-sonnet-4.5",
      lastAssistantBackend:
        typeof persisted.lastAssistantBackend === "string"
          ? persisted.lastAssistantBackend
          : undefined,
      lastCodexResponseId: restoredLastCodexResponseId,
      lastCodexRequestSignature: restoredLastCodexRequestSignature,
      pendingCodexResponseId: undefined,
      pendingCodexRequestSignature: undefined,
      thinkingLevel:
        typeof persisted.thinkingLevel === "number"
          ? persisted.thinkingLevel
          : 0,
      thinkingDetailsRequested: persisted.thinkingDetailsRequested === true,
      isAgentic: persisted.isAgentic === true,
      supportedTools: Array.isArray(persisted.supportedTools)
        ? persisted.supportedTools
        : [],
      // discoveredTools is intentionally not persisted: a tool's full
      // schema is cheaper to re-discover (one extra inline turn) than
      // to keep the schema set in sync across SQLite restarts and
      // upstream-side schema changes.  Always start fresh on restore.
      discoveredTools: new Set<string>(),
      mcpToolDefs: persisted.mcpToolDefs,
      useWeb: persisted.useWeb === true,
      requestContextEnv: persisted.requestContextEnv,
      createdAt,
      lastActivityAt,
      pendingToolCalls: new Map(),
      backgroundCommands: new Map(
        Array.isArray(persisted.backgroundCommands)
          ? persisted.backgroundCommands
              .filter(
                (command): command is PersistedBackgroundCommand =>
                  !!command &&
                  typeof command.commandId === "string" &&
                  command.commandId.trim().length > 0
              )
              .map((command) => [
                command.commandId,
                {
                  commandId: command.commandId,
                  originToolCallId: command.originToolCallId,
                  execIds: Array.isArray(command.execIds)
                    ? command.execIds
                        .filter(
                          (value): value is number =>
                            typeof value === "number" && Number.isFinite(value)
                        )
                        .map((value) => Math.max(0, Math.floor(value)))
                    : [],
                  command: command.command || "",
                  cwd: command.cwd || "",
                  pid:
                    typeof command.pid === "number" &&
                    Number.isFinite(command.pid)
                      ? Math.max(0, Math.floor(command.pid))
                      : undefined,
                  terminalsFolder:
                    typeof command.terminalsFolder === "string" &&
                    command.terminalsFolder.trim().length > 0
                      ? command.terminalsFolder.trim()
                      : undefined,
                  status:
                    command.status === "completed" ||
                    command.status === "failed" ||
                    command.status === "aborted"
                      ? command.status
                      : "running",
                  stdout: Array.isArray(command.stdout)
                    ? [...command.stdout]
                    : [],
                  stderr: Array.isArray(command.stderr)
                    ? [...command.stderr]
                    : [],
                  exitCode:
                    typeof command.exitCode === "number" &&
                    Number.isFinite(command.exitCode)
                      ? Math.floor(command.exitCode)
                      : undefined,
                  msToWait:
                    typeof command.msToWait === "number" &&
                    Number.isFinite(command.msToWait)
                      ? Math.floor(command.msToWait)
                      : undefined,
                  backgroundReason:
                    typeof command.backgroundReason === "number" &&
                    Number.isFinite(command.backgroundReason)
                      ? Math.floor(command.backgroundReason)
                      : undefined,
                  lastTerminalFileLength:
                    typeof command.lastTerminalFileLength === "number" &&
                    Number.isFinite(command.lastTerminalFileLength)
                      ? Math.max(0, Math.floor(command.lastTerminalFileLength))
                      : undefined,
                  startedAt: this.toTimestamp(command.startedAt),
                  updatedAt: this.toTimestamp(command.updatedAt),
                  completedAt:
                    typeof command.completedAt === "number" &&
                    Number.isFinite(command.completedAt)
                      ? Math.max(0, Math.floor(command.completedAt))
                      : undefined,
                } satisfies SessionBackgroundCommand,
              ])
          : []
      ),
      pendingToolCallByExecId: new Map(),
      currentStreamId: crypto.randomUUID(),
      editPathHolderByPath: new Map(),
      editPathQueueByPath: new Map(),
      projectContext: persisted.projectContext,
      codeChunks: persisted.codeChunks,
      // Cursor rules are request-scoped and re-sent by Cursor on each
      // user/resume action. Restoring them from persisted session state causes
      // stale/duplicated default rules to leak across turns.
      cursorRules: undefined,
      selectedCursorRulePaths: undefined,
      selectedCursorRuleNames: undefined,
      activeCursorSkillNames: [],
      cursorCommands: persisted.cursorCommands,
      customSystemPrompt: persisted.customSystemPrompt,
      explicitContext: persisted.explicitContext,
      contextTokenLimit: persisted.contextTokenLimit,
      contextMaxMode: persisted.contextMaxMode,
      usedContextTokens: persisted.usedContextTokens,
      requestedMaxOutputTokens: persisted.requestedMaxOutputTokens,
      requestedModelParameters: persisted.requestedModelParameters,
      // Rebuild the additionalRoots Map from the persisted array.
      // Only `'session'` source entries are persisted, so we don't
      // need to filter on read. `'config'` entries get re-injected
      // by the bridge on session load (see Phase 4) — we still
      // initialize the map here so that injection has a target.
      additionalRoots: Array.isArray(persisted.additionalRoots)
        ? new Map(
            persisted.additionalRoots
              .filter(
                (root): root is AdditionalWorkspaceRoot =>
                  !!root &&
                  typeof root.path === "string" &&
                  root.path.trim().length > 0
              )
              .map((root) => [root.path, root])
          )
        : new Map(),
      usedTokens:
        typeof persisted.usedTokens === "number" ? persisted.usedTokens : 0,
      readPaths: new Set(
        Array.isArray(persisted.readPaths) ? persisted.readPaths : []
      ),
      readSnapshots: Array.isArray(persisted.readSnapshots)
        ? persisted.readSnapshots
            .filter(
              (snapshot): snapshot is SessionReadSnapshot =>
                !!snapshot &&
                typeof snapshot.filePath === "string" &&
                snapshot.filePath.trim().length > 0 &&
                typeof snapshot.content === "string" &&
                snapshot.content.length > 0 &&
                typeof snapshot.capturedAt === "number" &&
                Number.isFinite(snapshot.capturedAt) &&
                typeof snapshot.sourceToolName === "string" &&
                snapshot.sourceToolName.trim().length > 0
            )
            .map((snapshot) => ({
              filePath: snapshot.filePath,
              startLine:
                typeof snapshot.startLine === "number" &&
                Number.isFinite(snapshot.startLine)
                  ? Math.max(1, Math.floor(snapshot.startLine))
                  : undefined,
              endLine:
                typeof snapshot.endLine === "number" &&
                Number.isFinite(snapshot.endLine)
                  ? Math.max(1, Math.floor(snapshot.endLine))
                  : undefined,
              content: snapshot.content,
              capturedAt: Math.max(0, Math.floor(snapshot.capturedAt)),
              sourceToolName: snapshot.sourceToolName,
            }))
        : [],
      fileStates: new Map(
        Array.isArray(persisted.fileStates)
          ? persisted.fileStates.map((state) => [
              state.path,
              {
                beforeContent: state.beforeContent,
                afterContent: state.afterContent,
              },
            ])
          : []
      ),
      toolMetrics: this.normalizeToolMetrics(persisted.toolMetrics),
      messageBlobIds: Array.isArray(persisted.messageBlobIds)
        ? persisted.messageBlobIds
        : [],
      turns: Array.isArray(persisted.turns) ? persisted.turns : [],
      currentAssistantMessage: persisted.currentAssistantMessage,
      stepId: typeof persisted.stepId === "number" ? persisted.stepId : 0,
      execId: typeof persisted.execId === "number" ? persisted.execId : 1,
      pendingInteractionQueries: new Map(),
      interactionQueryId:
        typeof persisted.interactionQueryId === "number"
          ? persisted.interactionQueryId
          : 0,
      todos: Array.isArray(persisted.todos) ? persisted.todos : [],
      subAgentContexts: new Map(),
      restartRecovery: this.buildRestartRecovery(persisted),
      activeAssistantToolBatch: undefined,
    }
  }

  private createFreshSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): ChatSession {
    const initialMessages =
      initialRequest?.conversation.map((message, index, conversation) => {
        if (
          index === conversation.length - 1 &&
          message.role === "user" &&
          initialRequest.attachedImages?.length
        ) {
          return {
            role: message.role,
            content: buildUserMessageContent(
              message.content,
              initialRequest.attachedImages
            ),
          }
        }

        return message
      }) || []
    const messageRecords = initialMessages.map((message, index) =>
      this.createTranscriptRecord(message, Date.now() + index * 1000)
    )
    const contextState = this.createContextState(messageRecords)

    const freshSession: ChatSession = {
      conversationId,
      messages: initialMessages,
      messageRecords,
      contextState,
      topLevelAgentTurnState: this.createEmptyTopLevelAgentTurnState(),
      lastEmittedContextSummaryCompactionId: undefined,
      lastEmittedContextSummaryCompactionEpoch: undefined,
      pendingContextSummaryUiUpdate: undefined,
      model: initialRequest?.model || "claude-sonnet-4.5",
      lastAssistantBackend: undefined,
      lastCodexResponseId: undefined,
      lastCodexRequestSignature: undefined,
      pendingCodexResponseId: undefined,
      pendingCodexRequestSignature: undefined,
      thinkingLevel: initialRequest?.thinkingLevel || 0,
      thinkingDetailsRequested:
        initialRequest?.thinkingDetailsRequested === true,
      isAgentic: initialRequest?.isAgentic || false,
      supportedTools: initialRequest?.supportedTools || [],
      discoveredTools: new Set<string>(),
      mcpToolDefs: initialRequest?.mcpToolDefs,
      useWeb: initialRequest?.useWeb || false,
      requestContextEnv: initialRequest?.requestContextEnv,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      pendingToolCalls: new Map(),
      backgroundCommands: new Map(),
      pendingToolCallByExecId: new Map(),
      currentStreamId: crypto.randomUUID(),
      editPathHolderByPath: new Map(),
      editPathQueueByPath: new Map(),
      projectContext: initialRequest?.projectContext,
      codeChunks: initialRequest?.codeChunks,
      cursorRules: initialRequest?.cursorRules,
      selectedCursorRulePaths: initialRequest?.selectedCursorRulePaths,
      selectedCursorRuleNames: initialRequest?.selectedCursorRuleNames,
      activeCursorSkillNames: [],
      cursorCommands: initialRequest?.cursorCommands,
      customSystemPrompt: initialRequest?.customSystemPrompt,
      explicitContext: initialRequest?.explicitContext,
      contextTokenLimit: initialRequest?.contextTokenLimit,
      contextMaxMode: initialRequest?.contextMaxMode,
      usedContextTokens: initialRequest?.usedContextTokens,
      requestedMaxOutputTokens: initialRequest?.requestedMaxOutputTokens,
      requestedModelParameters: initialRequest?.requestedModelParameters,
      // Brand-new session — no persisted additionalRoots yet. The
      // `'config'` source entries get injected by the bridge after
      // session creation (see Phase 4: loadConfiguredAdditionalRoots).
      additionalRoots: new Map(),
      usedTokens: initialRequest?.usedContextTokens || 0,
      readPaths: new Set(),
      readSnapshots: [],
      fileStates: new Map(),
      toolMetrics: this.createEmptyToolMetrics(),
      messageBlobIds: [],
      turns: [],
      currentAssistantMessage: undefined,
      stepId: 0,
      execId: 1,
      pendingInteractionQueries: new Map(),
      interactionQueryId: 0,
      todos: [],
      subAgentContexts: new Map(),
      restartRecovery: undefined,
      activeAssistantToolBatch: undefined,
    }
    this.logMcpAdvisoryIfMissing(freshSession, "fresh_session")
    return freshSession
  }

  /**
   * Touch session activity timestamp to keep long-lived tool/interaction turns alive.
   */
  touchSession(conversationId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    session.lastActivityAt = new Date()
    return true
  }

  /**
   * Emit an advisory log when a session has no MCP tool definitions attached.
   * `mcp_*` user-facing tools (`mcp_tool` / `list_mcp_resources` /
   * `read_mcp_resource` / `mcp_auth`) all rely on at least one MCP server being
   * configured upstream by the Cursor / Claude Code client. When none are
   * declared, those tools will reliably return `unavailable` — so we surface
   * a one-shot debug hint pointing at the user's MCP config rather than
   * leaving smoke / regression runs to silently misdiagnose this as a bridge
   * failure. The log is per-session-state, so it never spams.
   */
  private mcpAdvisoryEmitted = new WeakSet<ChatSession>()
  private logMcpAdvisoryIfMissing(
    session: ChatSession,
    reason: "fresh_session" | "session_reuse"
  ): void {
    const defs = session.mcpToolDefs
    if (Array.isArray(defs) && defs.length > 0) {
      // Definitions present — drop any earlier advisory so a future
      // configuration-removed transition can re-log.
      this.mcpAdvisoryEmitted.delete(session)
      return
    }
    if (this.mcpAdvisoryEmitted.has(session)) return
    this.mcpAdvisoryEmitted.add(session)
    this.logger.warn(
      `[mcp-advisory] conversation=${session.conversationId} ` +
        `reason=${reason}: no MCP servers declared by client; ` +
        "mcp_tool / list_mcp_resources / read_mcp_resource / mcp_auth will " +
        "return unavailable. Configure MCP servers in the Cursor / Claude " +
        "Code client (e.g. ~/.cursor/mcp.json) to enable them."
    )
  }

  markSessionDirty(conversationId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return true
  }

  markAssistantBackend(
    conversationId: string,
    backend: BackendType,
    _codexResponseId?: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    session.lastActivityAt = new Date()
    session.lastAssistantBackend = backend
    // previous_response_id 相关字段已废弃，由 CodexService.turnSessions 管理

    this.schedulePersist(conversationId)
  }

  // ── 以下方法已废弃并删除 ──────────────────────────────────────────────
  // cacheCodexWarmupPayload()        → 移入 CodexService.warmupPayloadCache
  // getCachedCodexWarmupPayload()    → 移入 CodexService.warmupPayloadCache
  // stagePendingCodexRequestSignature()
  // commitPendingCodexResponse()
  // discardPendingCodexResponse()
  //
  // previous_response_id 的完整生命周期现在由 CodexService.activeTurnContexts 管理。
  // warmup payload 的缓存现在由 CodexService.warmupPayloadCache 管理。
  // 对标官方 Codex CLI 的 ModelClientSession.WebsocketSession 设计。

  /**
   * Create or get existing session
   */
  getOrCreateSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): ChatSession {
    let session = this.getSession(conversationId)

    if (!session) {
      session = this.createFreshSession(conversationId, initialRequest)
      this.loadConfiguredAdditionalRoots(session)

      this.sessions.set(conversationId, session)
      this.logger.log(
        `>>> Created new session: ${conversationId} (model: ${session.model})`
      )
    } else {
      session.lastActivityAt = new Date()

      // Refresh protocol fields on every turn so continuation strictly follows Cursor request.
      if (initialRequest?.model) {
        session.model = initialRequest.model
      }
      if (initialRequest?.thinkingLevel !== undefined) {
        session.thinkingLevel = initialRequest.thinkingLevel
      }
      if (initialRequest?.thinkingDetailsRequested !== undefined) {
        session.thinkingDetailsRequested =
          initialRequest.thinkingDetailsRequested === true
      }
      if (initialRequest?.supportedTools) {
        session.supportedTools = initialRequest.supportedTools
      }
      if (initialRequest) {
        session.mcpToolDefs = initialRequest.mcpToolDefs
      }
      this.logMcpAdvisoryIfMissing(session, "session_reuse")
      if (initialRequest?.useWeb !== undefined) {
        session.useWeb = initialRequest.useWeb
      }
      if (initialRequest) {
        session.requestContextEnv = initialRequest.requestContextEnv
      }
      if (initialRequest?.projectContext) {
        session.projectContext = initialRequest.projectContext
      }
      if (initialRequest) {
        session.cursorRules = initialRequest.cursorRules
        session.selectedCursorRulePaths = initialRequest.selectedCursorRulePaths
        session.selectedCursorRuleNames = initialRequest.selectedCursorRuleNames
      }
      session.cursorCommands = initialRequest?.cursorCommands
      session.customSystemPrompt = initialRequest?.customSystemPrompt
      if (initialRequest?.explicitContext) {
        session.explicitContext = initialRequest.explicitContext
      }
      if (initialRequest?.contextTokenLimit !== undefined) {
        session.contextTokenLimit = initialRequest.contextTokenLimit
      }
      if (initialRequest?.contextMaxMode !== undefined) {
        session.contextMaxMode = initialRequest.contextMaxMode
      }
      if (initialRequest?.usedContextTokens !== undefined) {
        session.usedContextTokens = initialRequest.usedContextTokens
        session.usedTokens = initialRequest.usedContextTokens
      }
      if (initialRequest?.requestedMaxOutputTokens !== undefined) {
        session.requestedMaxOutputTokens =
          initialRequest.requestedMaxOutputTokens
      }
      if (initialRequest) {
        session.requestedModelParameters =
          initialRequest.requestedModelParameters
      }
      this.loadConfiguredAdditionalRoots(session)

      this.logger.log(
        `>>> Using existing session: ${conversationId} ` +
          `(messages=${session.messages.length}, records=${session.messageRecords.length}, blobIds=${session.messageBlobIds.length}, turns=${session.turns.length}, pending=${session.pendingToolCalls.size})`
      )
    }

    this.schedulePersist(conversationId)
    return session
  }

  /**
   * Update session with new message
   */
  addMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: MessageContent
  ): string | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    let normalizedContent = content
    if (role === "assistant") {
      const sanitized = sanitizeAssistantContentForStorage(content)
      if (sanitized.removedThinkingBlocks > 0) {
        this.logger.warn(
          `Write-time assistant sanitize (addMessage): removed ${sanitized.removedThinkingBlocks} invalid thinking block(s)`
        )
      }
      if (sanitized.content == null) {
        this.logger.warn(
          `Write-time assistant sanitize (addMessage): dropped empty assistant message for ${conversationId}`
        )
        return undefined
      }
      normalizedContent = sanitized.content
    }

    const message = {
      role,
      content: normalizedContent,
    } satisfies SessionMessage
    session.messages.push(message)
    const record = this.createTranscriptRecord(message)
    session.messageRecords.push(record)
    this.syncContextRecordsFromMessageRecords(
      session.contextState,
      session.messageRecords
    )
    session.lastActivityAt = new Date()

    // Note: We do NOT run enforceToolProtocol here.
    // addMessage is an incremental operation — assistant writes tool_use first,
    // then user writes tool_result later. The intermediate state (orphan tool_use
    // with no tool_result yet) is a legitimate pending-tool-call window.
    // Guard only runs on batch operations (replaceMessages) and at send time.

    // Estimate token usage (rough estimate: 1 token ≈ 4 characters)
    const contentStr =
      typeof normalizedContent === "string"
        ? normalizedContent
        : JSON.stringify(normalizedContent)
    session.usedTokens += Math.ceil(contentStr.length / 4)
    this.schedulePersist(conversationId)
    return record.id
  }

  /**
   * Add blobId to session's message history
   * This is used for building conversationCheckpointUpdate
   */
  addMessageBlobId(conversationId: string, blobId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.messageBlobIds.push(blobId)
      this.logger.log(
        `>>> Added blobId to session ${conversationId}: ${blobId.substring(0, 20)}... (total: ${session.messageBlobIds.length})`
      )
      this.schedulePersist(conversationId)
    } else {
      this.logger.error(
        `>>> FAILED to add blobId - session not found: ${conversationId}`
      )
    }
  }

  /**
   * Add a new turn to the session
   * Turns are cumulative identifiers for each conversation round
   */
  addTurn(conversationId: string, turnId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.turns.push(turnId)
      this.logger.log(
        `>>> Added turn ${session.turns.length} to session ${conversationId}: ${turnId.substring(0, 20)}...`
      )
      this.schedulePersist(conversationId)
    } else {
      this.logger.error(
        `>>> FAILED to add turn - session not found: ${conversationId}`
      )
    }
  }

  /**
   * Set current assistant message being built
   */
  setCurrentAssistantMessage(
    conversationId: string,
    message: Record<string, unknown>
  ): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.currentAssistantMessage = message
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Clear current assistant message
   */
  clearCurrentAssistantMessage(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.currentAssistantMessage = undefined
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Track file read operation
   */
  addReadPath(conversationId: string, filePath: string): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.readPaths.add(filePath)
      this.schedulePersist(conversationId)
    }
  }

  addReadSnapshot(
    conversationId: string,
    snapshot: Omit<SessionReadSnapshot, "capturedAt">
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false

    const filePath =
      typeof snapshot.filePath === "string" ? snapshot.filePath.trim() : ""
    if (!filePath || typeof snapshot.content !== "string") {
      return false
    }
    if (
      snapshot.content.length === 0 ||
      snapshot.content.length > this.MAX_READ_SNAPSHOT_CHARS
    ) {
      return false
    }

    const nextSnapshot: SessionReadSnapshot = {
      filePath,
      startLine:
        typeof snapshot.startLine === "number" &&
        Number.isFinite(snapshot.startLine)
          ? Math.max(1, Math.floor(snapshot.startLine))
          : undefined,
      endLine:
        typeof snapshot.endLine === "number" &&
        Number.isFinite(snapshot.endLine)
          ? Math.max(1, Math.floor(snapshot.endLine))
          : undefined,
      content: snapshot.content,
      capturedAt: Date.now(),
      sourceToolName:
        typeof snapshot.sourceToolName === "string" &&
        snapshot.sourceToolName.trim().length > 0
          ? snapshot.sourceToolName.trim()
          : "read_file",
    }

    // Best-effort disk stat: capture mtime+size so getLatestReadSnapshot can
    // detect external disk writes between two read_file calls in the same
    // session (e.g. a shell script overwriting a smoke fixture). statSync
    // is sync but cheap on a single file path; failures (relative paths,
    // virtual sources, missing files) are silently dropped — the snapshot
    // will simply skip the staleness check on the read side.
    if (path.isAbsolute(filePath)) {
      try {
        const stat = fs.statSync(filePath)
        nextSnapshot.diskMtimeMs = stat.mtimeMs
        nextSnapshot.diskSizeBytes = stat.size
      } catch {
        // file not stat-able from bridge process; leave fields undefined.
      }
    }

    const withoutSameWindow = session.readSnapshots.filter((existing) => {
      return !(
        existing.filePath === nextSnapshot.filePath &&
        existing.startLine === nextSnapshot.startLine &&
        existing.endLine === nextSnapshot.endLine &&
        existing.sourceToolName === nextSnapshot.sourceToolName
      )
    })

    const sameFileSnapshots = withoutSameWindow.filter(
      (existing) => existing.filePath === nextSnapshot.filePath
    )
    const overflowForFile = Math.max(
      0,
      sameFileSnapshots.length - (this.MAX_READ_SNAPSHOTS_PER_FILE - 1)
    )

    let trimmedSnapshots = withoutSameWindow
    if (overflowForFile > 0) {
      // Evict narrow-range snapshots before full-file snapshots since
      // full-file snapshots have broader coverage and are more useful
      // for edit failure diagnostics.
      const isFullFile = (s: SessionReadSnapshot): boolean =>
        s.startLine == null && s.endLine == null
      let removed = 0
      trimmedSnapshots = withoutSameWindow.filter((existing) => {
        if (
          removed < overflowForFile &&
          existing.filePath === nextSnapshot.filePath &&
          !isFullFile(existing)
        ) {
          removed += 1
          return false
        }
        return true
      })
      // If we still need to evict more (only full-file snapshots left), FIFO
      if (removed < overflowForFile) {
        let remaining = overflowForFile - removed
        trimmedSnapshots = trimmedSnapshots.filter((existing) => {
          if (remaining > 0 && existing.filePath === nextSnapshot.filePath) {
            remaining -= 1
            return false
          }
          return true
        })
      }
    }

    trimmedSnapshots.push(nextSnapshot)
    if (trimmedSnapshots.length > this.MAX_READ_SNAPSHOTS_PER_SESSION) {
      trimmedSnapshots = trimmedSnapshots.slice(
        trimmedSnapshots.length - this.MAX_READ_SNAPSHOTS_PER_SESSION
      )
    }

    session.lastActivityAt = new Date()
    session.readSnapshots = trimmedSnapshots
    this.schedulePersist(conversationId)
    return true
  }

  getLatestReadSnapshot(
    conversationId: string,
    filePath: string,
    options?: {
      startLine?: number
      endLine?: number
      requireCoverage?: boolean
    }
  ): SessionReadSnapshot | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    const normalizedPath = typeof filePath === "string" ? filePath.trim() : ""
    if (!normalizedPath) return undefined

    const requestedStart =
      typeof options?.startLine === "number" &&
      Number.isFinite(options.startLine)
        ? Math.max(1, Math.floor(options.startLine))
        : undefined
    const requestedEnd =
      typeof options?.endLine === "number" && Number.isFinite(options.endLine)
        ? Math.max(1, Math.floor(options.endLine))
        : undefined
    const requireCoverage = options?.requireCoverage !== false

    // Cache the disk stat per call so multiple snapshot candidates for the
    // same path don't re-stat the file.
    let diskStatCached: { mtimeMs: number; size: number } | undefined
    let diskStatProbed = false
    const probeDiskStat = (): { mtimeMs: number; size: number } | undefined => {
      if (diskStatProbed) return diskStatCached
      diskStatProbed = true
      if (!path.isAbsolute(normalizedPath)) return undefined
      try {
        const stat = fs.statSync(normalizedPath)
        diskStatCached = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      } catch {
        diskStatCached = undefined
      }
      return diskStatCached
    }

    const isSnapshotStale = (snapshot: SessionReadSnapshot): boolean => {
      // Snapshot has no captured disk state — bridge could not stat the
      // path at capture time. Skip staleness check; the snapshot is the
      // best evidence we have.
      if (
        typeof snapshot.diskMtimeMs !== "number" ||
        typeof snapshot.diskSizeBytes !== "number"
      ) {
        return false
      }
      const stat = probeDiskStat()
      // No current disk stat (file gone, or relative path): cannot prove
      // staleness. Keep the snapshot.
      if (!stat) return false
      // mtime tolerance: 1ms slop to absorb FS rounding.
      const mtimeDrift = Math.abs(stat.mtimeMs - snapshot.diskMtimeMs)
      if (mtimeDrift > 1 || stat.size !== snapshot.diskSizeBytes) {
        this.logger.debug(
          `getLatestReadSnapshot: dropping stale snapshot for ${normalizedPath} ` +
            `(captured mtime=${snapshot.diskMtimeMs} size=${snapshot.diskSizeBytes}, ` +
            `current mtime=${stat.mtimeMs} size=${stat.size})`
        )
        return true
      }
      return false
    }

    for (let index = session.readSnapshots.length - 1; index >= 0; index--) {
      const snapshot = session.readSnapshots[index]
      if (!snapshot || snapshot.filePath !== normalizedPath) continue
      if (isSnapshotStale(snapshot)) continue

      if (requestedStart == null && requestedEnd == null) {
        return snapshot
      }

      if (snapshot.startLine == null || snapshot.endLine == null) {
        if (!requireCoverage) return snapshot
        continue
      }

      const coversRequestedRange =
        (requestedStart == null || snapshot.startLine <= requestedStart) &&
        (requestedEnd == null || snapshot.endLine >= requestedEnd)
      if (coversRequestedRange) {
        return snapshot
      }
      if (!requireCoverage) {
        return snapshot
      }
    }

    return undefined
  }

  /**
   * Initialize shell stream output tracking for a tool call
   */
  initShellStream(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput = {
        stdout: [],
        stderr: [],
        started: false,
      }
      this.logger.debug(`Initialized shell stream for ${toolCallId}`)
    }
  }

  /**
   * Append shell stream stdout
   */
  appendShellStdout(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stdout.push(data)
      this.logger.debug(`Appended ${data.length} chars stdout to ${toolCallId}`)
    }
  }

  /**
   * Append shell stream stderr
   */
  appendShellStderr(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stderr.push(data)
      this.logger.debug(`Appended ${data.length} chars stderr to ${toolCallId}`)
    }
  }

  /**
   * Mark shell stream as started
   */
  markShellStarted(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.started = true
      this.logger.debug(`Marked shell started for ${toolCallId}`)
    }
  }

  /**
   * Set shell stream exit info
   */
  setShellExit(
    conversationId: string,
    toolCallId: string,
    exitCode: number,
    signal?: string
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.exitCode = exitCode
      pendingCall.shellStreamOutput.signal = signal
      this.logger.debug(
        `Set shell exit for ${toolCallId}: code=${exitCode}, signal=${signal}`
      )
    }
  }

  /**
   * Get accumulated shell output
   */
  getShellOutput(
    conversationId: string,
    toolCallId: string
  ): { stdout: string; stderr: string; exitCode?: number } | null {
    const session = this.getSession(conversationId)
    if (!session) return null

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    if (!pendingCall?.shellStreamOutput) return null

    return {
      stdout: pendingCall.shellStreamOutput.stdout.join(""),
      stderr: pendingCall.shellStreamOutput.stderr.join(""),
      exitCode: pendingCall.shellStreamOutput.exitCode,
    }
  }

  registerBackgroundCommand(
    conversationId: string,
    command: {
      commandId: string
      originToolCallId: string
      execIds?: Iterable<number>
      command: string
      cwd: string
      pid?: number
      terminalsFolder?: string
      stdout?: string
      stderr?: string
      msToWait?: number
      backgroundReason?: number
    }
  ): SessionBackgroundCommand | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    const normalizedCommandId =
      typeof command.commandId === "string" ? command.commandId.trim() : ""
    if (!normalizedCommandId) return undefined

    const backgroundCommand: SessionBackgroundCommand = {
      commandId: normalizedCommandId,
      originToolCallId: command.originToolCallId,
      execIds: Array.from(command.execIds || [])
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value) && value > 0
        )
        .map((value) => Math.floor(value)),
      command: command.command,
      cwd: command.cwd,
      pid:
        typeof command.pid === "number" && Number.isFinite(command.pid)
          ? Math.max(0, Math.floor(command.pid))
          : undefined,
      terminalsFolder:
        typeof command.terminalsFolder === "string" &&
        command.terminalsFolder.trim() !== ""
          ? command.terminalsFolder.trim()
          : undefined,
      status: "running",
      stdout: command.stdout ? [command.stdout] : [],
      stderr: command.stderr ? [command.stderr] : [],
      msToWait:
        typeof command.msToWait === "number" &&
        Number.isFinite(command.msToWait)
          ? Math.max(0, Math.floor(command.msToWait))
          : undefined,
      backgroundReason:
        typeof command.backgroundReason === "number" &&
        Number.isFinite(command.backgroundReason)
          ? Math.floor(command.backgroundReason)
          : undefined,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }

    session.backgroundCommands.set(normalizedCommandId, backgroundCommand)
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return backgroundCommand
  }

  getBackgroundCommand(
    conversationId: string,
    commandId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined
    return session.backgroundCommands.get(commandId.trim())
  }

  findBackgroundCommandByToolCallId(
    conversationId: string,
    toolCallId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined
    for (const command of session.backgroundCommands.values()) {
      if (command.originToolCallId === toolCallId) {
        return command
      }
    }
    return undefined
  }

  markPendingShellToolBackgrounded(
    conversationId: string,
    toolCallId: string,
    commandId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    const normalizedToolCallId = toolCallId.trim()
    const normalizedCommandId = commandId.trim() || normalizedToolCallId
    if (!normalizedToolCallId || !normalizedCommandId) return undefined

    const existing = this.findBackgroundCommandByToolCallId(
      conversationId,
      normalizedToolCallId
    )
    if (existing) return existing

    const pendingToolCall = session.pendingToolCalls.get(normalizedToolCallId)
    if (!pendingToolCall) return undefined

    const output = pendingToolCall.shellStreamOutput
    return this.registerBackgroundCommand(conversationId, {
      commandId: normalizedCommandId,
      originToolCallId: normalizedToolCallId,
      execIds: pendingToolCall.execIds,
      command:
        typeof pendingToolCall.toolInput.command === "string"
          ? pendingToolCall.toolInput.command
          : typeof pendingToolCall.toolInput.cmd === "string"
            ? pendingToolCall.toolInput.cmd
            : "",
      cwd:
        typeof pendingToolCall.toolInput.cwd === "string"
          ? pendingToolCall.toolInput.cwd
          : typeof pendingToolCall.toolInput.workingDirectory === "string"
            ? pendingToolCall.toolInput.workingDirectory
            : "",
      terminalsFolder: session.requestContextEnv?.terminalsFolder,
      stdout: output?.stdout.join("") || "",
      stderr: output?.stderr.join("") || "",
    })
  }

  findBackgroundCommandByExecId(
    conversationId: string,
    execIdNumber: number
  ): SessionBackgroundCommand | undefined {
    const session = this.getSession(conversationId)
    if (!session || !Number.isFinite(execIdNumber) || execIdNumber <= 0) {
      return undefined
    }
    const normalizedExecId = Math.floor(execIdNumber)
    for (const command of session.backgroundCommands.values()) {
      if (command.execIds.includes(normalizedExecId)) {
        return command
      }
    }
    return undefined
  }

  appendBackgroundCommandOutput(
    conversationId: string,
    commandId: string,
    stream: "stdout" | "stderr",
    data: string
  ): boolean {
    const command = this.getBackgroundCommand(conversationId, commandId)
    if (!command || !data) return false
    command[stream].push(data)
    command.updatedAt = Date.now()
    this.markSessionDirty(conversationId)
    return true
  }

  updateBackgroundCommandTerminalFileLength(
    conversationId: string,
    commandId: string,
    length: number
  ): boolean {
    const command = this.getBackgroundCommand(conversationId, commandId)
    if (!command || !Number.isFinite(length) || length < 0) return false
    command.lastTerminalFileLength = Math.floor(length)
    command.updatedAt = Date.now()
    this.markSessionDirty(conversationId)
    return true
  }

  setBackgroundCommandExit(
    conversationId: string,
    commandId: string,
    exitCode: number,
    aborted = false
  ): boolean {
    const command = this.getBackgroundCommand(conversationId, commandId)
    if (!command) return false
    command.exitCode = Math.floor(exitCode)
    command.status = aborted
      ? "aborted"
      : exitCode === 0
        ? "completed"
        : "failed"
    command.updatedAt = Date.now()
    command.completedAt = Date.now()
    this.markSessionDirty(conversationId)
    return true
  }

  /**
   * Check if shell stream is complete (has exit event)
   */
  isShellStreamComplete(conversationId: string, toolCallId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false

    const pendingCall = session.pendingToolCalls.get(toolCallId)
    return pendingCall?.shellStreamOutput?.exitCode !== undefined
  }

  /**
   * Track file edit operation
   */
  addFileState(
    conversationId: string,
    filePath: string,
    beforeContent: string,
    afterContent: string
  ): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      session.fileStates.set(filePath, { beforeContent, afterContent })
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Add pending tool call
   */
  private resolveWorkspaceFilePath(
    session: ChatSession,
    filePath: string
  ): string {
    const rootPath =
      typeof session.projectContext?.rootPath === "string" &&
      session.projectContext.rootPath.trim() !== ""
        ? session.projectContext.rootPath
        : process.cwd()
    const normalizedRoot = path.resolve(rootPath)
    return path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(normalizedRoot, filePath)
  }

  addPendingToolCall(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolFamilyHint?: "mcp" | "web_fetch",
    modelCallId: string = "",
    historyToolName?: string,
    historyToolInput?: Record<string, unknown>,
    codexToolCallType?: "function" | "custom",
    subagentOwner?: string
  ): void {
    const session = this.getSession(conversationId)
    if (session) {
      // For edit tools, beforeContent is captured later in the
      // read_result → writeArgs handshake (see CursorConnectStreamService
      // handleToolResult). The read_result payload carries the
      // client-reported pre-edit content of the file, which is the only
      // value that is consistent with the post-edit content emitted in the
      // subsequent write_result. Reading the bridge host's local fs here
      // would produce stale or wrong content in SSH remote-development
      // workflows (issue #5), so we leave beforeContent unset until the
      // protocol-supplied truth arrives.
      const beforeContent: string | undefined = undefined

      session.pendingToolCalls.set(toolCallId, {
        toolCallId,
        toolName,
        toolInput,
        historyToolName,
        historyToolInput,
        codexToolCallType,
        toolFamilyHint,
        modelCallId,
        startedEmitted: false,
        sentAt: new Date(),
        execIds: new Set(),
        beforeContent,
        streamId: session.currentStreamId,
        subagentOwner,
      })
      session.lastActivityAt = new Date()
      this.logger.debug(
        `Added pending tool call: ${toolCallId} (${toolName}) for session ${conversationId}` +
          (subagentOwner ? ` [subagent=${subagentOwner}]` : "")
      )
      this.schedulePersist(conversationId)
    }
  }

  getPendingToolCallIds(conversationId: string): string[] {
    const session = this.getSession(conversationId)
    if (!session) return []
    return Array.from(session.pendingToolCalls.keys())
  }

  startAssistantToolBatch(
    conversationId: string,
    backend: BackendType,
    toolCallIds: string[]
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const normalizedToolCallIds = toolCallIds
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)

    if (normalizedToolCallIds.length === 0) {
      session.activeAssistantToolBatch = undefined
      return
    }

    session.activeAssistantToolBatch = {
      id: `assistant-batch-${Date.now()}`,
      backend,
      toolCallIds: [...normalizedToolCallIds],
      unsettledToolCallIds: [...normalizedToolCallIds],
      continuationClaimed: false,
    }
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  settleAssistantToolBatchTool(
    conversationId: string,
    toolCallId: string
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session?.activeAssistantToolBatch) return false

    const normalizedToolCallId =
      typeof toolCallId === "string" ? toolCallId.trim() : ""
    if (!normalizedToolCallId) return false

    const batch = session.activeAssistantToolBatch
    const nextUnsettled = batch.unsettledToolCallIds.filter(
      (id) => id !== normalizedToolCallId
    )
    if (nextUnsettled.length === batch.unsettledToolCallIds.length) {
      return false
    }

    batch.unsettledToolCallIds = nextUnsettled

    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return true
  }

  hasUnsettledAssistantToolBatchForBackend(
    conversationId: string,
    backend: BackendType
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session?.activeAssistantToolBatch) return false

    return (
      session.activeAssistantToolBatch.backend === backend &&
      session.activeAssistantToolBatch.unsettledToolCallIds.length > 0
    )
  }

  claimAssistantToolBatchContinuation(
    conversationId: string,
    backend: BackendType,
    toolCallId: string
  ): boolean {
    const session = this.getSession(conversationId)
    const batch = session?.activeAssistantToolBatch
    if (!session || !batch) return true
    if (batch.backend !== backend) return true
    if (!batch.toolCallIds.includes(toolCallId)) return true
    if (batch.unsettledToolCallIds.length > 0) return false
    if (batch.continuationClaimed) return false

    batch.continuationClaimed = true
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return true
  }

  getPendingToolCallIdsByStream(
    conversationId: string,
    streamId: string
  ): string[] {
    const session = this.getSession(conversationId)
    if (!session || !streamId) return []

    const pendingIds: string[] = []
    for (const [toolCallId, pendingToolCall] of session.pendingToolCalls) {
      if (pendingToolCall.streamId === streamId) {
        pendingIds.push(toolCallId)
      }
    }
    return pendingIds
  }

  /**
   * Get and remove pending tool call
   */
  private detachPendingToolCall(
    session: ChatSession,
    toolCallId: string
  ): PendingToolCall | undefined {
    const toolCall = session.pendingToolCalls.get(toolCallId)
    if (!toolCall) {
      return undefined
    }

    for (const execId of toolCall.execIds) {
      session.pendingToolCallByExecId.delete(execId)
    }
    for (const [execId, mappedToolCallId] of session.pendingToolCallByExecId) {
      if (mappedToolCallId === toolCallId) {
        session.pendingToolCallByExecId.delete(execId)
      }
    }
    session.pendingToolCalls.delete(toolCallId)
    session.lastActivityAt = new Date()

    // 释放 path-level edit serialization slot（若该工具是 edit_file_v2）。
    // detach 出口统一处理，覆盖 consume / clear / 异常路径，避免后续同 path
    // edit 永久阻塞。注意：detach 自身不会派发下一个 readArgs —— 该动作只
    // 应在"成功 consume"路径触发，避免在死流上把 queue 里的 edit 也带飞。
    this.clearEditPathSlot(session, toolCall)

    return toolCall
  }

  /**
   * 同步尝试为 edit_file_v2 占用 path 串行槽。
   *
   * - path 为空：不参与串行化，按 acquired 处理（调用方自行决定如何派发）。
   * - 无 holder：当前 toolCallId 升为 holder，返回 acquired。
   * - 已有 holder：把调度信息追加到队列尾部，返回 queued。
   *
   * 该方法纯同步，不做任何 await，避免阻塞 BiDi generator。
   */
  acquireOrQueueEdit(
    conversationId: string,
    toolCallId: string,
    path: string
  ): { acquired: boolean } {
    const session = this.getSession(conversationId)
    if (!session) {
      return { acquired: true }
    }
    const pending = session.pendingToolCalls.get(toolCallId)
    if (pending) {
      pending.editPath = path
    }

    const normalizedPath = (path || "").trim()
    if (!normalizedPath) {
      return { acquired: true }
    }

    const holder = session.editPathHolderByPath.get(normalizedPath)
    if (!holder) {
      session.editPathHolderByPath.set(normalizedPath, toolCallId)
      return { acquired: true }
    }

    if (holder === toolCallId) {
      // Idempotent: same tool call already holds the slot.
      return { acquired: true }
    }

    let queue = session.editPathQueueByPath.get(normalizedPath)
    if (!queue) {
      queue = []
      session.editPathQueueByPath.set(normalizedPath, queue)
    }
    if (!queue.some((item) => item.toolCallId === toolCallId)) {
      queue.push({
        toolCallId,
        path: normalizedPath,
        enqueuedAt: Date.now(),
      })
    }
    return { acquired: false }
  }

  /**
   * 同步弹出 path 队头并升为新 holder。
   *
   * 仅当 path 当前无 holder 时才会出队（被 detach 后的 clearEditPathSlot
   * 才会进入此状态）。返回出队的调度记录；若无队头返回 undefined。
   */
  pickNextEditForPath(
    conversationId: string,
    path: string
  ): QueuedEditDispatch | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    const normalizedPath = (path || "").trim()
    if (!normalizedPath) return undefined

    if (session.editPathHolderByPath.has(normalizedPath)) {
      // 上一持有者尚未释放，调用方应等待。
      return undefined
    }

    const queue = session.editPathQueueByPath.get(normalizedPath)
    if (!queue || queue.length === 0) {
      session.editPathQueueByPath.delete(normalizedPath)
      return undefined
    }

    const next = queue.shift()!
    if (queue.length === 0) {
      session.editPathQueueByPath.delete(normalizedPath)
    }
    session.editPathHolderByPath.set(normalizedPath, next.toolCallId)
    return next
  }

  /**
   * 释放某个 toolCallId 对 path 串行槽的占用，并把它从所有等待队列中剥离。
   *
   * 由 detachPendingToolCall 在出口调用，覆盖 consume / clear / 异常 三类路径。
   */
  private clearEditPathSlot(
    session: ChatSession,
    toolCall: PendingToolCall
  ): void {
    const path = toolCall.editPath?.trim()
    if (!path) {
      // 即使没有 editPath，也把 toolCallId 从所有 queue 中扫一遍以防遗漏。
      // edit_file_v2 一定有 path，这里只是兜底。
      this.removeToolCallFromAllEditQueues(session, toolCall.toolCallId)
      return
    }

    const holder = session.editPathHolderByPath.get(path)
    if (holder === toolCall.toolCallId) {
      session.editPathHolderByPath.delete(path)
    }

    const queue = session.editPathQueueByPath.get(path)
    if (queue) {
      const filtered = queue.filter(
        (item) => item.toolCallId !== toolCall.toolCallId
      )
      if (filtered.length === 0) {
        session.editPathQueueByPath.delete(path)
      } else if (filtered.length !== queue.length) {
        session.editPathQueueByPath.set(path, filtered)
      }
    }
  }

  private removeToolCallFromAllEditQueues(
    session: ChatSession,
    toolCallId: string
  ): void {
    for (const [path, queue] of session.editPathQueueByPath) {
      const filtered = queue.filter((item) => item.toolCallId !== toolCallId)
      if (filtered.length === 0) {
        session.editPathQueueByPath.delete(path)
      } else if (filtered.length !== queue.length) {
        session.editPathQueueByPath.set(path, filtered)
      }
    }
    for (const [path, holderId] of session.editPathHolderByPath) {
      if (holderId === toolCallId) {
        session.editPathHolderByPath.delete(path)
      }
    }
  }

  /**
   * 批量清空所有 path 串行状态。仅用于 stale pending 整批回收场景
   * （旧 BiDi 流已关闭，pending 全部作废，holder 与 queue 都不再有意义）。
   */
  private clearAllEditPathSlots(session: ChatSession): void {
    session.editPathHolderByPath.clear()
    session.editPathQueueByPath.clear()
  }

  consumePendingToolCall(
    conversationId: string,
    toolCallId: string
  ): PendingToolCall | undefined {
    const session = this.getSession(conversationId)
    if (session) {
      const toolCall = this.detachPendingToolCall(session, toolCallId)
      if (toolCall) {
        // Settle this tool in the batch barrier so that continuation is only
        // triggered after ALL tools in the assistant turn have completed.
        this.settleAssistantToolBatchTool(conversationId, toolCallId)
        this.logger.debug(
          `Consumed tool call: ${toolCallId} for session ${conversationId}`
        )
        this.schedulePersist(conversationId)
        return toolCall
      }
    }
    return undefined
  }

  clearPendingToolCall(
    conversationId: string,
    toolCallId: string,
    reason?: string
  ): PendingToolCall | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    const toolCall = this.detachPendingToolCall(session, toolCallId)
    if (!toolCall) return undefined

    // Settle this tool in the batch barrier (same as consumePendingToolCall).
    this.settleAssistantToolBatchTool(conversationId, toolCallId)

    const reasonSuffix = reason ? ` (${reason})` : ""
    this.logger.warn(
      `Cleared pending tool call: ${toolCallId} for session ${conversationId}${reasonSuffix}`
    )
    this.schedulePersist(conversationId)
    return toolCall
  }

  registerPendingToolExecId(
    conversationId: string,
    toolCallId: string,
    execIdNumber: number
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return false

    const pending = session.pendingToolCalls.get(toolCallId)
    if (!pending) {
      this.logger.warn(
        `registerPendingToolExecId: pending tool call not found: ${toolCallId}`
      )
      return false
    }

    const normalizedExecId = Math.floor(execIdNumber)
    session.pendingToolCallByExecId.set(normalizedExecId, toolCallId)
    pending.execIds.add(normalizedExecId)
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Mapped execId=${normalizedExecId} -> toolCallId=${toolCallId} for session ${conversationId}`
    )
    this.schedulePersist(conversationId)
    return true
  }

  markPendingToolCallStarted(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    const pending = session.pendingToolCalls.get(toolCallId)
    if (!pending) return
    session.lastActivityAt = new Date()
    pending.startedEmitted = true
    this.schedulePersist(conversationId)
  }

  getPendingToolCallIdByExecId(
    conversationId: string,
    execIdNumber: number
  ): string | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return undefined
    return session.pendingToolCallByExecId.get(Math.floor(execIdNumber))
  }

  consumePendingToolCallByExecId(
    conversationId: string,
    execIdNumber: number
  ): PendingToolCall | undefined {
    const toolCallId = this.getPendingToolCallIdByExecId(
      conversationId,
      execIdNumber
    )
    if (!toolCallId) return undefined
    return this.consumePendingToolCall(conversationId, toolCallId)
  }

  /**
   * Clear all stale pending tool calls from a session.
   * Used when a new chat turn arrives on a fresh BiDi stream but old pending
   * tool calls from a previous (now-closed) stream are still lingering.
   * Returns the number of cleared entries.
   */
  clearStalePendingToolCalls(conversationId: string): number {
    const session = this.getSession(conversationId)
    if (!session || session.pendingToolCalls.size === 0) return 0

    const count = session.pendingToolCalls.size
    const clearedIds = Array.from(session.pendingToolCalls.keys())

    session.pendingToolCalls.clear()
    session.pendingToolCallByExecId.clear()
    // Also clear the batch barrier — all pending tools are being discarded.
    session.activeAssistantToolBatch = undefined
    // Drop every path-level edit serialization slot. The pending tool calls
    // tied to the old BiDi stream are gone, so the holders/queues that
    // referenced them must not survive into the next turn.
    this.clearAllEditPathSlots(session)
    session.lastActivityAt = new Date()

    this.logger.warn(
      `Cleared ${count} stale pending tool call(s) for session ${conversationId}: ${clearedIds.join(", ")}`
    )
    this.schedulePersist(conversationId)
    return count
  }

  /**
   * Rotate the stream ID for a session. Returns the new stream ID.
   * Called when a new BiDi stream is established for an existing conversation.
   */
  rotateStreamId(conversationId: string): string {
    const session = this.getSession(conversationId)
    if (!session) return ""
    const newId = crypto.randomUUID()
    const oldId = session.currentStreamId
    session.currentStreamId = newId
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Rotated streamId for ${conversationId}: ${oldId.substring(0, 8)} -> ${newId.substring(0, 8)}`
    )
    this.schedulePersist(conversationId)
    return newId
  }

  getCurrentStreamId(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.currentStreamId
  }

  isCurrentStream(conversationId: string, streamId: string): boolean {
    if (!streamId) return false
    const session = this.getSession(conversationId)
    if (!session) return false
    return session.currentStreamId === streamId
  }

  /**
   * Rebind pending tool calls to the current stream ID.
   * This is used when a stream reconnects (e.g. resumeAction) and the tool results
   * will arrive on the new stream.
   * Returns the number of rebound entries.
   */
  rebindPendingToolCallsToCurrentStream(conversationId: string): number {
    const session = this.getSession(conversationId)
    if (!session || session.pendingToolCalls.size === 0) return 0

    const currentStreamId = session.currentStreamId
    let reboundCount = 0

    for (const [_, pending] of session.pendingToolCalls) {
      if (pending.streamId !== currentStreamId) {
        pending.streamId = currentStreamId
        reboundCount++
      }
    }

    if (reboundCount > 0) {
      this.schedulePersist(conversationId)
    }

    return reboundCount
  }

  /**
   * Register an InteractionQuery, returns {id, promise}
   * The promise resolves when the client replies with an InteractionResponse
   */
  registerInteractionQuery(
    conversationId: string,
    queryType: string,
    payload?: Record<string, unknown>
  ): { id: number; promise: Promise<any> } {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }

    session.interactionQueryId++
    const queryId = session.interactionQueryId

    let resolve!: (response: any) => void
    let reject!: (error: Error) => void
    const promise = new Promise<any>((res, rej) => {
      resolve = res
      reject = rej
    })

    session.pendingInteractionQueries.set(queryId, {
      resolve,
      reject,
      queryType,
      payload,
    })
    session.lastActivityAt = new Date()

    this.logger.log(
      `Registered InteractionQuery id=${queryId} type=${queryType} for ${conversationId}`
    )

    this.schedulePersist(conversationId)
    return { id: queryId, promise }
  }

  /**
   * Parse InteractionResponse and resolve the corresponding pending query
   */
  resolveInteractionQuery(
    conversationId: string,
    queryId: number,
    response: any
  ): { queryType: string; payload?: Record<string, unknown> } | null {
    const session = this.getSession(conversationId)
    if (!session) {
      this.logger.warn(
        `resolveInteractionQuery: session not found ${conversationId}`
      )
      return null
    }

    const pending = session.pendingInteractionQueries.get(queryId)
    if (!pending) {
      this.logger.warn(
        `resolveInteractionQuery: no pending query id=${queryId}`
      )
      return null
    }

    this.logger.log(
      `Resolve InteractionQuery id=${queryId} type=${pending.queryType}`
    )
    pending.resolve(response)
    session.pendingInteractionQueries.delete(queryId)
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return {
      queryType: pending.queryType,
      payload: pending.payload,
    }
  }

  /**
   * Get session
   */
  getSession(conversationId: string): ChatSession | undefined {
    return (
      this.sessions.get(conversationId) ||
      this.loadPersistedSession(conversationId)
    )
  }

  /**
   * List currently in-memory session ids along with a small bundle of
   * activity / token metadata so the dashboard can offer a "compact this
   * session" picker.  Persisted-but-not-loaded sessions are intentionally
   * skipped — bringing them into memory would happen anyway when the
   * dashboard issues a manual compaction request, and listing every
   * historical session would bloat the response.
   */
  listSessionSummaries(): Array<{
    conversationId: string
    model: string
    messageCount: number
    transcriptRecordCount: number
    activeCompactionId?: string
    compactionEpoch: number
    lastActivityAt: string
  }> {
    const summaries: Array<
      ReturnType<ChatSessionManager["buildSessionSummary"]>
    > = []
    for (const [conversationId, session] of this.sessions) {
      summaries.push(this.buildSessionSummary(conversationId, session))
    }
    summaries.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime()
    )
    return summaries
  }

  private buildSessionSummary(
    conversationId: string,
    session: ChatSession
  ): {
    conversationId: string
    model: string
    messageCount: number
    transcriptRecordCount: number
    activeCompactionId?: string
    compactionEpoch: number
    lastActivityAt: string
  } {
    return {
      conversationId,
      model: session.model || "",
      messageCount: session.messages.length,
      transcriptRecordCount: session.messageRecords.length,
      activeCompactionId: session.contextState.activeCompactionId,
      compactionEpoch: session.contextState.compactionEpoch ?? 0,
      lastActivityAt: session.lastActivityAt.toISOString(),
    }
  }

  /**
   * Delete session
   */
  deleteSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (session) {
      session.pendingInteractionQueries.clear()
      this.onSessionCleanupHandler?.(conversationId, session)
    }
    this.clearScheduledPersist(conversationId)
    this.sessions.delete(conversationId)
    this.deletePersistedSession(conversationId)
    this.deleteToolResultStorage(conversationId)
    this.logger.log(`Deleted session: ${conversationId}`)
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now()
    let cleanedCount = 0

    for (const [conversationId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() <= this.SESSION_TIMEOUT) {
        continue
      }

      const hasPendingWork =
        session.pendingToolCalls.size > 0 ||
        session.pendingInteractionQueries.size > 0
      if (hasPendingWork) {
        this.logger.debug(
          `Skipping cleanup for session ${conversationId}: pendingToolCalls=${session.pendingToolCalls.size}, pendingInteractionQueries=${session.pendingInteractionQueries.size}`
        )
        continue
      }

      this.clearScheduledPersist(conversationId)
      this.onSessionCleanupHandler?.(conversationId, session)
      this.sessions.delete(conversationId)
      cleanedCount++
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} expired session(s)`)
    }
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number
    activeSessions: number
    oldestSession: Date | null
  } {
    const now = Date.now()
    let activeSessions = 0
    let oldestSession: Date | null = null

    for (const session of this.sessions.values()) {
      if (
        now - session.lastActivityAt.getTime() <
        this.ACTIVE_SESSION_WINDOW_MS
      ) {
        activeSessions++
      }
      if (!oldestSession || session.createdAt < oldestSession) {
        oldestSession = session.createdAt
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      oldestSession,
    }
  }

  recordCompletedToolCall(
    conversationId: string,
    toolCall: Pick<PendingToolCall, "toolName" | "toolFamilyHint" | "sentAt">
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const durationMs = Math.max(0, Date.now() - toolCall.sentAt.getTime())
    session.toolMetrics.completedCalls += 1
    session.toolMetrics.totalDurationMs += durationMs
    session.toolMetrics.lastCompletedAt = Date.now()

    switch (this.classifyToolCall(toolCall)) {
      case "shell":
        session.toolMetrics.shellCalls += 1
        break
      case "edit":
        session.toolMetrics.editCalls += 1
        break
      case "mcp":
        session.toolMetrics.mcpCalls += 1
        break
      default:
        session.toolMetrics.otherCalls += 1
        break
    }

    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  getAnalyticsSummary(limit = 12): ChatSessionAnalyticsSummary {
    const now = Date.now()
    const sessions = new Map<
      string,
      {
        session: ChatSession
        loaded: boolean
      }
    >()

    for (const [conversationId, session] of this.sessions.entries()) {
      sessions.set(conversationId, { session, loaded: true })
    }

    if (this.persistence.isReady) {
      try {
        const stmt = this.persistence.prepare(
          `SELECT conversation_id, state_json
             FROM cursor_sessions
            ORDER BY last_activity_at DESC`
        ) as unknown as {
          all?: () => Array<{ conversation_id: string; state_json: string }>
        }
        const rows = typeof stmt.all === "function" ? stmt.all() : []
        for (const row of rows) {
          if (!row?.conversation_id || sessions.has(row.conversation_id)) {
            continue
          }
          try {
            const persisted = JSON.parse(
              row.state_json
            ) as PersistedChatSessionV1
            sessions.set(row.conversation_id, {
              session: this.deserializeSession(persisted),
              loaded: false,
            })
          } catch (error) {
            this.logger.warn(
              `Failed to deserialize analytics session ${row.conversation_id}: ${String(error)}`
            )
          }
        }
      } catch (error) {
        this.logger.warn(
          `Failed to load persisted session analytics: ${String(error)}`
        )
      }
    }

    const entries = Array.from(sessions.entries())
      .map(([conversationId, value]) =>
        this.buildAnalyticsEntry(
          conversationId,
          value.session,
          value.loaded,
          now
        )
      )
      .sort(
        (left, right) =>
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
      )

    let lastActivityAt: string | null = null
    let activeSessions = 0
    let loadedSessions = 0
    let pendingToolCalls = 0
    let completedToolCalls = 0
    let totalToolDurationMs = 0
    let readFiles = 0
    let editedFiles = 0
    let linesAdded = 0
    let linesRemoved = 0

    for (const entry of entries) {
      if (entry.active) activeSessions++
      if (entry.loaded) loadedSessions++
      pendingToolCalls += entry.pendingToolCalls
      completedToolCalls += entry.completedToolCalls
      totalToolDurationMs += entry.totalToolDurationMs
      readFiles += entry.readFiles
      editedFiles += entry.editedFiles
      linesAdded += entry.linesAdded
      linesRemoved += entry.linesRemoved
      if (
        !lastActivityAt ||
        Date.parse(entry.lastActivityAt) > Date.parse(lastActivityAt)
      ) {
        lastActivityAt = entry.lastActivityAt
      }
    }

    return {
      timestamp: new Date(now).toISOString(),
      totals: {
        totalSessions: entries.length,
        activeSessions,
        loadedSessions,
        persistedOnlySessions: Math.max(0, entries.length - loadedSessions),
        pendingToolCalls,
        completedToolCalls,
        totalToolDurationMs,
        avgToolDurationMs:
          completedToolCalls > 0
            ? Math.round((totalToolDurationMs / completedToolCalls) * 10) / 10
            : null,
        readFiles,
        editedFiles,
        linesAdded,
        linesRemoved,
        lastActivityAt,
      },
      sessions: entries.slice(0, Math.max(1, limit)),
    }
  }

  // ── Sub-Agent Context helpers ──────────────────────────
  //
  // Multi-foreground-subagent model. When the parent agent dispatches
  // several `task` tool calls in the same batch (cf.
  // `dispatchPreparedToolBatch`), each one spins its own
  // {@link SubAgentContext} state machine. We key them by `subagentId`
  // and resolve via toolCallId at the BiDi boundary because the IDE
  // routes ExecClientMessage results by execId/toolCallId, not by
  // sub-agent.

  /**
   * Register or replace a sub-agent context. Replacement only happens
   * when the same `subagentId` re-runs (defensive — the executor
   * recreates a context after an aborted turn). Different sub-agents
   * coexist as separate map entries.
   */
  setSubAgentContext(conversationId: string, context: SubAgentContext): void {
    const session = this.getSession(conversationId)
    if (session) {
      session.subAgentContexts.set(context.subagentId, context)
      session.lastActivityAt = new Date()
      this.logger.log(
        `Set SubAgentContext for ${conversationId}: subagentId=${context.subagentId}, parentToolCallId=${context.parentToolCallId} (active=${session.subAgentContexts.size})`
      )
      this.schedulePersist(conversationId)
    }
  }

  /**
   * Look up an active sub-agent by subagentId. Returns undefined when
   * the sub-agent has already settled / been cleared. Prefer this when
   * the caller already has the subagentId in scope (e.g. inside the
   * executor's own loop) — the toolCallId fallback is for BiDi-boundary
   * routing where only the protocol-level identifier is available.
   */
  getSubAgentContextById(
    conversationId: string,
    subagentId: string
  ): SubAgentContext | undefined {
    return this.getSession(conversationId)?.subAgentContexts.get(subagentId)
  }

  /**
   * Resolve a sub-agent from a tool call id. Matches in this order:
   *   1. parentToolCallId — the `task` envelope itself
   *   2. pendingToolCallIds — inner tool calls owned by the sub-agent
   *   3. currentTurnToolCalls — pre-dispatch entries that have not yet
   *      registered as pending (race window between LLM emit and
   *      registerPreparedToolInvocation)
   * Returns the first match; in practice toolCallIds are unique across
   * sub-agents in the same session because each sub-agent's LLM
   * generates fresh ids.
   */
  getSubAgentContextByToolCallId(
    conversationId: string,
    toolCallId: string
  ): SubAgentContext | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined
    for (const ctx of session.subAgentContexts.values()) {
      if (ctx.parentToolCallId === toolCallId) return ctx
      if (ctx.pendingToolCallIds.has(toolCallId)) return ctx
      if (ctx.currentTurnToolCalls.some((tc) => tc.id === toolCallId)) {
        return ctx
      }
    }
    return undefined
  }

  /**
   * List every sub-agent currently attached to the session. Used by
   * analytics / context attachment building / shutdown sweeps that want
   * to enumerate everything live.
   */
  listSubAgentContexts(conversationId: string): SubAgentContext[] {
    const session = this.getSession(conversationId)
    if (!session) return []
    return Array.from(session.subAgentContexts.values())
  }

  /**
   * Internal helper used by analytics / restart-recovery serialization
   * to sum a numeric field across every active sub-agent. Callers used
   * to read `session.subAgentContext?.<field> ?? 0` from the singleton;
   * with the multi-context model that becomes a per-conversation sum.
   */
  private sumSubAgentMetric(
    session: ChatSession,
    field: "turnCount" | "toolCallCount"
  ): number {
    let total = 0
    for (const ctx of session.subAgentContexts.values()) {
      total += ctx[field]
    }
    return total
  }

  /**
   * Persistence helper: project a runtime SubAgentContext into the
   * shape we write to disk. Centralised so serializeSession can map
   * over `subAgentContexts.values()` without repeating the field-by-
   * field copy.
   */
  private persistSubAgentContext(
    ctx: SubAgentContext
  ): PersistedSubAgentContext {
    return {
      parentToolCallId: ctx.parentToolCallId,
      parentModelCallId: ctx.parentModelCallId,
      subagentId: ctx.subagentId,
      messages: ctx.messages,
      model: ctx.model,
      tools: ctx.tools,
      accumulatedText: ctx.accumulatedText,
      pendingToolCallIds: Array.from(ctx.pendingToolCallIds),
      startTime: ctx.startTime,
      turnCount: ctx.turnCount,
      toolCallCount: ctx.toolCallCount,
      modifiedFiles: [...ctx.modifiedFiles],
      isBackground: ctx.isBackground,
      backgroundedAt: ctx.backgroundedAt,
      currentTurnToolCalls: ctx.currentTurnToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      })),
      expectedToolCallIds: Array.from(ctx.expectedToolCallIds),
      allowedWorkspaceRoots: ctx.allowedWorkspaceRoots
        ? [...ctx.allowedWorkspaceRoots]
        : undefined,
    }
  }

  /**
   * Mark a specific foreground sub-agent as backgrounded. The caller
   * must supply the parent task tool call id (or subagent id) so we
   * disambiguate when several sub-agents are active. Returns the
   * mutated context on success or undefined when the lookup misses
   * (e.g. tool call already settled).
   */
  markSubAgentBackgrounded(
    conversationId: string,
    toolCallId?: string
  ): SubAgentContext | undefined {
    const session = this.getSession(conversationId)
    if (!session || session.subAgentContexts.size === 0) return undefined

    const normalizedToolCallId = toolCallId?.trim()
    let ctx: SubAgentContext | undefined

    if (normalizedToolCallId) {
      // Try parent / subagent / pending lookup. Match what the model
      // is most likely to have referenced when emitting the
      // backgroundSubagentAction.
      ctx =
        this.getSubAgentContextByToolCallId(
          conversationId,
          normalizedToolCallId
        ) ?? session.subAgentContexts.get(normalizedToolCallId)
      if (!ctx) return undefined
    } else if (session.subAgentContexts.size === 1) {
      // No id supplied and exactly one foreground sub-agent active —
      // the legacy single-context call site. Pick it.
      ctx = session.subAgentContexts.values().next().value
    } else {
      // Ambiguous: don't background-mark a random sub-agent; force the
      // caller to disambiguate.
      this.logger.warn(
        `markSubAgentBackgrounded: ambiguous request for ${conversationId} ` +
          `(${session.subAgentContexts.size} sub-agents active, no toolCallId provided)`
      )
      return undefined
    }
    if (!ctx) return undefined

    ctx.isBackground = true
    ctx.backgroundedAt = Date.now()
    session.lastActivityAt = new Date()
    this.logger.log(
      `Marked SubAgentContext backgrounded for ${conversationId}: subagentId=${ctx.subagentId}, parentToolCallId=${ctx.parentToolCallId}`
    )
    this.schedulePersist(conversationId)
    return ctx
  }

  /**
   * Remove a single sub-agent's context. Other concurrent sub-agents
   * remain untouched. Pass `undefined` only as a defensive escape hatch
   * when the caller does not know the id; it clears all active
   * contexts and logs a warning.
   */
  clearSubAgentContext(conversationId: string, subagentId?: string): void {
    const session = this.getSession(conversationId)
    if (!session) return

    if (subagentId === undefined) {
      if (session.subAgentContexts.size === 0) return
      const ids = Array.from(session.subAgentContexts.keys())
      this.logger.warn(
        `clearSubAgentContext called without subagentId on ${conversationId}; ` +
          `clearing ${ids.length} active context(s): ${ids.join(", ")}`
      )
      session.subAgentContexts.clear()
      session.lastActivityAt = new Date()
      this.schedulePersist(conversationId)
      return
    }

    if (!session.subAgentContexts.delete(subagentId)) return
    session.lastActivityAt = new Date()
    this.logger.log(
      `Cleared SubAgentContext for ${conversationId}: subagentId=${subagentId} (remaining=${session.subAgentContexts.size})`
    )
    this.schedulePersist(conversationId)
  }

  /**
   * Check whether a tool call belongs to any active sub-agent. Used by
   * BiDi handlers that need to decide whether to route an
   * ExecClientMessage to the sub-agent dispatch path.
   */
  isSubAgentToolCall(conversationId: string, toolCallId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    for (const ctx of session.subAgentContexts.values()) {
      if (ctx.pendingToolCallIds.has(toolCallId)) return true
    }
    return false
  }

  replaceMessages(conversationId: string, messages: SessionMessage[]): void {
    const session = this.getSession(conversationId)
    if (!session) return

    const sanitizedMessages = sanitizeMessagesForStorage(messages)
    if (
      sanitizedMessages.removedThinkingBlocks > 0 ||
      sanitizedMessages.droppedMessages > 0
    ) {
      this.logger.warn(
        `Write-time assistant sanitize (replaceMessages): removed ${sanitizedMessages.removedThinkingBlocks} invalid thinking block(s), ` +
          `dropped ${sanitizedMessages.droppedMessages} empty assistant message(s)`
      )
    }

    const pendingToolUseIds = Array.from(session.pendingToolCalls.keys())

    // Write-time validation: enforce tool protocol integrity before storing
    const guardResult = enforceToolProtocol(
      sanitizedMessages.messages as Array<{
        role: "user" | "assistant"
        content: unknown
      }>,
      {
        mode: "global",
        pendingToolUseIds,
      }
    )
    if (guardResult.changed) {
      this.logger.warn(
        `Write-time integrity repair (replaceMessages): injected ${guardResult.injectedToolResults} synthetic tool_result, ` +
          `removed ${guardResult.removedToolResults} orphan tool_result, ` +
          `${guardResult.removedEmptyMessages} empty messages`
      )
    }
    const normalizedMessages = guardResult.messages as SessionMessage[]
    const reconciledRecords = this.reconcileMessageRecords(
      session.messageRecords,
      normalizedMessages
    )
    const previousContextRecords = session.contextState.records
    const previousUsageAnchor = session.contextState.usageLedger.anchorRecordId
    session.messages = normalizedMessages
    session.messageRecords = reconciledRecords
    if (
      this.isContextStateCompatible(
        session.contextState,
        reconciledRecords,
        previousContextRecords
      )
    ) {
      this.syncContextRecordsFromMessageRecords(
        session.contextState,
        reconciledRecords
      )
      const lastApplied = session.contextState.lastAppliedCompaction
      if (lastApplied) {
        session.contextState.lastAppliedCompaction = {
          ...lastApplied,
          recordCount: session.contextState.records.length,
        }
      }
      if (
        !this.shouldRetainUsageLedger(
          session.contextState,
          reconciledRecords,
          previousContextRecords
        )
      ) {
        session.contextState.usageLedger = {}
        this.logger.log(
          `Invalidated context usage ledger for ${conversationId} after transcript rewrite before anchor ${previousUsageAnchor}`
        )
      }
    } else {
      session.contextState = this.createContextState(reconciledRecords)
      this.logger.log(
        `Reset context compaction state for ${conversationId} after transcript rewrite invalidated archived context`
      )
    }
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  getContextState(
    conversationId: string
  ): ContextConversationState | undefined {
    return this.getSession(conversationId)?.contextState
  }

  markContextStateDirty(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.lastActivityAt = new Date()
    this.syncContextRecordsFromMessageRecords(
      session.contextState,
      session.messageRecords
    )
    this.schedulePersist(conversationId)
  }

  /**
   * Add a workspace root to the session's `additionalRoots` map.
   *
   * Mirrors claude-code's `addDirectories` permission update — the
   * IDE's `projectContext.workspaceFolders` are the primary source
   * of truth, and this map carries roots that come in through other
   * channels (REST API, `.cursor/agent-vibes.json` config). Once
   * added, sub-agent inline tools can read/grep/list files inside
   * the new root the same way they handle the IDE-pushed ones.
   *
   * Dedup key is the resolved absolute path (post `realpathSync` +
   * macOS `/private` collapse), so two different relative paths
   * pointing at the same dir merge into one entry. When an entry
   * already exists, the higher-priority source wins:
   * `'config'` > `'session'` (config is project-level intent;
   * session is per-conversation user action). Equal-priority
   * re-adds refresh `addedAt` and keep the original `rawPath`.
   *
   * Returns the resolved entry that's now in the map, or `null`
   * when the input path could not be resolved (caller surfaces a
   * 400 in the REST handler).
   */
  addAdditionalWorkspaceRoot(
    conversationId: string,
    rawPath: string,
    source: "session" | "config"
  ): AdditionalWorkspaceRoot | null {
    const session = this.getSession(conversationId)
    if (!session) return null
    const trimmedRaw = (rawPath || "").trim()
    if (!trimmedRaw) return null
    const resolved = normalizePathForBoundaryCheck(trimmedRaw)
    if (!resolved) return null

    if (!session.additionalRoots) {
      session.additionalRoots = new Map()
    }
    const existing = session.additionalRoots.get(resolved)
    const priority: Record<"session" | "config", number> = {
      session: 1,
      config: 2,
    }
    if (existing && priority[existing.source] > priority[source]) {
      return existing
    }
    const entry: AdditionalWorkspaceRoot = {
      path: resolved,
      rawPath: trimmedRaw,
      source,
      addedAt: Date.now(),
    }
    session.additionalRoots.set(resolved, entry)
    this.markContextStateDirty(conversationId)
    return entry
  }

  /**
   * Remove a workspace root from the session's `additionalRoots`.
   *
   * `'config'` source entries CAN be removed at runtime — they will
   * be re-added on the next session creation by the bridge config
   * loader, so the runtime delete is effectively a session-scoped
   * mute. The user can permanently remove a config root by editing
   * `.cursor/agent-vibes.json`.
   *
   * Returns `true` when an entry was actually removed.
   */
  removeAdditionalWorkspaceRoot(
    conversationId: string,
    rawPath: string
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session?.additionalRoots) return false
    const trimmedRaw = (rawPath || "").trim()
    if (!trimmedRaw) return false
    const resolved = normalizePathForBoundaryCheck(trimmedRaw)
    if (!resolved) return false
    const existed = session.additionalRoots.delete(resolved)
    if (existed) {
      this.markContextStateDirty(conversationId)
    }
    return existed
  }

  /**
   * List the resolved set of allowed workspace roots for a session.
   *
   * Combines `projectContext.rootPath`, IDE-pushed
   * `projectContext.workspaceFolders`, and `additionalRoots` into a
   * single ordered, dedup'd list of absolute paths. The boundary
   * check (`isPathWithinAllowedRoots`) and sub-agent system-prompt
   * injection both consume this list — keeping the union centralized
   * means the two stay in lockstep.
   */
  listAllowedWorkspaceRoots(conversationId: string): string[] {
    const session = this.getSession(conversationId)
    if (!session) return []
    return resolveAllowedWorkspaceRoots({
      rootPath: session.projectContext?.rootPath,
      workspaceFolders: session.projectContext?.workspaceFolders,
      additionalRoots: session.additionalRoots,
    })
  }

  /**
   * Inspect the additional-roots map directly. Used by REST
   * handlers to render `{ session: [...], config: [...] }` for
   * dashboards. Returns a plain array snapshot so callers can't
   * mutate session state.
   */
  getAdditionalWorkspaceRoots(
    conversationId: string
  ): AdditionalWorkspaceRoot[] {
    const session = this.getSession(conversationId)
    if (!session?.additionalRoots) return []
    return Array.from(session.additionalRoots.values())
  }

  /**
   * Load project-level extra working directories from
   * `.cursor/agent-vibes.json`. Supported keys:
   * `additionalWorkingDirectories` (preferred) and `extraRoots`
   * (legacy alias). Relative paths are resolved against the primary
   * workspace root from the IDE-synced project context.
   */
  private loadConfiguredAdditionalRoots(session: ChatSession): void {
    if (session.configuredAdditionalRootsLoaded) return
    const workspaceRoot = session.projectContext?.rootPath
    if (!workspaceRoot) return
    session.configuredAdditionalRootsLoaded = true

    const configPath = path.join(workspaceRoot, ".cursor", "agent-vibes.json")
    if (!fs.existsSync(configPath)) return

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf8"))
    } catch (error) {
      this.logger.warn(
        `Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }

    const record =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {}
    const configured = [
      ...(Array.isArray(record.additionalWorkingDirectories)
        ? (record.additionalWorkingDirectories as unknown[])
        : []),
      ...(Array.isArray(record.extraRoots)
        ? (record.extraRoots as unknown[])
        : []),
    ]

    for (const raw of configured) {
      if (typeof raw !== "string" || raw.trim().length === 0) continue
      const rawPath = raw.trim()
      const absPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(workspaceRoot, rawPath)
      const resolved = normalizePathForBoundaryCheck(absPath)
      if (!resolved) continue
      if (!session.additionalRoots) {
        session.additionalRoots = new Map()
      }
      const existing = session.additionalRoots.get(resolved)
      if (existing?.source === "session") continue
      session.additionalRoots.set(resolved, {
        path: resolved,
        rawPath,
        source: "config",
        addedAt: Date.now(),
      })
    }
  }

  getInvestigationMemory(
    conversationId: string
  ): ContextInvestigationMemoryEntry[] {
    const session = this.getSession(conversationId)
    if (!session) return []
    return session.contextState.investigationMemory.map((entry) => ({
      ...entry,
      toolCallIds: [...entry.toolCallIds],
    }))
  }

  getInvestigationMemoryAttachmentSnapshot(
    conversationId: string
  ): InvestigationMemorySummaryLike[] {
    return this.getInvestigationMemory(conversationId).map((entry) => ({
      label: entry.label,
      details: entry.details,
      toolCount: entry.toolCount,
      readOnly: entry.readOnly,
      createdAt: entry.createdAt,
    }))
  }

  replaceInvestigationMemory(
    conversationId: string,
    entries: ContextInvestigationMemoryEntry[]
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.contextState.investigationMemory = entries.map((entry) => ({
      ...entry,
      toolCallIds: [...entry.toolCallIds],
    }))
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  clearInvestigationMemory(conversationId: string): void {
    this.replaceInvestigationMemory(conversationId, [])
  }

  appendInvestigationMemory(
    conversationId: string,
    entry: ContextInvestigationMemoryEntry,
    limit: number
  ): ContextInvestigationMemoryEntry[] {
    const next = [...this.getInvestigationMemory(conversationId), entry].slice(
      -Math.max(1, limit)
    )
    this.replaceInvestigationMemory(conversationId, next)
    return next
  }

  recordAssistantResponseUsage(
    conversationId: string,
    recordId: string,
    usage: ContextUsageSnapshot,
    usageLedgerState?: ContextUsageLedgerState
  ): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.contextState.usageLedger = usageLedgerState || {
      anchorRecordId: recordId,
      lastUsage: usage,
    }
    const inputContextTokens =
      usage.inputTokens +
      usage.cachedInputTokens +
      usage.cacheCreationInputTokens
    session.usedTokens = inputContextTokens
    session.usedContextTokens = inputContextTokens
    session.pendingRequestContextLedger = undefined
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  replaceTodos(conversationId: string, todos: SessionTodoItem[]): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.todos = todos
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }

  nextExecId(conversationId: string): number {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    const next = session.execId++
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return next
  }

  incrementStepId(conversationId: string): number {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    session.stepId++
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return session.stepId
  }

  getRestartRecovery(
    conversationId: string
  ): SessionRestartRecovery | undefined {
    return this.getSession(conversationId)?.restartRecovery
  }

  clearRestartRecovery(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    session.restartRecovery = undefined
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }
}
