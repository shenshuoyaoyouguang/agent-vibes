import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import { AssistantToolBatchService } from "./assistant-tool-batch.service"
import { ContextStateService } from "./context-state.service"
import { SessionStreamService } from "./session-stream.service"
import { TurnId, ConversationId } from "../turn/turn.types"
import { MessageStore } from "./message-store.service"
import { SessionPersistenceService } from "./session-persistence.service"
import { ToolCallLedger } from "./tool-call-ledger.service"
import {
  normalizePathForBoundaryCheck,
  resolveAllowedWorkspaceRoots,
} from "./workspace-root-resolver"
import type {
  ContextCompactionCommit,
  ContextCollapseCommit,
  ContextCollapseState,
  ContextConversationState,
  CodexContextState,
  ContextInvestigationMemoryEntry,
  ContextSessionMemoryEntry,
  ContextTranscriptRecord,
  ContextUsageSnapshot,
  LooseMessageContent,
} from "../../../context/types"
import {
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "../../../context/types"
import {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  deriveCompactionHistoryFromTranscript,
  getActiveCompactCommitFromTranscript,
  isContextCollapseSummaryRecord,
  isMessageRecord,
  isSnipBoundaryRecord,
  stripInternalContextEvents,
} from "../../../context/context-transcript-events"
import { ToolResultStorageService } from "../../../context/tool-result-storage.service"
import type {
  BackendType,
  ModelRouteResult,
} from "../../../llm/shared/model-router.service"
import { PersistenceService } from "../../../persistence"
import { ParsedCursorRequest } from "../tools/cursor-request-parser"
import {
  EMPTY_SUBAGENT_MODEL_OVERRIDES,
  type SubagentModelOverridesMap,
} from "../subagents/subagent-model-override"
import type {
  DeferredToolDescriptor,
  ToolDefinition,
} from "../tools/cursor-tool-mapper"
import type { EditFailureSelection } from "../tools/tool-protocol-helpers"
import type {
  PendingToolExecutionState,
  ToolExecutionOwner,
  ToolExecutionRecoveryReason,
  ToolExecutionStatus,
} from "./tool-execution-types"
// CursorTurnState type is declared at the bottom of this file
// (inlined from the deleted cursor-turn-state.ts module).
import { type SessionTaskBudgetState } from "./task-budget-state"
import {
  normalizeToolInterruptionReason,
  type ToolInterruptionReason,
} from "./tool-interruption"

export interface ClearSessionCacheResult {
  clearedLoadedSessions: number
  clearedPersistedSessions: number
  clearedToolResultDirs: number
  warnings: string[]
}

/**
 * Content block types for messages
 */
export type MessageContent = LooseMessageContent

/**
 * Mirrors claude-code/src/services/api/claude.ts AssistantMessage / UserMessage:
 * `{type, uuid, timestamp, message: {...}}`. A streaming assistant turn yields
 * one of these per content block (split-sibling — same `message.id`, distinct
 * `uuid`); send-time normalization merges siblings by `message.id`. See
 * /Users/recronin/.claude/plans/think-users-recronin-repositories-vscod-hashed-chipmunk.md.
 */
export interface SessionAssistantMessage {
  type: "assistant"
  uuid: string
  timestamp: string
  /** Backend request id, when available (Anthropic only). */
  requestId?: string
  message: {
    /** Anthropic message id — split-sibling merge key. Undefined for legacy
     *  rows or non-Anthropic backends that have no notion of message ids. */
    id?: string
    role: "assistant"
    content: MessageContent
    /** Filled by `mutateLastAssistantUsage` on `message_delta`. */
    usage?: ContextUsageSnapshot
    stop_reason?: string | null
    model?: string
  }
  isApiErrorMessage?: boolean
}

export interface SessionUserMessage {
  type: "user"
  uuid: string
  timestamp: string
  message: {
    role: "user"
    content: MessageContent
  }
  /** cc-style isMeta — message contributed for context plumbing only,
   *  hidden from the IDE-facing transcript. */
  isMeta?: boolean
  /** Tool execution payload attached for the duration of the originating
   *  turn; cleared at the next iteration to avoid memory growth. Mirrors
   *  cc query.ts:530-538. */
  toolUseResult?: unknown
}

export type SessionMessage = SessionAssistantMessage | SessionUserMessage

/**
 * Distributive `Omit<SessionMessage, "uuid" | "timestamp">`. Plain
 * `Omit` over a union narrows to the intersection of fields, which
 * silently drops user-only props like `toolUseResult` / `isMeta`. This
 * variant preserves the per-arm shape so callers can build a
 * SessionUserMessage init object that still carries those fields.
 */
export type SessionMessageInit = SessionMessage extends infer T
  ? T extends SessionMessage
    ? Omit<T, "uuid" | "timestamp">
    : never
  : never

/**
 * Convenience accessors so call sites that only need the legacy
 * `{role, content}` shape don't pay for full pattern-matching every time.
 */
export function getMessageRole(msg: SessionMessage): "user" | "assistant" {
  return msg.message.role
}
export function getMessageContent(msg: SessionMessage): MessageContent {
  return msg.message.content
}

/**
 * Capture an input array onto the session as a *frozen* cache-key value.
 *
 * Several per-turn caches in the upstream-facing pipeline (the
 * prepared-tool-build memo on `cursor-connect-stream.service`,
 * `applySendTimeSanitize` and `normalizeHistoryForBackend` per-turn
 * memos) use the captured array's reference identity as part of their
 * cache key.  If a caller later mutated the same array in place
 * (`push`, `splice`, …), the cache key would silently desynchronise
 * from the cached value.
 *
 * Freezing the captured copy turns any such mutation into a synchronous
 * `TypeError` instead of a silent stale-cache bug, which is the exact
 * defense-in-depth invariant we want.  We freeze a *copy* of the input
 * rather than the input itself so we don't mutate the caller's array
 * (callers may continue to mutate the array they passed in — they just
 * won't observe their writes through the session).
 *
 * The freeze is shallow.  Element-level mutation (e.g. editing an
 * `McpToolDef.input_schema`) would still desync the cache, but no
 * code path in the bridge mutates these descriptors after parser
 * construction, so the deep-freeze cost would not buy any extra
 * invariant.
 *
 * For optional fields, `undefined` flows through unchanged so callers
 * that distinguish "absent" from "empty" keep that distinction.
 */
export function freezeCacheKeyArray<T>(input: T[] | undefined): T[] | undefined
export function freezeCacheKeyArray<T>(
  input: T[] | undefined,
  fallback: T[]
): T[]
export function freezeCacheKeyArray<T>(
  input: T[] | undefined,
  fallback?: T[]
): T[] | undefined {
  if (input === undefined) {
    return fallback === undefined
      ? undefined
      : (Object.freeze([...fallback]) as unknown as T[])
  }
  return Object.freeze([...input]) as unknown as T[]
}

/**
 * Build a SessionMessage union member from a legacy `(role, content)` pair.
 * The streaming path will switch to passing pre-built `SessionAssistantMessage`
 * objects with a populated `message.id`; until then this factory keeps the
 * existing call sites working without leaking storage shape concerns to them.
 */
export function makeSessionMessage(
  role: "user" | "assistant",
  content: MessageContent,
  extras?: {
    /** Anthropic message id — used for split-sibling merge during send. */
    messageId?: string
    /** Pre-allocated uuid (falls back to crypto.randomUUID). */
    uuid?: string
    /** Pre-allocated ISO timestamp (falls back to now). */
    timestamp?: string
    /** Backend request id (Anthropic only). */
    requestId?: string
    isMeta?: boolean
    /** Raw tool execution payload — see SessionUserMessage.toolUseResult.
     *  Cleared on the next send via clearToolUseResultsBeforeNextSend
     *  (mirrors cc query.ts:530-538). */
    toolUseResult?: unknown
  }
): SessionMessage {
  const uuid = extras?.uuid ?? crypto.randomUUID()
  const timestamp = extras?.timestamp ?? new Date().toISOString()
  if (role === "assistant") {
    return {
      type: "assistant",
      uuid,
      timestamp,
      ...(extras?.requestId ? { requestId: extras.requestId } : {}),
      message: {
        ...(extras?.messageId ? { id: extras.messageId } : {}),
        role: "assistant",
        content,
      },
    }
  }
  return {
    type: "user",
    uuid,
    timestamp,
    ...(extras?.isMeta ? { isMeta: true } : {}),
    ...(extras?.toolUseResult !== undefined
      ? { toolUseResult: extras.toolUseResult }
      : {}),
    message: {
      role: "user",
      content,
    },
  }
}

/**
 * Storage layer keeps every block — including thinking — verbatim. Send-time
 * sanitization (per backend constraints) lives in
 * `apps/protocol-bridge/src/llm/shared/normalize-for-api.ts` and is invoked
 * from the buildMessages exits in cursor-connect-stream.service.ts.
 *
 * The previous write-time sanitize used to drop unsigned thinking blocks
 * before they reached the session, which made the original reasoning
 * unrecoverable. See plan
 * .claude/plans/think-users-recronin-repositories-vscod-hashed-chipmunk.md
 * for the rationale.
 */

/** Soft cap removed — reasoning continuity now lives in
 *  ReasoningMemoryService (apps/protocol-bridge/src/context/reasoning-memory.service.ts).
 *  See claude-code/src/utils/messages.ts:5501 stripSignatureBlocks for the
 *  upstream pattern this mirrors: single-shot string summary fields like
 *  `lastThinkingSummary` were never the right shape for cross-turn replay
 *  on backends that drop thinking blocks on the wire (kiro, codex). */

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
  reason: ToolInterruptionReason
  detail?: string
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

export interface SessionTopLevelAgentTurnState {
  llmTurnCount: number
  continuationBudget: SessionTopLevelContinuationBudget
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

export type SessionTranscriptEventKind =
  | "session_restored"
  | "snapshot_rewrite"
  | "snapshot_repair"
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"

export interface SessionTranscriptEvent {
  id: string
  seq: number
  kind: SessionTranscriptEventKind
  recordId?: string
  role?: "user" | "assistant"
  messageId?: string
  toolUseId?: string
  toolName?: string
  contentChars?: number
  createdAt: number
  turnId?: string
  summary?: string
}

/**
 * Cached output of `optimizeImplicitCodexTools` +
 * `buildToolsForApiWithDefer` for the active turn.
 *
 * The cursor stream service rebuilds this on every tool-result
 * continuation; the result is fully determined by a small set of inputs
 * (model → backend route, supportedTools, mcpToolDefs, useWeb,
 * discoveredTools size, project cwd, subagent set signature).  When all
 * those inputs are unchanged, every continuation in a turn produces a
 * byte-identical tools array, but the build path also performs
 * synchronous file IO via `SubagentRegistryService.getAll()` to scan
 * `~/.cursor/agents` and `<cwd>/.cursor/agents`.  Caching the result
 * keyed by the input snapshot lets us skip both the IO and the
 * provenance / defer-policy work on every round after the first.
 *
 * Lifetime is the session: cleared automatically when the session is
 * evicted, so there is no global retention concern.  Invalidation is
 * implicit — the cache lookup in the stream service compares the
 * stored key against the live one and falls through to recompute on
 * any drift.
 */
export interface SessionPreparedToolBuild {
  /** Snapshot of the inputs that fully determine the cached output. */
  key: {
    model: string
    backend: BackendType
    supportedToolsRef: string[]
    mcpToolDefsRef: ParsedCursorRequest["mcpToolDefs"] | undefined
    useWeb: boolean
    discoveredToolsSize: number
    projectCwd: string
    /**
     * Sorted-and-joined `agentType` list of every visible sub-agent for
     * the project cwd.  Used as a stable signature so a custom
     * `.cursor/agents` markdown definition being added or removed
     * mid-session invalidates the cache (the next continuation will
     * scan disk again).  We only stamp the list once per cache build
     * so the steady-state hit path stays IO-free.
     */
    subagentSignature: string
  }
  /** Resolved upstream backend + concrete model id. */
  route: ModelRouteResult
  /** Output of `optimizeImplicitCodexTools` (input to the defer split). */
  optimizedTools: string[]
  /** Tools array sent to the upstream this turn. */
  apiTools: ToolDefinition[]
  /** Deferred catalog advertised in the system prompt this turn. */
  deferred: DeferredToolDescriptor[]
}

/**
 * Chat session state for bidirectional streaming
 */
/**
 * Lifecycle-domain fields owned by SessionLifecycleService.
 *
 * Identity, configuration, persistence triggers, abort wiring and
 * the slow-changing per-request context (project / cursor rules /
 * supported tools). Everything in this slice has at most one writer
 * per turn — the lifecycle service.
 */
export interface SessionLifecycleRecord {
  conversationId: string
  model: string

  // Per-subagent model selection captured from
  // AgentRunRequest.subagent_model_overrides (proto field 20).
  subagentModelOverrides: SubagentModelOverridesMap

  thinkingLevel: number
  thinkingDetailsRequested: boolean
  isAgentic: boolean
  supportedTools: string[]
  discoveredTools: Set<string>
  deferredToolCatalog?: DeferredToolDescriptor[]
  preparedToolBuild?: SessionPreparedToolBuild
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  /** Browser MCP page state, used to gate page-dependent tool calls. */
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

  // Initial-request injected context.
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

  /** Additional workspace roots from session API + .cursor/agent-vibes.json. */
  additionalRoots?: Map<string, AdditionalWorkspaceRoot>
  configuredAdditionalRootsLoaded?: boolean

  /** Sub-agent context registry (foreground subagents only). */
  subAgentContexts: Map<string, SubAgentContext>

  /** Recovery notice for unrecoverable in-flight state after proxy restart. */
  restartRecovery?: SessionRestartRecovery

  /** Deferred control-frame continuations enqueued mid-turn. */
  deferredControlContinuations: Array<{
    parsed: ParsedCursorRequest
    newMessage: string
    streamId?: string
    reason: string
    enqueuedAt: number
  }>

  /** Last assistant model id seen — used by send-time thinking sanitize. */
  lastAssistantModel?: string
  /** Last assistant backend (anthropic / codex / google etc). */
  lastAssistantBackend?: BackendType
  lastToolUseSummary?: string

  /** @deprecated previous_response_id 现在由 CodexService transport state 管理 */
  lastCodexResponseId?: string
  /** @deprecated previous_response_id 现在由 CodexService.activeTurnContexts 管理 */
  lastCodexRequestSignature?: string
  /** @deprecated warmup payload 现在由 CodexService.warmupPayloadCache 管理 */
  lastCodexWarmupPayload?: Record<string, unknown>
  /** @deprecated previous_response_id 现在由 CodexService.activeTurnContexts 管理 */
  pendingCodexResponseId?: string
  /** @deprecated previous_response_id 现在由 CodexService.activeTurnContexts 管理 */
  pendingCodexRequestSignature?: string
}

/**
 * Context-state-domain fields owned by ContextStateService.
 *
 * Transcript, message records, transcript events, cursor turn state
 * machine, task budget, read paths / file states / tool metrics,
 * snip projection, investigation memory, per-session counters.
 */
export interface ContextStateRecord {
  /**
   * Live transcript array — aliases SessionLifecycleService's
   * `committedTranscripts` map slot for this conversation. Hot-path
   * length / at(-1) / [i] reads need no defensive copy.
   */
  messages: SessionMessage[]
  messagesGeneration: number
  messageRecords: ContextTranscriptRecord[]
  transcriptEvents: SessionTranscriptEvent[]
  nextTranscriptEventSeq: number
  contextState: ContextConversationState
  currentTurnState?: CursorTurnState
  recentTurnStates: CursorTurnState[]
  taskBudgetState?: SessionTaskBudgetState
  topLevelAgentTurnState: SessionTopLevelAgentTurnState
  lastEmittedContextSummaryCompactionId?: string
  lastEmittedContextSummaryCompactionEpoch?: number
  pendingContextSummaryUiUpdate?: {
    compactionId: string
    summary: string
    epoch: number
  }

  // Multi-turn checkpoint tracking.
  usedTokens: number
  readPaths: Set<string>
  readSnapshots: SessionReadSnapshot[]
  fileStates: Map<string, { beforeContent: string; afterContent: string }>
  toolMetrics: SessionToolMetrics
  messageBlobIds: string[]
  turns: string[]
  currentAssistantMessage?: Record<string, unknown>

  // Protocol counters.
  stepId: number
  execId: number

  /** Snip projection — message records hidden from the model view. */
  snipState?: SessionSnipState

  /** Pending request context ledger projection. */
  pendingRequestContextLedger?: {
    promptTokenCount: number
    recordedCompactionId?: string
    attachmentFingerprint?: string
  }

  /** Todo list owned by the session todo manager. */
  todos: SessionTodoItem[]
}

/**
 * Stream-domain fields owned by SessionStreamService.
 *
 * Background commands, edit-path queue, interaction queries, exec-id
 * mapping, current BiDi stream identifier.
 */
export interface SessionStreamRecord {
  backgroundCommands: Map<string, SessionBackgroundCommand>
  /** ExecServerMessage.id → toolCallId mapping for control messages. */
  pendingToolCallByExecId: Map<number, string>
  /** Current BiDi stream id (rotated on supersede). */
  currentStreamId: string

  /** Per-path edit serialisation: holder + queue. */
  editPathHolderByPath: Map<string, string>
  editPathQueueByPath: Map<string, QueuedEditDispatch[]>

  /** Active InteractionQuery entries awaiting client response. */
  pendingInteractionQueries: Map<
    number,
    {
      resolve: (response: any) => void
      reject: (error: Error) => void
      queryType: string
      payload?: Record<string, unknown>
      turnId?: TurnId
      kind?: string
      deadline?: number
      createdAt: number
    }
  >
  interactionQueryId: number
}

/**
 * The full SessionRecord is the union of the three domain record
 * slices. AssistantToolBatchService owns its state in its own
 * `Map<ConversationId, AssistantToolBatchRecord>` (not on this
 * object) so there is no fourth field block here.
 *
 * The intersection keeps a single physical record per conversation
 * for hot-path field reads while the three interfaces above declare
 * the domain ownership. Each service operates on its own record
 * type (SessionLifecycleRecord / ContextStateRecord /
 * SessionStreamRecord) but reads the same underlying object.
 *
 * `SessionRecord` (the legacy name) has been deleted; use
 * `SessionRecord` (or one of the three domain records) instead.
 */
/**
 * Step 4 物理拆终态: SessionRecord 等价于 SessionLifecycleRecord。
 * SessionLifecycleService.sessions 只持 lifecycle 域字段。
 * Context-state 域字段在 ContextStateService.contextRecords,
 * Stream 域字段在 SessionStreamService.streamRecords。
 * caller 必须用 contextState.getContextRecord(cid) /
 * sessionStream.getStreamRecord(cid) 才能拿到对应域字段;
 * 不再有"一个 session 对象包所有字段"的反模式。
 */
export type SessionRecord = SessionLifecycleRecord

export interface SessionSnipBoundary {
  id: string
  createdAt: number
  trigger: "model" | "user"
  reason?: string
  /** Record IDs that should be hidden from the model-facing projection. */
  removedRecordIds: string[]
  /** How many messages were live in ctx.messages when snip ran. */
  snippedMessageCount: number
}

export interface SessionSnipState {
  /** All snip boundaries in chronological order. */
  boundaries: SessionSnipBoundary[]
  /**
   * Union of removedRecordIds across every boundary, kept for O(1) projection
   * lookups during request build. Rebuilt whenever boundaries are mutated.
   */
  removedRecordIds: Set<string>
}

/**
 * Pending tool call ledger entry — what the bridge needs to remember
 * about a tool call so it can: (a) abort it on cancel, (b) match an
 * inbound tool_result back to its dispatcher, (c) synthesize a
 * recovery frame after a crash. Inlined from the deleted
 * `turn/pending-tool-store.ts` module.
 */
export interface PendingToolEntry<TPayload = unknown> {
  readonly conversationId: ConversationId
  readonly turnId: TurnId
  readonly toolCallId: string
  readonly toolName: string
  readonly startedAt: number
  readonly deadline?: number
  readonly abort?: (reason: string) => void
  readonly recoveredFromCrash?: boolean
  payload?: TPayload
}

interface PendingInternalEntry<TPayload> extends PendingToolEntry<TPayload> {
  resolved: boolean
}

export interface PendingToolCall extends PendingToolExecutionState {
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
  /**
   * Optional epoch-ms wall-clock deadline. When set, the
   * PendingDeadlineSweeper expires this entry by emitting a
   * synthetic error tool_result so the agent unwinds and the
   * conversation drops out of the pending-work state. Undefined =
   * no automatic timeout (e.g. shell streams that legitimately run
   * for hours).
   */
  deadline?: number
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
   *
   * Only `identical_search_replace` is a real noop. Genuine apply
   * failures (target_not_found, ambiguous_target, range_invalid, etc.)
   * MUST leave this undefined and let `editApplyWarning` drive the
   * `[edit_apply_failed]` projection — see the dispatcher's
   * `computedEdit.fileText === editPending.beforeContent` fallback in
   * cursor-connect-stream.service.ts (smoke-regression #3g fix).
   */
  editNoopReason?: "identical_search_replace"
  beforeContent?: string // File content before edit (for edit tools)
  afterContent?: string // File content after edit (computed from applyEditInputToFileText)
  /**
   * For edit_file_v2 invocations: the resolved target file path used to
   * coordinate path-level serialization (see SessionRecord.editPathHolderByPath
   * and SessionRecord.editPathQueueByPath). Stored at registration time so the
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
 * Stored in the parent SessionRecord while a sub-agent is running.
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
  /** User-facing agent type, persisted for result metadata. */
  agentType?: string
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

interface PersistedPendingToolCall extends PendingToolExecutionState {
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
  /**
   * Optional epoch-ms deadline for automatic timeout. When set, the
   * PendingDeadlineSweeper expires the entry by emitting a synthetic
   * error tool_result so the agent unwinds and the conversation
   * leaves the pending-work state. Undefined = no automatic timeout
   * (e.g. shell streams that legitimately run for hours).
   */
  deadline?: number
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
  agentType?: string
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
    reason?: ToolInterruptionReason
    detail?: string
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
  continuationBudget?: SessionTopLevelContinuationBudget
  activeToolBatch?: PersistedActiveToolBatch
}

interface PersistedChatSessionV1 {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
  conversationId: string
  messages: SessionMessage[]
  messageRecords?: ContextTranscriptRecord[]
  transcriptEvents?: SessionTranscriptEvent[]
  nextTranscriptEventSeq?: number
  contextState?: ContextConversationState
  taskBudgetState?: SessionTaskBudgetState
  topLevelAgentTurnState?: PersistedTopLevelAgentTurnState
  lastEmittedContextSummaryCompactionId?: string
  lastEmittedContextSummaryCompactionEpoch?: number
  lastContextSummaryCompactionEpoch?: number
  model: string
  lastAssistantBackend?: BackendType
  lastAssistantModel?: string
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
   * Persisted form of `SessionRecord.additionalRoots`. Stored as an
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
   * (cf. `parsePersistedSession` — restart recovery only marks them as
   * interrupted), so this is consumed exclusively by the recovery
   * synthesis path.
   */
  subAgentContexts?: PersistedSubAgentContext[]
  toolExecutionOrderCounter?: number
  restartRecovery?: PersistedSessionRestartRecovery
}

@Injectable()
export class SessionLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionLifecycleService.name)
  // Step 4 物理拆: SessionLifecycleService 只持有 SessionLifecycleRecord
  // (lifecycle 域字段)。ContextStateRecord / SessionStreamRecord 由
  // 各自服务持有独立 Map,createFreshSession / parsePersistedSession /
  // deleteSession 在 lifecycle 创建/销毁 record 时 fan-out。
  private readonly sessions = new Map<string, SessionLifecycleRecord>()

  // Pending tool calls — inlined from the deleted PendingToolStore
  // class. Two indexes:
  //   - byConversation: conv → toolCallId → entry  (fast lookup by id)
  //   - byTurn:         conv → turnId → Set<toolCallId>  (fast list per turn)
  // Updated atomically. The legacy class lived in turn/pending-tool-store.ts
  // and was deleted to consolidate single-source-of-truth here.
  private readonly pendingByConversation = new Map<
    ConversationId,
    Map<string, PendingInternalEntry<unknown>>
  >()
  private readonly pendingByTurn = new Map<
    ConversationId,
    Map<TurnId, Set<string>>
  >()

  // Transcript staging — inlined from the deleted TranscriptStore
  // class. The `committedTranscripts` map holds the canonical
  // SessionMessage[] for each conversation; `SessionRecord.messages`
  // aliases the same physical array so cursor's hot-path
  // length / at(-1) / [i] reads need no defensive copy. The single-
  // anchor staging discipline (one open turn per conversation) is
  // enforced by `transcriptOpenAnchors` below — distinct from the
  // lifecycle-level `turnAnchors` map which records the multi-array
  // anchor (messages / messageRecords / transcriptEvents /
  // contextRecords / usedTokens / messagesGeneration) used by
  // beginTurn / commitTurn / abortTurn for full rewind.
  private readonly committedTranscripts = new Map<
    ConversationId,
    SessionMessage[]
  >()
  private readonly transcriptOpenAnchors = new Map<
    ConversationId,
    { readonly turnId: TurnId; readonly anchorIndex: number }
  >()
  /**
   * Per-conversation transcript-turn anchor. Set by `beginTurn`,
   * cleared by `commitTurn` / `abortTurn`. Records the index
   * each tracked array was at when the turn opened so abortTurn
   * can rewind atomically.
   */
  private readonly turnAnchors = new Map<
    string,
    {
      readonly turnId: TurnId
      readonly messagesAt: number
      readonly messageRecordsAt: number
      readonly transcriptEventsAt: number
      readonly contextRecordsAt: number
      readonly usedTokens: number
      readonly messagesGeneration: number
    }
  >()
  private readonly ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000 // 30 minutes
  private readonly PERSISTED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
  private readonly PERSIST_FLUSH_INTERVAL_MS = 15 * 1000
  private readonly PERSIST_DEBOUNCE_MS = 250
  /**
   * Wall-clock budget the bridge gives the IDE to process an
   * ExecServerMessage before `PendingDeadlineSweeper` synthesises a
   * timeout error tool_result. Picked at 90s — enough for `ls` over a
   * slow network mount, conservative enough to surface a stalled IDE
   * within a reasonable model-loop iteration. Long-running channels
   * (shell streams, sub-agent execs) opt out via
   * `EXEC_DISPATCH_DEADLINE_EXEMPT_TOOLS`.
   */
  private readonly EXEC_DISPATCH_DEADLINE_MS = 90 * 1000
  /**
   * Tool names whose ExecServerMessage path may legitimately run for
   * minutes / hours. The deadline auto-arm in
   * `registerPendingToolExecId` skips these; if they need a timeout
   * the caller still sets one explicitly via `addPendingToolCall`'s
   * `deadlineMs` argument.
   *
   * Names listed here are the **post-mapper user-facing** names stored
   * on `PendingToolCall.toolName` (not proto enum keys), matching what
   * the bridge persists for inbound tool dispatch.
   */
  private readonly EXEC_DISPATCH_DEADLINE_EXEMPT_TOOLS: ReadonlySet<string> =
    new Set([
      "run_terminal_command",
      "run_terminal_command_v2",
      "background_shell_spawn",
      "write_shell_stdin",
      "task",
      "task_v2",
      "await_task",
      "await",
      "wait_agent",
      "subagent_await",
      "force_background_shell",
      "force_background_subagent",
    ])
  private readonly MAX_READ_SNAPSHOTS_PER_SESSION = 24
  private readonly MAX_READ_SNAPSHOTS_PER_FILE = 6
  private readonly MAX_READ_SNAPSHOT_CHARS = 80_000
  private readonly TURN_STATE_HISTORY_LIMIT = 12
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
    session: SessionRecord
  ) => void

  /**
   * Optional callback fired on the edge transition from "session has
   * pending tool calls or interaction queries" to "session is fully
   * idle". Wired by `cursor-connect-stream` to drain
   * `session.deferredControlContinuations`.
   *
   * Edge-only semantics: invoked exactly once per non-idle → idle
   * transition, never on idle → idle no-ops, never while still
   * non-idle. The handler may be re-entered on the next non-idle
   * → idle cycle.
   */
  private onPendingWorkBecameIdleHandler?: (
    conversationId: string,
    session: SessionRecord
  ) => void

  /**
   * Resolver supplied by the protocol service so every pending-tool
   * registration can attribute itself to the active ParentTurn. The
   * protocol layer maintains a per-conversation parent-turn stack;
   * the manager calls this inline from `addPendingToolCall` to ask
   * "which turnId owns the new entry".
   *
   * Defaults to a sentinel `legacy:<conv>` turnId when no resolver
   * has been wired (tests / direct manager construction). The store
   * doesn't care about the value semantics; it just uses it for
   * cancellation cascade indexing.
   */
  private resolveTurnIdForConversation: (
    conversationId: string
  ) => TurnId | undefined = (conv) => TurnId.of(`legacy:${conv}`)

  setPendingToolTurnIdResolver(
    resolver: (conversationId: string) => TurnId | undefined
  ): void {
    this.resolveTurnIdForConversation = resolver
  }

  // ─── PendingToolStore-backed read API ────────────────────────────
  // Replaces every legacy `session.pendingToolCalls.{...}` access.
  // Reads never touch the store's `byTurn` index; they only walk the
  // (conversation, toolCallId) primary index.

  /** Equivalent to `this.getPendingToolCall(session.conversationId, toolCallId)`. */
  getPendingToolCall(
    conversationId: string,
    toolCallId: string
  ): PendingToolCall | undefined {
    const entry = this.pendingToolGet<PendingToolCall>(
      ConversationId.of(conversationId),
      toolCallId
    )
    return entry?.payload
  }

  /** Equivalent to `this.hasPendingToolCall(session.conversationId, toolCallId)`. */
  hasPendingToolCall(conversationId: string, toolCallId: string): boolean {
    return this.getPendingToolCall(conversationId, toolCallId) !== undefined
  }

  /** Equivalent to `this.pendingToolCallCount(session.conversationId)`. */
  pendingToolCallCount(conversationId: string): number {
    return this.pendingToolSnapshotForConversation(
      ConversationId.of(conversationId)
    ).length
  }

  /** Equivalent to `this.listPendingToolCallIds(session.conversationId)`. */
  listPendingToolCallIds(conversationId: string): string[] {
    return this.pendingToolSnapshotForConversation(
      ConversationId.of(conversationId)
    ).map((e) => e.toolCallId)
  }

  /** Equivalent to `this.listPendingToolCalls(session.conversationId)`. */
  listPendingToolCalls(conversationId: string): PendingToolCall[] {
    return this.pendingToolSnapshotForConversation<PendingToolCall>(
      ConversationId.of(conversationId)
    )
      .map((e) => e.payload as PendingToolCall)
      .filter((p): p is PendingToolCall => p !== undefined)
  }

  /** Equivalent to `[...session.pendingToolCalls]`. */
  listPendingToolCallEntries(
    conversationId: string
  ): Array<[string, PendingToolCall]> {
    const out: Array<[string, PendingToolCall]> = []
    for (const e of this.pendingToolSnapshotForConversation<PendingToolCall>(
      ConversationId.of(conversationId)
    )) {
      if (e.payload) out.push([e.toolCallId, e.payload])
    }
    return out
  }

  /**
   * Mutate an existing pending tool call's payload. Throws if the
   * entry is missing or already resolved — callers expect the
   * tool to be live when they reach a mutation.
   */
  updatePendingToolCall(
    conversationId: string,
    toolCallId: string,
    mutate: (current: PendingToolCall) => void
  ): void {
    this.pendingToolUpdatePayload<PendingToolCall>(
      ConversationId.of(conversationId),
      toolCallId,
      (p) => {
        if (!p) {
          throw new Error(
            `updatePendingToolCall: entry has no payload for ${conversationId}/${toolCallId}`
          )
        }
        mutate(p)
        return p
      }
    )
  }

  /** Resolve and remove a single pending tool call from the store. */
  private resolvePendingToolCallEntry(
    conversationId: string,
    toolCallId: string
  ): boolean {
    const conv = ConversationId.of(conversationId)
    const existed = this.pendingToolGet(conv, toolCallId) !== undefined
    if (existed) this.pendingToolResolve(conv, toolCallId)
    return existed
  }

  /** Resolve every live entry for a conversation. */
  private clearAllPendingToolCalls(conversationId: string): void {
    this.pendingToolClearConversation(ConversationId.of(conversationId))
  }

  constructor(
    private readonly persistence: PersistenceService,
    private readonly toolResultStorage: ToolResultStorageService,
    // Pending tool calls and transcript staging are inlined into
    // this class (the legacy PendingToolStore + TranscriptStore
    // classes have been deleted). See `pendingByConversation` /
    // `pendingByTurn` + `pendingToolXxx` methods, and
    // `committedTranscripts` / `transcriptOpenAnchors` +
    // `transcriptXxx` methods below.
    // Step 3 introduced ledger / message-store / session-persistence as
    // the new owners of the v2 schema. SessionLifecycleService routes
    // all SQLite reads/writes through SessionPersistenceService so the
    // legacy `cursor_sessions` JSON-blob path is fully retired.
    private readonly sessionPersistence: SessionPersistenceService,
    private readonly messageStore: MessageStore,
    private readonly toolCallLedger: ToolCallLedger,
    // Step 4 真正拆解: AssistantToolBatchService owns the in-flight
    // assistant tool batch state machine. forwardRef breaks the
    // bidirectional cycle (lifecycle → batch on persistence /
    // detach paths, batch → lifecycle for markSessionDirty).
    @Inject(forwardRef(() => AssistantToolBatchService))
    private readonly assistantToolBatch: AssistantToolBatchService,
    @Inject(forwardRef(() => ContextStateService))
    private readonly contextState: ContextStateService,
    @Inject(forwardRef(() => SessionStreamService))
    private readonly sessionStream: SessionStreamService
  ) {}

  /**
   * Conversation → active leaf turn handle resolver. Installed by
   * CursorConnectStreamService at boot (setter injection avoids the
   * DI cycle between SessionLifecycleService and TurnLifecycle while still
   * letting `getCurrentTurnAbortSignal` return the live supervisor
   * handle's signal). When unset (unit tests, pre-bridge bootstrap),
   * `getCurrentTurnAbortSignal` returns undefined.
   *
   * M3: replaces the legacy `SessionRecord.currentTurnAbortController`
   * field. Callers ask the supervisor "what's running on this
   * conversation right now" instead of reading a session-level
   * AbortController.
   */
  private activeTurnSignalResolver:
    | ((conversationId: string) => AbortSignal | undefined)
    | undefined

  setActiveTurnSignalResolver(
    resolver: (conversationId: string) => AbortSignal | undefined
  ): void {
    this.activeTurnSignalResolver = resolver
  }

  /**
   * Inlined TranscriptStore — staging contract for the canonical
   * conversation transcript. SessionRecord.messages aliases the
   * `committedTranscripts` array directly so cursor's hot-path reads
   * (length / at(-1) / [i]) need no defensive copy. Single open turn
   * per conversation is enforced by `transcriptOpenAnchors`.
   *
   * The legacy TranscriptStore class is deleted; callers go through
   * these public methods instead. The naming keeps the
   * `transcriptXxx` prefix to make grep easy and to avoid clashing
   * with the lifecycle-level `beginTurn` / `commitTurn` /
   * `abortTurn` (which run wider — they also rewind messageRecords,
   * transcriptEvents, contextRecords, usedTokens, messagesGeneration
   * via the `turnAnchors` map).
   */
  transcriptBeginTurn(conversationId: ConversationId, turnId: TurnId): void {
    const existing = this.transcriptOpenAnchors.get(conversationId)
    if (existing) {
      throw new Error(
        `transcriptBeginTurn: conversation ${conversationId} ` +
          `already has open turn ${existing.turnId} (cannot start ${turnId})`
      )
    }
    const list = this.transcriptGetCommittedRaw(conversationId)
    this.transcriptOpenAnchors.set(conversationId, {
      turnId,
      anchorIndex: list.length,
    })
  }

  transcriptStage(
    conversationId: ConversationId,
    turnId: TurnId,
    message: SessionMessage
  ): void {
    const anchor = this.transcriptOpenAnchors.get(conversationId)
    if (anchor && anchor.turnId !== turnId) {
      throw new Error(
        `transcriptStage: turn mismatch for ${conversationId}: ` +
          `open=${anchor.turnId} given=${turnId}`
      )
    }
    const list = this.transcriptGetCommittedRaw(conversationId)
    list.push(message)
  }

  transcriptPeekStaged(
    conversationId: ConversationId,
    turnId: TurnId
  ): SessionMessage[] {
    const anchor = this.transcriptOpenAnchors.get(conversationId)
    if (!anchor || anchor.turnId !== turnId) return []
    const list = this.committedTranscripts.get(conversationId)
    if (!list) return []
    return list.slice(anchor.anchorIndex)
  }

  transcriptCommitTurn(conversationId: ConversationId, turnId: TurnId): number {
    const anchor = this.transcriptOpenAnchors.get(conversationId)
    if (!anchor) return 0
    if (anchor.turnId !== turnId) {
      throw new Error(
        `transcriptCommitTurn: turn mismatch for ${conversationId}: ` +
          `open=${anchor.turnId} given=${turnId}`
      )
    }
    const list = this.committedTranscripts.get(conversationId)
    const staged = list ? list.length - anchor.anchorIndex : 0
    this.transcriptOpenAnchors.delete(conversationId)
    return staged
  }

  transcriptAbortTurn(conversationId: ConversationId, turnId: TurnId): number {
    const anchor = this.transcriptOpenAnchors.get(conversationId)
    if (!anchor) return 0
    if (anchor.turnId !== turnId) {
      throw new Error(
        `transcriptAbortTurn: turn mismatch for ${conversationId}: ` +
          `open=${anchor.turnId} given=${turnId}`
      )
    }
    const list = this.committedTranscripts.get(conversationId)
    if (!list) {
      this.transcriptOpenAnchors.delete(conversationId)
      return 0
    }
    const dropped = list.length - anchor.anchorIndex
    if (dropped > 0) {
      list.splice(anchor.anchorIndex)
    }
    this.transcriptOpenAnchors.delete(conversationId)
    return dropped
  }

  transcriptGetCommitted(conversationId: ConversationId): SessionMessage[] {
    const list = this.committedTranscripts.get(conversationId)
    return list ? [...list] : []
  }

  transcriptGetCommittedRaw(conversationId: ConversationId): SessionMessage[] {
    let list = this.committedTranscripts.get(conversationId)
    if (!list) {
      list = []
      this.committedTranscripts.set(conversationId, list)
    }
    return list
  }

  transcriptReplaceCommitted(
    conversationId: ConversationId,
    next: SessionMessage[]
  ): void {
    this.committedTranscripts.set(conversationId, [...next])
    const anchor = this.transcriptOpenAnchors.get(conversationId)
    if (anchor) {
      this.transcriptOpenAnchors.set(conversationId, {
        turnId: anchor.turnId,
        anchorIndex: next.length,
      })
    }
  }

  transcriptReplaceAt(
    conversationId: ConversationId,
    index: number,
    next: SessionMessage
  ): void {
    const list = this.committedTranscripts.get(conversationId)
    if (!list) {
      throw new Error(
        `transcriptReplaceAt: no committed transcript for ${conversationId}`
      )
    }
    if (index < 0 || index >= list.length) {
      throw new Error(
        `transcriptReplaceAt: index ${index} out of bounds (size=${list.length})`
      )
    }
    list[index] = next
  }

  transcriptAppendCommitted(
    conversationId: ConversationId,
    message: SessionMessage
  ): void {
    const list = this.transcriptGetCommittedRaw(conversationId)
    list.push(message)
  }

  transcriptMutateCommitted(
    conversationId: ConversationId,
    mutate: (list: SessionMessage[]) => void
  ): void {
    const list = this.transcriptGetCommittedRaw(conversationId)
    mutate(list)
  }

  transcriptClearConversation(conversationId: ConversationId): void {
    this.committedTranscripts.delete(conversationId)
    this.transcriptOpenAnchors.delete(conversationId)
  }

  transcriptHasOpenTurn(conversationId: ConversationId): boolean {
    return this.transcriptOpenAnchors.has(conversationId)
  }

  transcriptOpenTurnId(conversationId: ConversationId): TurnId | undefined {
    return this.transcriptOpenAnchors.get(conversationId)?.turnId
  }

  transcriptCommittedSize(conversationId: ConversationId): number {
    return this.committedTranscripts.get(conversationId)?.length ?? 0
  }

  // ─── Inlined PendingToolStore — single source of truth ───────────
  // Replaces the deleted `turn/pending-tool-store.ts`. Same semantics
  // (single (conv, toolCallId) compound key, byTurn secondary index,
  // throw on duplicate-register, idempotent resolve, etc.) but lives
  // here so the lifecycle / stream services can call directly without
  // the indirection of a wrapped service. Public so external callers
  // (cursor-connect-stream / context-bridge / tests) reach the same
  // entries through a single API surface.

  pendingToolRegister<TPayload = unknown>(
    entry: PendingToolEntry<TPayload>
  ): void {
    const convMap = this.getOrCreatePendingConvMap(entry.conversationId)
    if (convMap.has(entry.toolCallId)) {
      throw new Error(
        `pendingToolRegister: duplicate registration for conversation=${entry.conversationId} toolCallId=${entry.toolCallId}`
      )
    }
    convMap.set(entry.toolCallId, {
      ...entry,
      resolved: false,
    } as PendingInternalEntry<unknown>)

    const turnMap = this.getOrCreatePendingTurnMap(entry.conversationId)
    let set = turnMap.get(entry.turnId)
    if (!set) {
      set = new Set()
      turnMap.set(entry.turnId, set)
    }
    set.add(entry.toolCallId)
  }

  pendingToolUpdatePayload<TPayload = unknown>(
    conversationId: ConversationId,
    toolCallId: string,
    mutate: (current: TPayload | undefined) => TPayload
  ): void {
    const entry = this.pendingByConversation
      .get(conversationId)
      ?.get(toolCallId)
    if (!entry || entry.resolved) {
      throw new Error(
        `pendingToolUpdatePayload: no live entry for conversation=${conversationId} toolCallId=${toolCallId}`
      )
    }
    entry.payload = mutate(entry.payload as TPayload | undefined)
  }

  pendingToolGet<TPayload = unknown>(
    conversationId: ConversationId,
    toolCallId: string
  ): PendingToolEntry<TPayload> | undefined {
    const entry = this.pendingByConversation
      .get(conversationId)
      ?.get(toolCallId)
    if (!entry || entry.resolved) return undefined
    return entry as PendingToolEntry<TPayload>
  }

  pendingToolMatchesTurn(
    conversationId: ConversationId,
    toolCallId: string,
    turnId: TurnId
  ): boolean {
    const entry = this.pendingToolGet(conversationId, toolCallId)
    return entry?.turnId === turnId
  }

  pendingToolResolve(conversationId: ConversationId, toolCallId: string): void {
    const convMap = this.pendingByConversation.get(conversationId)
    const entry = convMap?.get(toolCallId)
    if (!entry || entry.resolved) return
    entry.resolved = true
    convMap!.delete(toolCallId)
    if (convMap!.size === 0) {
      this.pendingByConversation.delete(conversationId)
    }
    const turnMap = this.pendingByTurn.get(conversationId)
    const set = turnMap?.get(entry.turnId)
    set?.delete(toolCallId)
    if (set && set.size === 0) {
      turnMap!.delete(entry.turnId)
      if (turnMap!.size === 0) this.pendingByTurn.delete(conversationId)
    }
  }

  pendingToolListForTurn<TPayload = unknown>(
    conversationId: ConversationId,
    turnId: TurnId
  ): PendingToolEntry<TPayload>[] {
    const set = this.pendingByTurn.get(conversationId)?.get(turnId)
    if (!set || set.size === 0) return []
    const convMap = this.pendingByConversation.get(conversationId)
    if (!convMap) return []
    const out: PendingToolEntry<TPayload>[] = []
    for (const id of set) {
      const e = convMap.get(id)
      if (e && !e.resolved) out.push(e as PendingToolEntry<TPayload>)
    }
    return out
  }

  pendingToolSnapshotForConversation<TPayload = unknown>(
    conversationId: ConversationId
  ): PendingToolEntry<TPayload>[] {
    const convMap = this.pendingByConversation.get(conversationId)
    if (!convMap) return []
    const out: PendingToolEntry<TPayload>[] = []
    for (const e of convMap.values()) {
      if (!e.resolved) out.push(e as PendingToolEntry<TPayload>)
    }
    return out
  }

  pendingToolAbortTurn(
    conversationId: ConversationId,
    turnId: TurnId,
    reason: string
  ): number {
    const entries = this.pendingToolListForTurn(conversationId, turnId)
    let aborted = 0
    for (const e of entries) {
      if (e.abort) {
        try {
          e.abort(reason)
          aborted += 1
        } catch (err) {
          this.logger.warn(
            `abort threw for tool=${e.toolName} conversation=${conversationId} turn=${turnId}: ${(err as Error).message}`
          )
        }
      }
    }
    return aborted
  }

  pendingToolClearConversation(conversationId: ConversationId): number {
    const convMap = this.pendingByConversation.get(conversationId)
    if (!convMap) return 0
    const count = convMap.size
    this.pendingByConversation.delete(conversationId)
    this.pendingByTurn.delete(conversationId)
    return count
  }

  pendingToolSize(): number {
    let n = 0
    for (const m of this.pendingByConversation.values()) n += m.size
    return n
  }

  private getOrCreatePendingConvMap(conversationId: ConversationId) {
    let m = this.pendingByConversation.get(conversationId)
    if (!m) {
      m = new Map()
      this.pendingByConversation.set(conversationId, m)
    }
    return m
  }

  private getOrCreatePendingTurnMap(conversationId: ConversationId) {
    let m = this.pendingByTurn.get(conversationId)
    if (!m) {
      m = new Map()
      this.pendingByTurn.set(conversationId, m)
    }
    return m
  }

  /**
   * Re-pin the manager-level turn anchor after ContextStateService
   * runs a wholesale `replaceMessages`. The anchor lives on
   * SessionLifecycleService because turn open/commit/abort is owned
   * by the lifecycle layer; ContextStateService asks the lifecycle
   * to refresh its view once the new tail length is known.
   */
  repinTurnAnchorAfterReplaceMessages(conversationId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    const anchor = this.turnAnchors.get(conversationId)
    if (!anchor) return
    const ctx = this.contextState.getContextRecord(conversationId)!
    this.turnAnchors.set(conversationId, {
      ...anchor,
      messagesAt: ctx.messages.length,
      messageRecordsAt: ctx.messageRecords.length,
      transcriptEventsAt: ctx.transcriptEvents.length,
      contextRecordsAt: ctx.contextState.records.length,
      usedTokens: ctx.usedTokens,
      messagesGeneration: ctx.messagesGeneration,
    })
  }

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
    // P0-2 (#17) watchdog：每 60 秒兜底回收顶层 shell_stream pending
    // tool call —— IDE 端 streamClose 控制消息在 service 层无消费者
    // （cursor-connect-stream.service.ts 完全没消费 streamClose），
    // 导致 562 次 `Still waiting for pendingToolCalls=N` 反复打印。
    // 单次 O(N) 遍历，开销可忽略。详见 sweepStaleShellStreamPending。
    this.shellStreamWatchdogInterval = setInterval(() => {
      try {
        this.sweepStaleShellStreamPending()
      } catch (err) {
        this.logger.warn(
          `Shell stream watchdog error: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }, 60_000)
    this.cleanupInterval.unref?.()
    this.persistFlushInterval.unref?.()
    this.shellStreamWatchdogInterval.unref?.()
  }

  /**
   * Register a callback to be invoked when a session is removed (expired or deleted).
   * Used by the orchestration layer to release provider-specific resources
   * (e.g., ProviderAdapter.dispose() for Codex WebSocket connections).
   */
  registerSessionCleanupHandler(
    handler: (conversationId: string, session: SessionRecord) => void
  ): void {
    this.onSessionCleanupHandler = handler
  }

  /**
   * Register a callback fired whenever a session transitions from
   * "has pending tool calls / interaction queries" to "fully idle".
   *
   * Wired by `cursor-connect-stream` to drain
   * `session.deferredControlContinuations` — control-frame
   * continuations (queued ask answers, background task completions,
   * …) that arrived during a non-idle window and were parked to
   * avoid sending an upstream request with an unmatched
   * `function_call`.
   *
   * Fires only on the idle transition edge (`wasPending && !nowPending`),
   * never on idle → idle no-ops. The callback is invoked synchronously
   * from the consume site; if the callback awaits, it does so on its
   * own microtask — the manager itself never blocks.
   */
  registerPendingWorkBecameIdleHandler(
    handler: (conversationId: string, session: SessionRecord) => void
  ): void {
    this.onPendingWorkBecameIdleHandler = handler
  }

  /**
   * Internal helper: invoke `onPendingWorkBecameIdleHandler` exactly
   * once per "non-idle → idle" transition for `session`. Callers pass
   * `wasPending` snapshotted *before* the mutation so this can detect
   * the edge. Idempotent when `wasPending` was already `false` or the
   * session is still non-idle after the mutation.
   */
  notifyIfBecameIdleAfter(session: SessionRecord, wasPending: boolean): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    if (!wasPending) return
    if (!this.onPendingWorkBecameIdleHandler) return
    const conversationId = session.conversationId
    const stillPending =
      this.pendingToolCallCount(conversationId) > 0 ||
      stream.pendingInteractionQueries.size > 0
    if (stillPending) return
    try {
      this.onPendingWorkBecameIdleHandler(conversationId, session)
    } catch (err) {
      this.logger.error(
        `onPendingWorkBecameIdle handler for ${conversationId} threw: ${
          (err as Error)?.message || String(err)
        }`
      )
    }
  }

  onModuleDestroy(): void {
    this.persistAllSessions()

    for (const timer of this.scheduledPersistTimers.values()) {
      clearTimeout(timer)
    }
    this.scheduledPersistTimers.clear()

    clearInterval(this.cleanupInterval)
    clearInterval(this.persistFlushInterval)
    if (this.shellStreamWatchdogInterval) {
      clearInterval(this.shellStreamWatchdogInterval)
      this.shellStreamWatchdogInterval = undefined
    }
    // PersistenceService handles DB cleanup
  }

  private cleanupOldPersistedSessions(): void {
    if (!this.persistence.isReady) return
    const cutoff = Date.now() - this.PERSISTED_SESSION_TTL_MS
    try {
      const expired = this.sessionPersistence
        .listSessions()
        .filter((row) => row.lastActivityAt < cutoff)
      if (expired.length === 0) return
      for (const row of expired) {
        this.sessionPersistence.deleteSession(row.conversationId)
        this.deleteToolResultStorage(row.conversationId)
      }
      this.logger.log(
        `Cleaned up ${expired.length} expired persisted session(s)`
      )
    } catch (error) {
      this.logger.error(
        `Failed to cleanup persisted sessions: ${String(error)}`
      )
    }
  }

  schedulePersist(conversationId: string): void {
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

  clearScheduledPersist(conversationId: string): void {
    const timer = this.scheduledPersistTimers.get(conversationId)
    if (!timer) return
    clearTimeout(timer)
    this.scheduledPersistTimers.delete(conversationId)
  }

  /**
   * Synchronously flush a session's row to SQLite, bypassing the
   * `schedulePersist` debounce.
   *
   * The lifecycle service normally batches writes through a 5ms debounce
   * so a burst of mutations on the same conversation collapses into one
   * `upsertSession`. That is correct for the hot path, but it creates a
   * window where a *just-mounted* session (newly created via
   * `getOrCreateSession`) lives only in memory while downstream code
   * already starts spawning turn rows whose foreign key references
   * `sessions(conversation_id)`.
   *
   * `TurnLifecycle.spawn` calls this method right before its first
   * `appendEvent({kind:"spawned"})` so `turn_events` cannot violate the
   * FK at insert time. Callers that hold no in-memory session
   * (synthetic-compaction turns) may invoke this safely — it is a no-op
   * when the conversation is unknown.
   */
  flushPersistImmediate(conversationId: string): void {
    this.clearScheduledPersist(conversationId)
    const session = this.sessions.get(conversationId)
    if (!session) return
    this.writeSessionRow(conversationId, session)
  }

  private persistAllSessions(): void {
    for (const conversationId of this.sessions.keys()) {
      this.persistSession(conversationId)
    }
    this.cleanupOldPersistedSessions()
  }

  /**
   * Persist a session that is currently mounted in `this.sessions`.
   *
   * Lookup-by-id is intentional here: this is the API used by the hot
   * write path (schedulePersist debounce, turn-completion flushes, etc.)
   * where the caller knows the id but does not hold the live object —
   * the in-memory map is the source of truth, not the parameter.
   *
   * For paths that hold the session object directly (load-time repair
   * write-back, analytics-time silent write-back), use
   * {@link writeSessionRow} which has no in-memory lookup and no
   * silent-no-op behaviour.
   */
  persistSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    this.writeSessionRow(conversationId, session)
  }

  /**
   * Write a session row to SQLite without depending on `this.sessions`.
   *
   * This is the sole persistence primitive — `persistSession` is a thin
   * wrapper around it that resolves the session via in-memory map first.
   * Any code path that holds a session object (e.g. just-deserialized,
   * not yet mounted) MUST call this directly instead of `persistSession`,
   * otherwise the silent-no-op in `persistSession` will swallow the
   * write and leave SQLite stale.
   */
  private writeSessionRow(
    conversationId: string,
    session: SessionRecord
  ): void {
    const state = this.serializeSession(session)
    try {
      this.sessionPersistence.upsertSession({
        conversationId: ConversationId.of(conversationId),
        createdAt: session.createdAt.getTime(),
        lastActivityAt: session.lastActivityAt.getTime(),
        model: session.model,
        // The serialised PersistedChatSessionV1 is stored verbatim as
        // the config blob. This preserves backward-compatible
        // round-trip for every legacy field (messages, transcripts,
        // turn states, file states, todos, etc.) until step 8 moves
        // each domain into its dedicated v2 table.
        config: state as unknown as Record<string, unknown>,
      })
    } catch (error) {
      this.logger.error(
        `Failed to persist session ${conversationId}: ${String(error)}`
      )
    }
  }

  private loadPersistedSession(
    conversationId: string
  ): SessionRecord | undefined {
    try {
      const row = this.sessionPersistence.loadSession(
        ConversationId.of(conversationId)
      )
      if (!row) return undefined

      if (Date.now() - row.lastActivityAt > this.PERSISTED_SESSION_TTL_MS) {
        this.deletePersistedSession(conversationId)
        this.deleteToolResultStorage(conversationId)
        return undefined
      }

      const persisted = row.config as unknown as PersistedChatSessionV1

      // Lifecycle:
      //   1. Parse config blob → SessionRecord (pure, no side effects)
      //   2. Mount into `this.sessions`
      //   3. schedulePersist for deferred metadata flush
      //
      // The pre-step-3 design ran a write-time sanitize/enforceToolProtocol
      // pass between (1) and (2) so the disk row would land in a
      // protocol-correct state. Step 1 removed that path because protocol
      // integrity is now a ledger invariant, not something the
      // SessionLifecycleService corrects after the fact.
      const session = this.parsePersistedSession(persisted)
      this.sessions.set(conversationId, session)
      const ctx = this.contextState.getContextRecord(conversationId)!
      this.logger.log(
        `>>> Restored persisted session: ${conversationId} ` +
          `(messages=${ctx.messages.length}, records=${ctx.messageRecords.length}, turns=${ctx.turns.length}, pending=${this.pendingToolCallCount(conversationId)})`
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
      this.sessionPersistence.deleteSession(ConversationId.of(conversationId))
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
      continuationBudget: {
        continuationCount: 0,
        lastHistoryTokens: 0,
        lastDeltaTokens: 0,
        startedAt: Date.now(),
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

  private normalizeTaskBudgetState(
    value: SessionTaskBudgetState | undefined
  ): SessionTaskBudgetState | undefined {
    if (!value || value.type !== "tokens") return undefined
    if (
      typeof value.total !== "number" ||
      !Number.isFinite(value.total) ||
      value.total <= 0
    ) {
      return undefined
    }

    const total = Math.floor(value.total)
    const remaining =
      typeof value.remaining === "number" &&
      Number.isFinite(value.remaining) &&
      value.remaining >= 0
        ? Math.floor(value.remaining)
        : undefined

    return {
      type: "tokens",
      total,
      remaining,
      updatedAt:
        typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
          ? Math.max(0, Math.floor(value.updatedAt))
          : Date.now(),
      compactionDeductions: Array.isArray(value.compactionDeductions)
        ? value.compactionDeductions
            .filter(
              (deduction) =>
                !!deduction &&
                typeof deduction.compactionId === "string" &&
                deduction.compactionId.trim().length > 0 &&
                typeof deduction.preCompactContextTokens === "number" &&
                Number.isFinite(deduction.preCompactContextTokens)
            )
            .map((deduction) => ({
              compactionId: deduction.compactionId,
              preCompactContextTokens: Math.max(
                0,
                Math.floor(deduction.preCompactContextTokens)
              ),
              remainingBefore:
                typeof deduction.remainingBefore === "number" &&
                Number.isFinite(deduction.remainingBefore)
                  ? Math.max(0, Math.floor(deduction.remainingBefore))
                  : total,
              remainingAfter:
                typeof deduction.remainingAfter === "number" &&
                Number.isFinite(deduction.remainingAfter)
                  ? Math.max(0, Math.floor(deduction.remainingAfter))
                  : (remaining ?? total),
              deductedAt:
                typeof deduction.deductedAt === "number" &&
                Number.isFinite(deduction.deductedAt)
                  ? Math.max(0, Math.floor(deduction.deductedAt))
                  : Date.now(),
            }))
        : [],
    }
  }

  classifyToolCall(
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

  private getSessionLineChangeStats(session: SessionRecord): {
    linesAdded: number
    linesRemoved: number
  } {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    let linesAdded = 0
    let linesRemoved = 0

    for (const state of ctx.fileStates.values()) {
      const delta = this.countLineDelta(state.beforeContent, state.afterContent)
      linesAdded += delta.linesAdded
      linesRemoved += delta.linesRemoved
    }

    return { linesAdded, linesRemoved }
  }

  private buildAnalyticsEntry(
    conversationId: string,
    session: SessionRecord,
    loaded: boolean,
    now: number
  ): ChatSessionAnalyticsEntry {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
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
      pendingToolCalls: this.pendingToolCallCount(session.conversationId),
      completedToolCalls: ctx.toolMetrics.completedCalls,
      shellToolCalls: ctx.toolMetrics.shellCalls,
      editToolCalls: ctx.toolMetrics.editCalls,
      mcpToolCalls: ctx.toolMetrics.mcpCalls,
      otherToolCalls: ctx.toolMetrics.otherCalls,
      totalToolDurationMs: ctx.toolMetrics.totalDurationMs,
      avgToolDurationMs:
        ctx.toolMetrics.completedCalls > 0
          ? Math.round(
              (ctx.toolMetrics.totalDurationMs /
                ctx.toolMetrics.completedCalls) *
                10
            ) / 10
          : null,
      readFiles: ctx.readPaths.size,
      editedFiles: ctx.fileStates.size,
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

  private serializeSession(session: SessionRecord): PersistedChatSessionV1 {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    return {
      version: 15,
      conversationId: session.conversationId,
      messages: ctx.messages,
      messageRecords: ctx.messageRecords,
      transcriptEvents: ctx.transcriptEvents,
      nextTranscriptEventSeq: ctx.nextTranscriptEventSeq,
      contextState: {
        ...ctx.contextState,
        compactionHistory: deriveCompactionHistoryFromTranscript(
          ctx.contextState.records
        ),
        activeCompactionId: getActiveCompactCommitFromTranscript(
          ctx.contextState.records
        )?.id,
      },
      taskBudgetState: ctx.taskBudgetState,
      topLevelAgentTurnState: {
        llmTurnCount: ctx.topLevelAgentTurnState.llmTurnCount,
        continuationBudget: {
          continuationCount:
            ctx.topLevelAgentTurnState.continuationBudget.continuationCount,
          lastHistoryTokens:
            ctx.topLevelAgentTurnState.continuationBudget.lastHistoryTokens,
          lastDeltaTokens:
            ctx.topLevelAgentTurnState.continuationBudget.lastDeltaTokens,
          startedAt: ctx.topLevelAgentTurnState.continuationBudget.startedAt,
        },
        activeToolBatch: ctx.topLevelAgentTurnState.activeToolBatch
          ? {
              batchId: ctx.topLevelAgentTurnState.activeToolBatch.batchId,
              toolCallIds: [
                ...ctx.topLevelAgentTurnState.activeToolBatch.toolCallIds,
              ],
              assistantText:
                ctx.topLevelAgentTurnState.activeToolBatch.assistantText,
              readOnly: ctx.topLevelAgentTurnState.activeToolBatch.readOnly,
              startedAt: ctx.topLevelAgentTurnState.activeToolBatch.startedAt,
              tools: ctx.topLevelAgentTurnState.activeToolBatch.tools.map(
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
        ctx.lastEmittedContextSummaryCompactionId,
      lastEmittedContextSummaryCompactionEpoch:
        ctx.lastEmittedContextSummaryCompactionEpoch,
      lastContextSummaryCompactionEpoch:
        ctx.pendingContextSummaryUiUpdate?.epoch ??
        ctx.contextState.compactionEpoch,
      model: session.model,
      lastAssistantBackend: session.lastAssistantBackend,
      lastAssistantModel: session.lastAssistantModel,
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
      pendingToolCalls: this.listPendingToolCalls(session.conversationId).map(
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
          executionOwner: toolCall.executionOwner,
          executionStatus: toolCall.executionStatus,
          executionRecoveryReason: toolCall.executionRecoveryReason,
          executionOrder: toolCall.executionOrder,
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
      backgroundCommands: Array.from(stream.backgroundCommands.values()).map(
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
      pendingInteractionQueryCount: stream.pendingInteractionQueries.size,
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
      usedTokens: ctx.usedTokens,
      // Persist only `source='session'` additionalRoots — `'config'`
      // entries get replayed from `.cursor/agent-vibes.json` on load
      // so we don't want stale snapshots overriding fresh config.
      additionalRoots: session.additionalRoots
        ? Array.from(session.additionalRoots.values()).filter(
            (r) => r.source === "session"
          )
        : undefined,
      readPaths: Array.from(ctx.readPaths),
      readSnapshots: ctx.readSnapshots.map((snapshot) => ({ ...snapshot })),
      fileStates: Array.from(ctx.fileStates.entries()).map(
        ([filePath, state]) => ({
          path: filePath,
          beforeContent: state.beforeContent,
          afterContent: state.afterContent,
        })
      ),
      toolMetrics: { ...ctx.toolMetrics },
      messageBlobIds: [...ctx.messageBlobIds],
      turns: [...ctx.turns],
      currentAssistantMessage: ctx.currentAssistantMessage,
      stepId: ctx.stepId,
      execId: ctx.execId,
      interactionQueryId: stream.interactionQueryId,
      todos: [...ctx.todos],
      toolExecutionOrderCounter:
        this.assistantToolBatch.getToolExecutionOrderCounter(
          session.conversationId
        ),
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
                reason: toolCall.reason,
                detail: toolCall.detail,
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
          reason: "process_restart" as const,
          detail: undefined,
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
          reason: normalizeToolInterruptionReason(
            toolCall.reason,
            "process_restart"
          ),
          detail:
            typeof toolCall.detail === "string" &&
            toolCall.detail.trim().length > 0
              ? toolCall.detail.trim()
              : undefined,
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
        `Bridge process restarted before the previous turn finished. ${details.join("; ")}.` +
        ` Please retry the interrupted action if needed.`,
      interruptedToolCalls,
      interruptedInteractionQueryCount,
      interruptedSubAgent,
    }
  }

  createTranscriptRecord(
    message: SessionMessage,
    createdAt: number = Date.now()
  ): ContextTranscriptRecord {
    return {
      id: crypto.randomUUID(),
      role: message.message.role,
      kind: "message",
      content: message.message.content,
      createdAt,
      ...(message.type === "assistant" && message.message.id
        ? { messageId: message.message.id }
        : {}),
    }
  }

  /**
   * Build a SessionMessage for a freshly-loaded session (from the parsed
   * conversation in `createFreshSession`). Uses a deterministic timestamp
   * derived from `seedTime` so that record ordering matches insertion order
   * even if multiple messages are minted in the same JS event loop tick.
   */
  makeFreshSessionMessage(
    role: "user" | "assistant",
    content: MessageContent,
    seedTime: number = Date.now()
  ): SessionMessage {
    return makeSessionMessage(role, content, {
      timestamp: new Date(seedTime).toISOString(),
    })
  }

  createContextState(
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
      contextCollapseState: {
        commits: [],
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

  private normalizeContextCollapseState(value: unknown): ContextCollapseState {
    const state =
      value && typeof value === "object"
        ? (value as Partial<ContextCollapseState>)
        : {}
    return {
      updatedAt:
        typeof state.updatedAt === "number" && Number.isFinite(state.updatedAt)
          ? state.updatedAt
          : undefined,
      commits: Array.isArray(state.commits)
        ? state.commits.flatMap((commit) =>
            this.normalizeContextCollapseCommit(commit)
          )
        : [],
    }
  }

  private normalizeContextCollapseCommit(
    value: unknown
  ): ContextCollapseCommit[] {
    if (!value || typeof value !== "object") {
      return []
    }
    const commit = value as Partial<ContextCollapseCommit>
    if (
      typeof commit.id !== "string" ||
      commit.id.trim().length === 0 ||
      !Array.isArray(commit.archivedRecordIds) ||
      commit.archivedRecordIds.length === 0 ||
      typeof commit.summaryRecordId !== "string" ||
      commit.summaryRecordId.trim().length === 0 ||
      typeof commit.summary !== "string" ||
      commit.summary.trim().length === 0
    ) {
      return []
    }
    const archivedRecordIds = commit.archivedRecordIds.filter(
      (recordId): recordId is string =>
        typeof recordId === "string" && recordId.trim().length > 0
    )
    if (archivedRecordIds.length === 0) {
      return []
    }
    return [
      {
        id: commit.id.trim(),
        createdAt:
          typeof commit.createdAt === "number" &&
          Number.isFinite(commit.createdAt)
            ? commit.createdAt
            : Date.now(),
        strategy:
          commit.strategy === "manual" || commit.strategy === "reactive"
            ? commit.strategy
            : "auto",
        parentCollapseId:
          typeof commit.parentCollapseId === "string" &&
          commit.parentCollapseId.trim().length > 0
            ? commit.parentCollapseId.trim()
            : undefined,
        archivedRecordIds,
        archivedThroughRecordId:
          typeof commit.archivedThroughRecordId === "string" &&
          commit.archivedThroughRecordId.trim().length > 0
            ? commit.archivedThroughRecordId.trim()
            : archivedRecordIds[archivedRecordIds.length - 1]!,
        summaryRecordId: commit.summaryRecordId.trim(),
        sourceRecordCount: this.normalizeNonNegativeInteger(
          commit.sourceRecordCount,
          archivedRecordIds.length
        ),
        sourceMessageCount: this.normalizeNonNegativeInteger(
          commit.sourceMessageCount,
          archivedRecordIds.length
        ),
        sourceTokenCount: this.normalizeNonNegativeInteger(
          commit.sourceTokenCount,
          0
        ),
        retainedStartRecordId:
          typeof commit.retainedStartRecordId === "string" &&
          commit.retainedStartRecordId.trim().length > 0
            ? commit.retainedStartRecordId.trim()
            : undefined,
        retainedRecordCount: this.normalizeNonNegativeInteger(
          commit.retainedRecordCount,
          0
        ),
        retainedTokenCount:
          typeof commit.retainedTokenCount === "number" &&
          Number.isFinite(commit.retainedTokenCount) &&
          commit.retainedTokenCount >= 0
            ? Math.floor(commit.retainedTokenCount)
            : undefined,
        summary: commit.summary.trim(),
        summaryTokenCount: this.normalizeNonNegativeInteger(
          commit.summaryTokenCount,
          0
        ),
        projectedTokenCount: this.normalizeNonNegativeInteger(
          commit.projectedTokenCount,
          0
        ),
      },
    ]
  }

  private normalizeNonNegativeInteger(
    value: unknown,
    fallback: number
  ): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback
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
    return records.filter(isMessageRecord).map((record) =>
      makeSessionMessage(record.role, record.content, {
        messageId: record.messageId,
      })
    )
  }

  private rebuildTranscriptEventsFromRecords(
    records: ContextTranscriptRecord[]
  ): {
    events: SessionTranscriptEvent[]
    nextSeq: number
  } {
    const events: SessionTranscriptEvent[] = []
    let nextSeq = 1
    for (const record of records) {
      if (!isMessageRecord(record)) continue
      const built = this.buildTranscriptEventsForRecord(record, nextSeq)
      events.push(...built)
      nextSeq += built.length
    }
    return { events, nextSeq }
  }

  private normalizeTranscriptEvents(
    value: unknown,
    fallbackRecords: ContextTranscriptRecord[]
  ): {
    events: SessionTranscriptEvent[]
    nextSeq: number
  } {
    if (!Array.isArray(value) || value.length === 0) {
      return this.rebuildTranscriptEventsFromRecords(fallbackRecords)
    }
    const events = value.flatMap((event) =>
      this.normalizeTranscriptEvent(event)
    )
    if (events.length === 0) {
      return this.rebuildTranscriptEventsFromRecords(fallbackRecords)
    }
    events.sort(
      (left, right) => left.seq - right.seq || left.createdAt - right.createdAt
    )
    const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0)
    return {
      events,
      nextSeq: maxSeq + 1,
    }
  }

  private normalizeTranscriptEvent(value: unknown): SessionTranscriptEvent[] {
    if (!value || typeof value !== "object") {
      return []
    }
    const event = value as Partial<SessionTranscriptEvent>
    if (
      typeof event.kind !== "string" ||
      !this.isTranscriptEventKind(event.kind)
    ) {
      return []
    }
    const seq =
      typeof event.seq === "number" && Number.isFinite(event.seq)
        ? Math.max(1, Math.floor(event.seq))
        : 1
    return [
      {
        id:
          typeof event.id === "string" && event.id.trim().length > 0
            ? event.id.trim()
            : `evt_${seq}_${crypto.randomUUID()}`,
        seq,
        kind: event.kind,
        recordId:
          typeof event.recordId === "string" && event.recordId.trim().length > 0
            ? event.recordId.trim()
            : undefined,
        role:
          event.role === "user" || event.role === "assistant"
            ? event.role
            : undefined,
        messageId:
          typeof event.messageId === "string" &&
          event.messageId.trim().length > 0
            ? event.messageId.trim()
            : undefined,
        toolUseId:
          typeof event.toolUseId === "string" &&
          event.toolUseId.trim().length > 0
            ? event.toolUseId.trim()
            : undefined,
        toolName:
          typeof event.toolName === "string" && event.toolName.trim().length > 0
            ? event.toolName.trim()
            : undefined,
        contentChars:
          typeof event.contentChars === "number" &&
          Number.isFinite(event.contentChars) &&
          event.contentChars >= 0
            ? Math.floor(event.contentChars)
            : undefined,
        createdAt:
          typeof event.createdAt === "number" &&
          Number.isFinite(event.createdAt)
            ? event.createdAt
            : Date.now(),
        turnId:
          typeof event.turnId === "string" && event.turnId.trim().length > 0
            ? event.turnId.trim()
            : undefined,
        summary:
          typeof event.summary === "string" && event.summary.trim().length > 0
            ? event.summary.trim()
            : undefined,
      },
    ]
  }

  private isTranscriptEventKind(
    value: string
  ): value is SessionTranscriptEventKind {
    return (
      value === "session_restored" ||
      value === "snapshot_rewrite" ||
      value === "snapshot_repair" ||
      value === "user_message" ||
      value === "assistant_message" ||
      value === "tool_use" ||
      value === "tool_result"
    )
  }

  appendTranscriptEvent(
    session: SessionRecord,
    event: Omit<SessionTranscriptEvent, "id" | "seq" | "createdAt"> & {
      createdAt?: number
    }
  ): SessionTranscriptEvent {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    const seq = ctx.nextTranscriptEventSeq || 1
    const fullEvent: SessionTranscriptEvent = {
      id: `evt_${seq}_${crypto.randomUUID()}`,
      seq,
      createdAt: event.createdAt ?? Date.now(),
      ...event,
    }
    ctx.transcriptEvents.push(fullEvent)
    ctx.nextTranscriptEventSeq = seq + 1
    return fullEvent
  }

  appendTranscriptEventsForMessage(
    session: SessionRecord,
    record: ContextTranscriptRecord,
    message: SessionMessage
  ): SessionTranscriptEvent[] {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    const events = this.buildTranscriptEventsForRecord(
      record,
      ctx.nextTranscriptEventSeq || 1,
      message.uuid
    )
    ctx.transcriptEvents.push(...events)
    ctx.nextTranscriptEventSeq =
      (ctx.nextTranscriptEventSeq || 1) + events.length
    return events
  }

  buildTranscriptEventsForRecord(
    record: ContextTranscriptRecord,
    startSeq: number,
    turnId?: string
  ): SessionTranscriptEvent[] {
    const events: SessionTranscriptEvent[] = []
    const base = {
      recordId: record.id,
      role: record.role,
      messageId: record.messageId,
      contentChars: this.countContentChars(record.content),
      createdAt: record.createdAt,
      turnId,
    }
    events.push({
      id: `evt_${startSeq}_${crypto.randomUUID()}`,
      seq: startSeq,
      kind: record.role === "assistant" ? "assistant_message" : "user_message",
      ...base,
    })

    let nextSeq = startSeq + 1
    for (const block of this.safeNormalizeContent(record.content)) {
      if (isToolUseBlock(block)) {
        events.push({
          id: `evt_${nextSeq}_${crypto.randomUUID()}`,
          seq: nextSeq,
          kind: "tool_use",
          recordId: record.id,
          role: record.role,
          messageId: record.messageId,
          toolUseId: block.id,
          toolName: block.name,
          createdAt: record.createdAt,
          turnId,
        })
        nextSeq += 1
      } else if (isToolResultBlock(block)) {
        events.push({
          id: `evt_${nextSeq}_${crypto.randomUUID()}`,
          seq: nextSeq,
          kind: "tool_result",
          recordId: record.id,
          role: record.role,
          toolUseId: block.tool_use_id,
          contentChars: this.countContentChars(block.content),
          createdAt: record.createdAt,
          turnId,
        })
        nextSeq += 1
      }
    }

    return events
  }

  safeNormalizeContent(content: MessageContent) {
    try {
      return normalizeContent(content)
    } catch {
      return []
    }
  }

  countContentChars(content: MessageContent): number {
    if (typeof content === "string") {
      return content.length
    }
    try {
      return JSON.stringify(content).length
    } catch {
      return 0
    }
  }

  shouldFlushMessageImmediately(message: SessionMessage): boolean {
    if (message.type !== "user" || message.isMeta) {
      return false
    }
    return !this.safeNormalizeContent(message.message.content).some(
      isToolResultBlock
    )
  }

  messageContentEqual(left: MessageContent, right: MessageContent): boolean {
    if (left === right) return true
    if (typeof left !== typeof right) return false
    try {
      return JSON.stringify(left) === JSON.stringify(right)
    } catch {
      return false
    }
  }

  messagesEqual(left: SessionMessage, right: SessionMessage): boolean {
    return (
      left.message.role === right.message.role &&
      this.messageContentEqual(left.message.content, right.message.content)
    )
  }

  hasStableRecordProjection(
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

    // The projection is "stable" (compatible — archived context still valid)
    // as long as every previous record from the anchor still appears in the
    // next records IN THE SAME RELATIVE ORDER. Insertions/appends are benign:
    // an async/delayed tool_result repaired into place next to its tool_use,
    // or a freshly appended turn, must NOT invalidate compaction. Only a
    // genuine rewrite — a previous record removed or reordered — is
    // incompatible. (A previous contiguous-equality check treated any
    // mid-transcript insertion as a rewrite, which discarded the compaction
    // archive on nearly every async tool result, forcing churning
    // re-compaction.)
    const previousSuffix = previousRecords.slice(previousIndex)
    let prev = 0
    let next = nextIndex
    while (prev < previousSuffix.length && next < nextRecords.length) {
      if (previousSuffix[prev]?.id === nextRecords[next]?.id) {
        prev++
      }
      next++
    }
    return prev === previousSuffix.length
  }

  syncContextRecordsFromMessageRecords(
    state: ContextConversationState,
    messageRecords: ContextTranscriptRecord[]
  ): void {
    const activeCommit = getActiveCompactCommitFromTranscript(state.records)
    if (!activeCommit) {
      // No compact_boundary, but the existing state may still have snip
      // boundaries (durable record-drop markers). Wholesale-replacing
      // state.records with messageRecords would erase those, forcing the
      // next compaction round to re-snip the same 1500+ records and
      // re-emit a 1M-token `predictive_limit_reached` reading. Carry the
      // snip boundaries forward in the same relative position so the
      // projection layer keeps hiding the dropped IDs.
      const snipBoundaries = state.records.filter(isSnipBoundaryRecord)
      const remappedMessages = messageRecords.map((record) => ({
        ...record,
        kind: record.kind || "message",
      }))
      state.records =
        snipBoundaries.length > 0
          ? [...remappedMessages, ...snipBoundaries]
          : remappedMessages
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

  reconcileMessageRecords(
    existing: ContextTranscriptRecord[],
    nextMessages: SessionMessage[]
  ): ContextTranscriptRecord[] {
    const recordMatchesMessage = (
      record: ContextTranscriptRecord,
      msg: SessionMessage
    ): boolean =>
      record.role === msg.message.role &&
      this.messageContentEqual(record.content, msg.message.content)

    let prefix = 0
    while (
      prefix < existing.length &&
      prefix < nextMessages.length &&
      recordMatchesMessage(existing[prefix]!, nextMessages[prefix]!)
    ) {
      prefix++
    }

    let existingSuffix = existing.length - 1
    let nextSuffix = nextMessages.length - 1
    while (
      existingSuffix >= prefix &&
      nextSuffix >= prefix &&
      recordMatchesMessage(existing[existingSuffix]!, nextMessages[nextSuffix]!)
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

  isContextStateCompatible(
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
    // Snip boundaries are durable archive markers too — they record the IDs
    // of records that the projection layer should hide, even though no
    // summary text was generated. Treating them as "incompatible state"
    // would force `replaceMessages` to discard `state.records` after every
    // transcript rewrite (tool batch return, mid-turn re-anchor, etc.),
    // so the next turn would see ALL pre-snip records again, re-estimate
    // ~1M tokens, and re-snip the same 1500+ records — wasting tokenizer
    // CPU and producing a 6×-inflated `predictive_limit_reached` value
    // that masks any real growth.
    //
    // We require both `state.records` and the incoming `records` to retain
    // the snip boundary; if either side has dropped it, we fall through to
    // the strict-projection check (which will return false and reset).
    const stateHasSnipBoundary = state.records.some(isSnipBoundaryRecord)
    const incomingHasSnipBoundary = records.some(isSnipBoundaryRecord)
    if (stateHasSnipBoundary && incomingHasSnipBoundary) {
      return true
    }
    // Context collapses are a separate, lighter-weight summarization track
    // (see ContextCollapseService). Their commits live on
    // `contextCollapseState.commits` and are NOT recorded in
    // `compactionHistory`, but they do leave `context_collapse_summary`
    // records inline in the transcript and a non-empty
    // `contextCollapseState.commits` array. Without this branch, a turn that
    // had an LLM-backed collapse applied (a 30–110s round-trip on Opus)
    // followed by a transcript rewrite (e.g. tool integrity repair on the
    // next continuation) would fall through to the strict stable-projection
    // check, return false, and cause `replaceMessages` to throw away the
    // freshly-archived collapse along with the rest of `contextState`,
    // forcing the next turn to redo the LLM compact from scratch. Treat
    // either an inline summary record OR a tracked commit as sufficient
    // proof that archived context is in play and worth preserving.
    if (records.some((record) => isContextCollapseSummaryRecord(record))) {
      return true
    }
    const collapseCommits = state.contextCollapseState?.commits
    if (Array.isArray(collapseCommits) && collapseCommits.length > 0) {
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

  shouldRetainUsageLedger(
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

  /**
   * Pure deserialization — JSON row → in-memory `SessionRecord`.
   *
   * No side effects:
   *   - does NOT log
   *   - does NOT persist
   *   - does NOT mount into `this.sessions`
   *
   * Schema migration (compaction history derivation, transcript event
   * normalization) IS performed because it is part of the
   * "interpret raw JSON as a current-shape SessionRecord" contract.
   *
   * Callers that need a usable session (mount + audit) should
   * use {@link loadPersistedSession}. Callers that just need a transient
   * snapshot (analytics, dashboards) should call this and optionally
   * {@link writeSessionRow}.
   */
  private parsePersistedSession(
    persisted: PersistedChatSessionV1
  ): SessionRecord {
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
            contextCollapseState: this.normalizeContextCollapseState(
              rawContextState.contextCollapseState
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
    const transcriptEventState = this.normalizeTranscriptEvents(
      persisted.transcriptEvents,
      messageRecords
    )
    if (
      typeof persisted.nextTranscriptEventSeq === "number" &&
      Number.isFinite(persisted.nextTranscriptEventSeq) &&
      persisted.nextTranscriptEventSeq > transcriptEventState.nextSeq
    ) {
      transcriptEventState.nextSeq = Math.floor(
        persisted.nextTranscriptEventSeq
      )
    }

    const topLevelAgentTurnState: SessionTopLevelAgentTurnState =
      persisted.topLevelAgentTurnState
        ? {
            llmTurnCount:
              typeof persisted.topLevelAgentTurnState.llmTurnCount ===
                "number" && persisted.topLevelAgentTurnState.llmTurnCount > 0
                ? persisted.topLevelAgentTurnState.llmTurnCount
                : 1,
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
                    persisted.topLevelAgentTurnState.activeToolBatch
                      .readOnly === true,
                  startedAt:
                    typeof persisted.topLevelAgentTurnState.activeToolBatch
                      .startedAt === "number"
                      ? persisted.topLevelAgentTurnState.activeToolBatch
                          .startedAt
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

    const conv = ConversationId.of(persisted.conversationId)
    this.transcriptReplaceCommitted(
      conv,
      this.syncMessagesFromRecords(messageRecords)
    )
    const sessionMessages = this.transcriptGetCommittedRaw(conv)

    // Step 4 物理拆: fan-out context / stream records to their owning
    // services before returning the lifecycle slice. parsePersistedSession's
    // caller (loadPersistedSession / cleanupExpiredSessions) only stores
    // the lifecycle record into this.sessions; the other two records are
    // already in their respective service Maps by the time the caller
    // sees the lifecycle return value.
    const contextRecord = this.buildContextRecordFromPersisted(
      persisted,
      sessionMessages,
      messageRecords,
      transcriptEventState,
      contextState,
      topLevelAgentTurnState
    )
    this.contextState.createInitialRecord(
      persisted.conversationId,
      contextRecord
    )
    const streamRecord = this.buildStreamRecordFromPersisted(persisted)
    this.sessionStream.createInitialRecord(
      persisted.conversationId,
      streamRecord
    )

    return {
      conversationId: persisted.conversationId,
      model: persisted.model || "claude-sonnet-4.5",
      lastAssistantBackend:
        typeof persisted.lastAssistantBackend === "string"
          ? persisted.lastAssistantBackend
          : undefined,
      // Subagent model overrides are request-scoped (Cursor re-sends them
      // on every AgentRunRequest), so we don't persist them.  A reloaded
      // session starts empty and the next AgentRunRequest will refresh
      // it via getOrCreateSession.
      subagentModelOverrides: EMPTY_SUBAGENT_MODEL_OVERRIDES,
      lastAssistantModel:
        typeof persisted.lastAssistantModel === "string"
          ? persisted.lastAssistantModel
          : undefined,
      // `lastThinkingSummary` was previously persisted as a single-shot
      // string cache. Reasoning continuity now lives in
      // ReasoningMemoryService, which has no on-disk component (records
      // are recaptured on the next streaming turn). Older snapshots that
      // carried the field are silently ignored on restore — there is no
      // migration needed because the field was always advisory.
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
      supportedTools: freezeCacheKeyArray(
        Array.isArray(persisted.supportedTools)
          ? persisted.supportedTools
          : undefined,
        []
      ),
      // discoveredTools is intentionally not persisted: a tool's full
      // schema is cheaper to re-discover (one extra inline turn) than
      // to keep the schema set in sync across SQLite restarts and
      // upstream-side schema changes.  Always start fresh on restore.
      discoveredTools: new Set<string>(),
      mcpToolDefs: freezeCacheKeyArray(persisted.mcpToolDefs),
      useWeb: persisted.useWeb === true,
      requestContextEnv: persisted.requestContextEnv,
      createdAt,
      lastActivityAt,
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
      subAgentContexts: new Map(),
      restartRecovery: this.buildRestartRecovery(persisted),
      // Intentionally NOT rehydrated — the IDE re-sends any unconsumed
      // ConversationAction frames (e.g. asyncAskQuestionCompletion)
      // after bidi-stream restart, so a persisted entry would just
      // duplicate the replayed frame.
      deferredControlContinuations: [],
    }
  }

  /**
   * Build the ContextStateRecord from a persisted blob — paired with
   * parsePersistedSession; called by loadPersistedSession to seed
   * ContextStateService.contextRecords for the restored session.
   */
  private buildContextRecordFromPersisted(
    persisted: PersistedChatSessionV1,
    sessionMessages: SessionMessage[],
    messageRecords: ContextTranscriptRecord[],
    transcriptEventState: { events: SessionTranscriptEvent[]; nextSeq: number },
    contextState: ContextConversationState,
    topLevelAgentTurnState: SessionTopLevelAgentTurnState
  ): ContextStateRecord {
    return {
      messages: sessionMessages,
      messagesGeneration: 0,
      messageRecords,
      transcriptEvents: transcriptEventState.events,
      nextTranscriptEventSeq: transcriptEventState.nextSeq,
      contextState,
      currentTurnState: undefined,
      recentTurnStates: [],
      taskBudgetState: this.normalizeTaskBudgetState(persisted.taskBudgetState),
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
      todos: Array.isArray(persisted.todos) ? persisted.todos : [],
    }
  }

  /**
   * Build the SessionStreamRecord from a persisted blob — paired with
   * parsePersistedSession.
   */
  private buildStreamRecordFromPersisted(
    persisted: PersistedChatSessionV1
  ): SessionStreamRecord {
    return {
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
      pendingInteractionQueries: new Map(),
      interactionQueryId:
        typeof persisted.interactionQueryId === "number"
          ? persisted.interactionQueryId
          : 0,
    }
  }

  private createFreshSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): SessionLifecycleRecord {
    const initialMessages: SessionMessage[] =
      initialRequest?.conversation.map((message, index, conversation) => {
        const content =
          index === conversation.length - 1 &&
          message.role === "user" &&
          initialRequest.attachedImages?.length
            ? buildUserMessageContent(
                message.content,
                initialRequest.attachedImages
              )
            : message.content
        return this.makeFreshSessionMessage(message.role, content)
      }) || []
    const messageRecords = initialMessages.map((message, index) =>
      this.createTranscriptRecord(message, Date.now() + index * 1000)
    )
    const contextState = this.createContextState(messageRecords)
    const transcriptEventState =
      this.rebuildTranscriptEventsFromRecords(messageRecords)

    const conv = ConversationId.of(conversationId)
    this.transcriptReplaceCommitted(conv, initialMessages)
    const sessionMessages = this.transcriptGetCommittedRaw(conv)

    // Step 4 物理拆: 3 independent records.
    const lifecycleRecord: SessionLifecycleRecord = {
      conversationId,
      model: initialRequest?.model || "claude-sonnet-4.5",
      lastAssistantBackend: undefined,
      subagentModelOverrides:
        initialRequest?.subagentModelOverrides ??
        EMPTY_SUBAGENT_MODEL_OVERRIDES,
      lastAssistantModel: undefined,
      lastToolUseSummary: undefined,
      lastCodexResponseId: undefined,
      lastCodexRequestSignature: undefined,
      lastCodexWarmupPayload: undefined,
      pendingCodexResponseId: undefined,
      pendingCodexRequestSignature: undefined,
      thinkingLevel: initialRequest?.thinkingLevel || 0,
      thinkingDetailsRequested:
        initialRequest?.thinkingDetailsRequested === true,
      isAgentic: initialRequest?.isAgentic || false,
      supportedTools: freezeCacheKeyArray(initialRequest?.supportedTools, []),
      discoveredTools: new Set<string>(),
      deferredToolCatalog: undefined,
      preparedToolBuild: undefined,
      mcpToolDefs: freezeCacheKeyArray(initialRequest?.mcpToolDefs),
      browserContext: undefined,
      useWeb: initialRequest?.useWeb || false,
      requestContextEnv: initialRequest?.requestContextEnv,
      createdAt: new Date(),
      lastActivityAt: new Date(),
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
      additionalRoots: new Map(),
      configuredAdditionalRootsLoaded: undefined,
      subAgentContexts: new Map(),
      restartRecovery: undefined,
      deferredControlContinuations: [],
    }

    const contextRecord: ContextStateRecord = {
      messages: sessionMessages,
      messagesGeneration: 0,
      messageRecords,
      transcriptEvents: transcriptEventState.events,
      nextTranscriptEventSeq: transcriptEventState.nextSeq,
      contextState,
      currentTurnState: undefined,
      recentTurnStates: [],
      taskBudgetState: undefined,
      topLevelAgentTurnState: this.createEmptyTopLevelAgentTurnState(),
      lastEmittedContextSummaryCompactionId: undefined,
      lastEmittedContextSummaryCompactionEpoch: undefined,
      pendingContextSummaryUiUpdate: undefined,
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
      snipState: undefined,
      pendingRequestContextLedger: undefined,
      todos: [],
    }

    const streamRecord: SessionStreamRecord = {
      backgroundCommands: new Map(),
      pendingToolCallByExecId: new Map(),
      currentStreamId: crypto.randomUUID(),
      editPathHolderByPath: new Map(),
      editPathQueueByPath: new Map(),
      pendingInteractionQueries: new Map(),
      interactionQueryId: 0,
    }

    this.contextState.createInitialRecord(conversationId, contextRecord)
    this.sessionStream.createInitialRecord(conversationId, streamRecord)

    this.logMcpAdvisoryIfMissing(lifecycleRecord, "fresh_session")
    return lifecycleRecord
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
  private mcpAdvisoryEmitted = new WeakSet<SessionRecord>()
  private logMcpAdvisoryIfMissing(
    session: SessionRecord,
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

  // ── 以下方法已废弃并删除 ──────────────────────────────────────────────
  // cacheCodexWarmupPayload()        → 移入 CodexService.warmupPayloadCache
  // getCachedCodexWarmupPayload()    → 移入 CodexService.warmupPayloadCache
  // stagePendingCodexRequestSignature()
  // commitPendingCodexResponse()
  // discardPendingCodexResponse()
  //
  // previous_response_id 的完整生命周期现在由 CodexService.activeTurnContexts 管理。
  // warmup payload 的缓存现在由 CodexService.warmupPayloadCache 管理。
  // 采用 Codex CLI 的 ModelClientSession.WebsocketSession 设计。

  /**
   * Create or get existing session
   */
  getOrCreateSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): SessionRecord {
    let session = this.getSession(conversationId)

    if (!session) {
      session = this.createFreshSession(conversationId, initialRequest)
      this.loadConfiguredAdditionalRoots(session)
      this.sessions.set(conversationId, session)
      this.logger.log(
        `>>> Created new session: ${conversationId} (model: ${session.model})`
      )
    } else {
      const ctx = this.contextState.getContextRecord(conversationId)!
      session.lastActivityAt = new Date()

      // Refresh protocol fields on every turn so continuation strictly follows Cursor request.
      if (initialRequest?.model) {
        session.model = initialRequest.model
      }
      // Subagent model overrides are request-scoped and refreshed on
      // every AgentRunRequest (Cursor sends the full table per turn).
      // Treat absence as "no overrides on this turn" — fall back to the
      // empty singleton so consumers can rely on a stable accessor.
      if (initialRequest) {
        session.subagentModelOverrides =
          initialRequest.subagentModelOverrides ??
          EMPTY_SUBAGENT_MODEL_OVERRIDES
      }
      if (initialRequest?.thinkingLevel !== undefined) {
        session.thinkingLevel = initialRequest.thinkingLevel
      }
      if (initialRequest?.thinkingDetailsRequested !== undefined) {
        session.thinkingDetailsRequested =
          initialRequest.thinkingDetailsRequested === true
      }
      if (initialRequest?.supportedTools) {
        // Freeze the array reference we capture onto the session so any
        // downstream code that holds it as a cache key (e.g. the
        // prepared-tool-build memo on `cursor-connect-stream.service`)
        // cannot have its key silently desynchronised by an in-place
        // mutation.
        session.supportedTools = freezeCacheKeyArray(
          initialRequest.supportedTools,
          []
        )
      }
      if (initialRequest) {
        // Same reference-stability guard as above.
        session.mcpToolDefs = freezeCacheKeyArray(initialRequest.mcpToolDefs)
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
        ctx.usedTokens = initialRequest.usedContextTokens
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
          `(messages=${ctx.messages.length}, records=${ctx.messageRecords.length}, blobIds=${ctx.messageBlobIds.length}, turns=${ctx.turns.length}, pending=${this.pendingToolCallCount(session.conversationId)})`
      )
    }

    this.schedulePersist(conversationId)
    return session
  }

  /**
   * Open a transcript-staging turn. Records anchors on every array
   * the addMessage path appends to (messages, messageRecords,
   * transcriptEvents, plus contextState's contextRecords) plus the
   * usedTokens scalar, so `abortTurn` can rewind atomically.
   *
   * Cursor's model is one open turn per conversation; throws if a
   * turn is already open. The supersede path in
   * cursor-connect-stream is responsible for awaiting the prior
   * turn's terminal (via `TurnLifecycle.cancelTurnAndAwait`) before
   * calling `beginTurn` for the new one — i.e. the happens-before
   * for anchor-singleton is established at the supervisor layer,
   * not by best-effort cleanup down here.
   */

  // listOverdueDeadlines / listAsyncAskFollowups / findAsyncAskFollowupById
  // moved to SessionStreamService (step 4 真正拆解). Callers inject
  // SessionStreamService directly.

  /**
   * Returns the turnId that currently owns the open transcript anchor
   * for the conversation, or undefined if no turn is open. Used by
   * cursor-connect-stream's supersede serializer to decide whether to
   * await a stale turn before begin/commit.
   */
  openTurnIdForConversation(conversationId: string): TurnId | undefined {
    return this.turnAnchors.get(conversationId)?.turnId
  }

  beginTurn(conversationId: string, turnId: TurnId): void {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`beginTurn: no session ${conversationId}`)
    }
    if (this.turnAnchors.has(conversationId)) {
      throw new Error(
        `beginTurn: conversation ${conversationId} already has an open turn`
      )
    }
    const ctx = this.contextState.getContextRecord(conversationId)!
    this.turnAnchors.set(conversationId, {
      turnId,
      messagesAt: ctx.messages.length,
      messageRecordsAt: ctx.messageRecords.length,
      transcriptEventsAt: ctx.transcriptEvents.length,
      contextRecordsAt: ctx.contextState.records.length,
      usedTokens: ctx.usedTokens,
      messagesGeneration: ctx.messagesGeneration,
    })
    // Mirror onto the TranscriptStore so its open-turn invariants
    // (no replaceCommitted mid-turn) hold even though the actual
    // staging happens through manager-level rewind.
    this.transcriptBeginTurn(ConversationId.of(conversationId), turnId)
  }

  /**
   * Close the open turn without rewinding. Anchors dropped.
   *
   * If the open anchor belongs to a different turnId, this is a
   * supersede race that the cursor-connect-stream supersede
   * serializer should have prevented. We log loudly and skip — the
   * other turn already owns the anchor and is responsible for
   * commit/abort. Throwing here used to permanently lock the
   * conversation (1:52:37 production trace).
   */
  commitTurn(conversationId: string, turnId: TurnId): void {
    const anchor = this.turnAnchors.get(conversationId)
    if (!anchor) return
    if (anchor.turnId !== turnId) {
      this.logger.warn(
        `commitTurn: anchor owned by another turn (open=${anchor.turnId} given=${turnId}); skipping. ` +
          `This indicates the supersede serializer leaked a turn — investigate.`
      )
      return
    }
    this.turnAnchors.delete(conversationId)
    this.transcriptCommitTurn(ConversationId.of(conversationId), turnId)
  }

  /**
   * Discard everything appended since beginTurn. Splices each
   * tracked array back to its anchor index and restores
   * usedTokens / messagesGeneration. Also clears any pending tool
   * calls that were registered after the anchor.
   *
   * If the open anchor belongs to a different turnId (supersede race),
   * we log and return 0 — see `commitTurn` for the same rationale.
   */
  abortTurn(conversationId: string, turnId: TurnId): number {
    const anchor = this.turnAnchors.get(conversationId)
    if (!anchor) return 0
    if (anchor.turnId !== turnId) {
      this.logger.warn(
        `abortTurn: anchor owned by another turn (open=${anchor.turnId} given=${turnId}); skipping. ` +
          `This indicates the supersede serializer leaked a turn — investigate.`
      )
      return 0
    }
    const session = this.getSession(conversationId)
    if (!session) {
      this.turnAnchors.delete(conversationId)
      return 0
    }
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    const droppedMessages = ctx.messages.length - anchor.messagesAt
    if (droppedMessages > 0) {
      ctx.messages.splice(anchor.messagesAt)
    }
    if (ctx.messageRecords.length > anchor.messageRecordsAt) {
      ctx.messageRecords.splice(anchor.messageRecordsAt)
    }
    if (ctx.transcriptEvents.length > anchor.transcriptEventsAt) {
      ctx.transcriptEvents.splice(anchor.transcriptEventsAt)
    }
    if (ctx.contextState.records.length > anchor.contextRecordsAt) {
      ctx.contextState.records.splice(anchor.contextRecordsAt)
    }
    ctx.usedTokens = anchor.usedTokens
    ctx.messagesGeneration = anchor.messagesGeneration

    // Pending tool calls registered during the aborted turn are
    // also doomed — drop them so the next turn starts clean.
    this.pendingToolAbortTurn(
      ConversationId.of(conversationId),
      turnId,
      "transcript-turn-aborted"
    )

    this.turnAnchors.delete(conversationId)
    this.transcriptAbortTurn(ConversationId.of(conversationId), turnId)
    return droppedMessages
  }

  /**
   * Add pending tool call
   */
  private resolveWorkspaceFilePath(
    session: SessionRecord,
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
    subagentOwner?: string,
    // Optional caller-supplied turnId. When omitted the resolver
    // installed by CursorConnectStreamService is queried.
    _turnId?: TurnId
  ): void {
    const stream = this.sessionStream.getStreamRecord(conversationId)!
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

      const payload: PendingToolCall = {
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
        streamId: stream.currentStreamId,
        executionStatus: "pending",
        executionOrder: this.assistantToolBatch.bumpToolExecutionOrderCounter(
          session.conversationId
        ),
        subagentOwner,
      }
      const turnId =
        _turnId ?? this.resolveTurnIdForConversation(conversationId)
      if (!turnId) {
        throw new Error(
          `addPendingToolCall: no turnId resolvable for ${conversationId}`
        )
      }
      // Resolve any prior entry under this id (legacy Map semantics
      // was overwrite — store throws on duplicate, so resolve first).
      const existing = this.pendingToolGet(
        ConversationId.of(conversationId),
        toolCallId
      )
      if (existing) {
        this.pendingToolResolve(ConversationId.of(conversationId), toolCallId)
      }
      this.pendingToolRegister<PendingToolCall>({
        conversationId: ConversationId.of(conversationId),
        turnId,
        toolCallId,
        toolName,
        startedAt: Date.now(),
        payload,
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
    return this.listPendingToolCallIds(conversationId)
  }

  // The five assistant-tool-batch methods (startAssistantToolBatch,
  // addAssistantToolBatchTools, settleAssistantToolBatchTool,
  // hasUnsettledAssistantToolBatchForBackend,
  // claimAssistantToolBatchContinuation) live on
  // AssistantToolBatchService now. Callers inject and call that
  // service directly — no facade is preserved here on purpose.

  getPendingToolCallIdsByStream(
    conversationId: string,
    streamId: string
  ): string[] {
    const session = this.getSession(conversationId)
    if (!session || !streamId) return []

    const pendingIds: string[] = []
    for (const [toolCallId, pendingToolCall] of this.listPendingToolCallEntries(
      session.conversationId
    )) {
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
    session: SessionRecord,
    toolCallId: string
  ): PendingToolCall | undefined {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    const toolCall = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!toolCall) {
      return undefined
    }

    for (const execId of toolCall.execIds) {
      stream.pendingToolCallByExecId.delete(execId)
    }
    for (const [execId, mappedToolCallId] of stream.pendingToolCallByExecId) {
      if (mappedToolCallId === toolCallId) {
        stream.pendingToolCallByExecId.delete(execId)
      }
    }
    this.resolvePendingToolCallEntry(session.conversationId, toolCallId)
    // Phase H7a: view.delete() auto-resolves in the store mirror.
    session.lastActivityAt = new Date()

    // 释放 path-level edit serialization slot（若该工具是 edit_file_v2）。
    // detach 出口统一处理，覆盖 consume / clear / 异常路径，避免后续同 path
    // edit 永久阻塞。注意：detach 自身不会派发下一个 readArgs —— 该动作只
    // 应在"成功 consume"路径触发，避免在死流上把 queue 里的 edit 也带飞。
    this.clearEditPathSlot(session, toolCall)

    return toolCall
  }

  /**
   * 释放某个 toolCallId 对 path 串行槽的占用，并把它从所有等待队列中剥离。
   *
   * 由 detachPendingToolCall 在出口调用，覆盖 consume / clear / 异常 三类路径。
   */
  private clearEditPathSlot(
    session: SessionRecord,
    toolCall: PendingToolCall
  ): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    const path = toolCall.editPath?.trim()
    if (!path) {
      // 即使没有 editPath，也把 toolCallId 从所有 queue 中扫一遍以防遗漏。
      // edit_file_v2 一定有 path，这里只是兜底。
      this.removeToolCallFromAllEditQueues(session, toolCall.toolCallId)
      return
    }

    const holder = stream.editPathHolderByPath.get(path)
    if (holder === toolCall.toolCallId) {
      stream.editPathHolderByPath.delete(path)
    }

    const queue = stream.editPathQueueByPath.get(path)
    if (queue) {
      const filtered = queue.filter(
        (item) => item.toolCallId !== toolCall.toolCallId
      )
      if (filtered.length === 0) {
        stream.editPathQueueByPath.delete(path)
      } else if (filtered.length !== queue.length) {
        stream.editPathQueueByPath.set(path, filtered)
      }
    }
  }

  private removeToolCallFromAllEditQueues(
    session: SessionRecord,
    toolCallId: string
  ): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    for (const [path, queue] of stream.editPathQueueByPath) {
      const filtered = queue.filter((item) => item.toolCallId !== toolCallId)
      if (filtered.length === 0) {
        stream.editPathQueueByPath.delete(path)
      } else if (filtered.length !== queue.length) {
        stream.editPathQueueByPath.set(path, filtered)
      }
    }
    for (const [path, holderId] of stream.editPathHolderByPath) {
      if (holderId === toolCallId) {
        stream.editPathHolderByPath.delete(path)
      }
    }
  }

  /**
   * 批量清空所有 path 串行状态。仅用于 stale pending 整批回收场景
   * （旧 BiDi 流已关闭，pending 全部作废，holder 与 queue 都不再有意义）。
   */
  private clearAllEditPathSlots(session: SessionRecord): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    stream.editPathHolderByPath.clear()
    stream.editPathQueueByPath.clear()
  }

  consumePendingToolCall(
    conversationId: string,
    toolCallId: string
  ): PendingToolCall | undefined {
    const session = this.getSession(conversationId)
    if (session) {
      const stream = this.sessionStream.getStreamRecord(session.conversationId)!
      // Snapshot pending state before mutation so notifyIfBecameIdle
      // can see the non-idle → idle edge if this consume is the last
      // outstanding work item.
      const wasPending =
        this.pendingToolCallCount(conversationId) > 0 ||
        stream.pendingInteractionQueries.size > 0
      const toolCall = this.detachPendingToolCall(session, toolCallId)
      if (toolCall) {
        // Settle this tool in the batch barrier so that continuation is only
        // triggered after ALL tools in the assistant turn have completed.
        this.assistantToolBatch.settleAssistantToolBatchTool(
          conversationId,
          toolCallId
        )
        this.logger.debug(
          `Consumed tool call: ${toolCallId} for session ${conversationId}`
        )
        this.schedulePersist(conversationId)
        this.notifyIfBecameIdleAfter(session, wasPending)
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
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (!session) return undefined

    // Snapshot before mutation (see consumePendingToolCall).
    const wasPending =
      this.pendingToolCallCount(conversationId) > 0 ||
      stream.pendingInteractionQueries.size > 0

    const toolCall = this.detachPendingToolCall(session, toolCallId)
    if (!toolCall) return undefined

    // Settle this tool in the batch barrier (same as consumePendingToolCall).
    this.assistantToolBatch.settleAssistantToolBatchTool(
      conversationId,
      toolCallId
    )

    const reasonSuffix = reason ? ` (${reason})` : ""
    this.logger.warn(
      `Cleared pending tool call: ${toolCallId} for session ${conversationId}${reasonSuffix}`
    )
    this.schedulePersist(conversationId)
    this.notifyIfBecameIdleAfter(session, wasPending)
    return toolCall
  }

  registerPendingToolExecId(
    conversationId: string,
    toolCallId: string,
    execIdNumber: number
  ): boolean {
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (!session) return false
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return false

    const pending = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!pending) {
      this.logger.warn(
        `registerPendingToolExecId: pending tool call not found: ${toolCallId}`
      )
      return false
    }

    const normalizedExecId = Math.floor(execIdNumber)
    stream.pendingToolCallByExecId.set(normalizedExecId, toolCallId)
    pending.execIds.add(normalizedExecId)
    session.lastActivityAt = new Date()
    // Arm a wall-clock deadline on the first execId mapping for this
    // tool. The PendingDeadlineSweeper scans `payload.deadline` every
    // 5s and synthesises a `[<tool> timeout]` error tool_result via
    // `expirePendingToolCall` if the IDE never closes the slot. Without
    // this, a stalled IDE leaves the conversation stuck on
    // `pendingToolCalls=1` forever — the failure mode observed in
    // agent-vibes-bridge.log on 2026-05-31 with `list_directory`.
    //
    // Long-running channels (shell, sub-agent) opt out by tool name;
    // a caller may still set an explicit deadline by writing to
    // `pending.deadline` directly after this call returns.
    if (
      pending.deadline === undefined &&
      this.shouldArmExecDispatchDeadline(pending)
    ) {
      pending.deadline = Date.now() + this.EXEC_DISPATCH_DEADLINE_MS
      this.logger.debug(
        `Armed exec-dispatch deadline (+${this.EXEC_DISPATCH_DEADLINE_MS}ms) ` +
          `for tool=${pending.toolName} toolCallId=${toolCallId} ` +
          `execId=${normalizedExecId}`
      )
    }
    this.logger.debug(
      `Mapped execId=${normalizedExecId} -> toolCallId=${toolCallId} for session ${conversationId}`
    )
    this.schedulePersist(conversationId)
    return true
  }

  /**
   * Reset a pending tool's deadline — used when the BiDi attachment
   * was torn down (Premature close), the pending was parked in
   * `awaitingClientResult`, and the IDE has now reconnected with
   * `resumeAction`. Conceptually equivalent to "the tool was just
   * dispatched": the new BiDi gets the same fresh 90s window the
   * original dispatch did.
   *
   * Returns true when a deadline was actually written; false when
   * the conversation/pending is gone or the tool opted out of the
   * sweeper (shell / sub-agent — those tools never had a deadline to
   * begin with, so reset is a no-op rather than an error).
   */
  resetPendingToolDeadline(
    conversationId: string,
    toolCallId: string
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    const pending = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!pending) return false
    if (!this.shouldArmExecDispatchDeadline(pending)) return false

    pending.deadline = Date.now() + this.EXEC_DISPATCH_DEADLINE_MS
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Reset exec-dispatch deadline (+${this.EXEC_DISPATCH_DEADLINE_MS}ms) ` +
        `for tool=${pending.toolName} toolCallId=${toolCallId} ` +
        `(post-resumeAction reattach)`
    )
    this.schedulePersist(conversationId)
    return true
  }

  /**
   * Decide whether `registerPendingToolExecId` should auto-arm the
   * sweeper deadline. The default is true; tools that legitimately
   * run for minutes / hours (shell streams, sub-agent execs) opt out
   * via `EXEC_DISPATCH_DEADLINE_EXEMPT_TOOLS`. Family hint takes
   * priority for paths where the tool name was canonicalised away.
   */
  private shouldArmExecDispatchDeadline(pending: PendingToolCall): boolean {
    if (pending.subagentOwner) {
      // Sub-agent dispatch frames stay open for the lifetime of the
      // child run — the parent's `task` tool result is what eventually
      // closes them. Skip the deadline so the parent's own deadline
      // remains the single source of truth.
      return false
    }
    const normalized = (pending.toolName || "").trim().toLowerCase()
    if (this.EXEC_DISPATCH_DEADLINE_EXEMPT_TOOLS.has(normalized)) {
      return false
    }
    return true
  }

  markPendingToolCallStarted(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    const pending = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!pending) return
    session.lastActivityAt = new Date()
    pending.startedEmitted = true
    this.schedulePersist(conversationId)
  }

  updatePendingToolExecution(
    conversationId: string,
    toolCallId: string,
    update: {
      executionOwner?: ToolExecutionOwner
      executionStatus?: ToolExecutionStatus
      executionRecoveryReason?: ToolExecutionRecoveryReason
      executionOrder?: number
    }
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    const pending = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!pending) return false

    if (update.executionOwner) {
      pending.executionOwner = update.executionOwner
    }
    if (update.executionStatus) {
      pending.executionStatus = update.executionStatus
    }
    if (update.executionRecoveryReason) {
      pending.executionRecoveryReason = update.executionRecoveryReason
    }
    if (
      typeof update.executionOrder === "number" &&
      Number.isFinite(update.executionOrder)
    ) {
      pending.executionOrder = Math.max(0, Math.floor(update.executionOrder))
    }
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return true
  }

  getPendingToolCallIdByExecId(
    conversationId: string,
    execIdNumber: number
  ): string | undefined {
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (!session) return undefined
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return undefined
    return stream.pendingToolCallByExecId.get(Math.floor(execIdNumber))
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
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (!session || this.pendingToolCallCount(session.conversationId) === 0)
      return 0

    const count = this.pendingToolCallCount(session.conversationId)
    const clearedIds = this.listPendingToolCallIds(session.conversationId)

    this.clearAllPendingToolCalls(session.conversationId)
    stream.pendingToolCallByExecId.clear()
    // Phase H7a: view.clear() auto-resolves all entries in the
    // store mirror.
    // Also clear the batch barrier — all pending tools are being discarded.
    this.assistantToolBatch.clearAssistantToolBatch(session.conversationId)
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
   * Returns the AbortSignal bound to the conversation's currently
   * active leaf turn (chat ParentTurn, foreground sub-agent, or the
   * bidi-umbrella when no chat turn is in flight). Callers capture
   * the signal at the start of the operation and pass it through
   * every await. When the supervisor cancels the leaf — supersede,
   * bidi-close, user-cancel, parent-cancel, shutdown — the signal
   * aborts and every still-listening await throws synchronously on
   * its next `throwIfAborted` or signal-aware fetch.
   *
   * Returns `undefined` when no turn is active for the conversation
   * (idle session, hydration before first attach, unit-test paths
   * that did not install the resolver). Callers in those situations
   * fall back to a fresh AbortController so their await chain can
   * still run, but without supersede semantics.
   */
  getCurrentTurnAbortSignal(conversationId: string): AbortSignal | undefined {
    return this.activeTurnSignalResolver?.(conversationId)
  }

  /**
   * Get session
   */
  getSession(conversationId: string): SessionLifecycleRecord | undefined {
    return (
      this.sessions.get(conversationId) ||
      this.loadPersistedSession(conversationId)
    )
  }

  // ─── Lifecycle-domain field accessors ─────────────────────────
  // step 4 终结: caller 不再 `session.xxx`,通过这些 method 访问
  // SessionLifecycleFields 字段。physical record 仍是单 SessionRecord
  // 对象(performance: hot-path zero-copy reads), 但 accessor 是
  // single point of mutation.

  getModel(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.model
  }
  setModel(conversationId: string, model: string): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.model = model
    this.markSessionDirty(conversationId)
  }
  getSupportedTools(conversationId: string): string[] {
    return this.getSession(conversationId)?.supportedTools ?? []
  }
  setSupportedTools(conversationId: string, tools: string[]): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.supportedTools = tools
  }
  getMcpToolDefs(
    conversationId: string
  ): ParsedCursorRequest["mcpToolDefs"] | undefined {
    return this.getSession(conversationId)?.mcpToolDefs
  }
  setMcpToolDefs(
    conversationId: string,
    mcpToolDefs: ParsedCursorRequest["mcpToolDefs"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.mcpToolDefs = mcpToolDefs
  }
  getProjectContext(
    conversationId: string
  ): ParsedCursorRequest["projectContext"] | undefined {
    return this.getSession(conversationId)?.projectContext
  }
  setProjectContext(
    conversationId: string,
    projectContext: ParsedCursorRequest["projectContext"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.projectContext = projectContext
  }
  getCursorRules(
    conversationId: string
  ): ParsedCursorRequest["cursorRules"] | undefined {
    return this.getSession(conversationId)?.cursorRules
  }
  setCursorRules(
    conversationId: string,
    rules: ParsedCursorRequest["cursorRules"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.cursorRules = rules
  }
  getCustomSystemPrompt(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.customSystemPrompt
  }
  setCustomSystemPrompt(
    conversationId: string,
    prompt: string | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.customSystemPrompt = prompt
  }
  getRequestContextEnv(
    conversationId: string
  ): ParsedCursorRequest["requestContextEnv"] | undefined {
    return this.getSession(conversationId)?.requestContextEnv
  }
  setRequestContextEnv(
    conversationId: string,
    env: ParsedCursorRequest["requestContextEnv"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.requestContextEnv = env
  }
  getDiscoveredTools(conversationId: string): Set<string> {
    return this.getSession(conversationId)?.discoveredTools ?? new Set<never>()
  }
  addDiscoveredTool(conversationId: string, toolName: string): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.discoveredTools.add(toolName)
    this.markSessionDirty(conversationId)
  }
  getDeferredToolCatalog(
    conversationId: string
  ): DeferredToolDescriptor[] | undefined {
    return this.getSession(conversationId)?.deferredToolCatalog
  }
  setDeferredToolCatalog(
    conversationId: string,
    catalog: DeferredToolDescriptor[] | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.deferredToolCatalog = catalog
  }
  getPreparedToolBuild(
    conversationId: string
  ): SessionPreparedToolBuild | undefined {
    return this.getSession(conversationId)?.preparedToolBuild
  }
  setPreparedToolBuild(
    conversationId: string,
    build: SessionPreparedToolBuild | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.preparedToolBuild = build
  }
  getSubagentModelOverrides(conversationId: string): SubagentModelOverridesMap {
    return (
      this.getSession(conversationId)?.subagentModelOverrides ??
      EMPTY_SUBAGENT_MODEL_OVERRIDES
    )
  }
  setSubagentModelOverrides(
    conversationId: string,
    overrides: SubagentModelOverridesMap
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.subagentModelOverrides = overrides
  }
  getThinkingLevel(conversationId: string): number {
    return this.getSession(conversationId)?.thinkingLevel ?? 0
  }
  setThinkingLevel(conversationId: string, level: number): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.thinkingLevel = level
  }
  getThinkingDetailsRequested(conversationId: string): boolean {
    return this.getSession(conversationId)?.thinkingDetailsRequested ?? false
  }
  setThinkingDetailsRequested(conversationId: string, value: boolean): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.thinkingDetailsRequested = value
  }
  getIsAgentic(conversationId: string): boolean {
    return this.getSession(conversationId)?.isAgentic ?? false
  }
  setIsAgentic(conversationId: string, value: boolean): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.isAgentic = value
  }
  getUseWeb(conversationId: string): boolean {
    return this.getSession(conversationId)?.useWeb ?? false
  }
  setUseWeb(conversationId: string, value: boolean): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.useWeb = value
  }
  getCreatedAt(conversationId: string): Date | undefined {
    return this.getSession(conversationId)?.createdAt
  }
  getLastActivityAt(conversationId: string): Date | undefined {
    return this.getSession(conversationId)?.lastActivityAt
  }
  touchLastActivityAt(conversationId: string): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.lastActivityAt = new Date()
  }
  getLastAssistantBackend(conversationId: string): BackendType | undefined {
    return this.getSession(conversationId)?.lastAssistantBackend
  }
  getLastAssistantModel(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.lastAssistantModel
  }
  getLastToolUseSummary(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.lastToolUseSummary
  }
  setLastToolUseSummary(
    conversationId: string,
    summary: string | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.lastToolUseSummary = summary
  }
  getDeferredControlContinuations(
    conversationId: string
  ): SessionRecord["deferredControlContinuations"] {
    return this.getSession(conversationId)?.deferredControlContinuations ?? []
  }
  enqueueDeferredControlContinuation(
    conversationId: string,
    entry: SessionRecord["deferredControlContinuations"][number]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.deferredControlContinuations.push(entry)
  }
  drainDeferredControlContinuations(
    conversationId: string
  ): SessionRecord["deferredControlContinuations"] {
    const s = this.getSession(conversationId)
    if (!s) return []
    const drained = [...s.deferredControlContinuations]
    s.deferredControlContinuations.length = 0
    return drained
  }
  getRequestedMaxOutputTokens(conversationId: string): number | undefined {
    return this.getSession(conversationId)?.requestedMaxOutputTokens
  }
  setRequestedMaxOutputTokens(
    conversationId: string,
    value: number | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.requestedMaxOutputTokens = value
  }
  getRequestedModelParameters(
    conversationId: string
  ): Record<string, string> | undefined {
    return this.getSession(conversationId)?.requestedModelParameters
  }
  setRequestedModelParameters(
    conversationId: string,
    params: Record<string, string> | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.requestedModelParameters = params
  }
  getContextTokenLimit(conversationId: string): number | undefined {
    return this.getSession(conversationId)?.contextTokenLimit
  }
  setContextTokenLimit(
    conversationId: string,
    value: number | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.contextTokenLimit = value
  }
  getContextMaxMode(conversationId: string): boolean | undefined {
    return this.getSession(conversationId)?.contextMaxMode
  }
  setContextMaxMode(conversationId: string, value: boolean | undefined): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.contextMaxMode = value
  }
  getUsedContextTokens(conversationId: string): number | undefined {
    return this.getSession(conversationId)?.usedContextTokens
  }
  setUsedContextTokens(
    conversationId: string,
    value: number | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.usedContextTokens = value
  }
  getActiveCursorSkillNames(conversationId: string): string[] | undefined {
    return this.getSession(conversationId)?.activeCursorSkillNames
  }
  setActiveCursorSkillNames(
    conversationId: string,
    names: string[] | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.activeCursorSkillNames = names
  }
  getCodeChunks(
    conversationId: string
  ): ParsedCursorRequest["codeChunks"] | undefined {
    return this.getSession(conversationId)?.codeChunks
  }
  setCodeChunks(
    conversationId: string,
    chunks: ParsedCursorRequest["codeChunks"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.codeChunks = chunks
  }
  getCursorCommands(
    conversationId: string
  ): ParsedCursorRequest["cursorCommands"] | undefined {
    return this.getSession(conversationId)?.cursorCommands
  }
  setCursorCommands(
    conversationId: string,
    commands: ParsedCursorRequest["cursorCommands"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.cursorCommands = commands
  }
  getSelectedCursorRulePaths(
    conversationId: string
  ): ParsedCursorRequest["selectedCursorRulePaths"] | undefined {
    return this.getSession(conversationId)?.selectedCursorRulePaths
  }
  setSelectedCursorRulePaths(
    conversationId: string,
    paths: ParsedCursorRequest["selectedCursorRulePaths"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.selectedCursorRulePaths = paths
  }
  getSelectedCursorRuleNames(
    conversationId: string
  ): ParsedCursorRequest["selectedCursorRuleNames"] | undefined {
    return this.getSession(conversationId)?.selectedCursorRuleNames
  }
  setSelectedCursorRuleNames(
    conversationId: string,
    names: ParsedCursorRequest["selectedCursorRuleNames"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.selectedCursorRuleNames = names
  }
  getExplicitContext(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.explicitContext
  }
  setExplicitContext(conversationId: string, value: string | undefined): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.explicitContext = value
  }
  getBrowserContext(
    conversationId: string
  ): SessionRecord["browserContext"] | undefined {
    return this.getSession(conversationId)?.browserContext
  }
  setBrowserContext(
    conversationId: string,
    ctx: SessionRecord["browserContext"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.browserContext = ctx
  }

  /**
   * Iterate every in-memory session. Public so SessionStreamService /
   * other domain services can run cross-session sweeps (overdue
   * deadlines, stale shell streams, async-ask followup rollup) without
   * reaching into the private sessions map.
   */
  iterateSessions(): IterableIterator<[string, SessionLifecycleRecord]> {
    return this.sessions.entries()
  }

  /**
   * Domain-typed record accessors. Each returns a view of the
   * physical session record narrowed to the domain that owns the
   * fields. Caller code that needs cross-domain reads must call the
   * accessor for each domain it touches, eliminating the legacy
   * `session.everything` anti-pattern at the type layer.
   */
  getLifecycleRecord(
    conversationId: string
  ): SessionLifecycleRecord | undefined {
    return this.getSession(conversationId)
  }
  getContextRecord(conversationId: string): ContextStateRecord | undefined {
    return this.contextState.getContextRecord(conversationId)
  }
  getStreamRecord(conversationId: string): SessionStreamRecord | undefined {
    return this.sessionStream.getStreamRecord(conversationId)
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
      ReturnType<SessionLifecycleService["buildSessionSummary"]>
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
    session: SessionRecord
  ): {
    conversationId: string
    model: string
    messageCount: number
    transcriptRecordCount: number
    activeCompactionId?: string
    compactionEpoch: number
    lastActivityAt: string
  } {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    return {
      conversationId,
      model: session.model || "",
      messageCount: ctx.messages.length,
      transcriptRecordCount: ctx.messageRecords.length,
      activeCompactionId: ctx.contextState.activeCompactionId,
      compactionEpoch: ctx.contextState.compactionEpoch ?? 0,
      lastActivityAt: session.lastActivityAt.toISOString(),
    }
  }

  /**
   * Delete session
   */
  deleteSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (session) {
      const stream = this.sessionStream.getStreamRecord(session.conversationId)
      if (stream) stream.pendingInteractionQueries.clear()
      this.onSessionCleanupHandler?.(conversationId, session)
    }
    this.clearScheduledPersist(conversationId)
    // Step 4 物理拆: fan-out 到三个 service 各自的 record map,否则
    // context/stream record 在 lifecycle delete 后泄漏。
    this.sessions.delete(conversationId)
    this.contextState.deleteRecord(conversationId)
    this.sessionStream.deleteRecord(conversationId)
    this.deletePersistedSession(conversationId)
    this.deleteToolResultStorage(conversationId)
    this.logger.log(`Deleted session: ${conversationId}`)
  }

  clearAllSessionCaches(): ClearSessionCacheResult {
    const warnings: string[] = []
    const loadedSessionIds = Array.from(this.sessions.keys())

    // Refuse mid-flight: if any in-memory session still has unresolved
    // tool calls or in-flight interaction queries, clearing right now
    // would tear down state under an active turn-runner. The user
    // sees a warning and the operation is a no-op.
    const busySessionIds = loadedSessionIds.filter((conversationId) => {
      const session = this.sessions.get(conversationId)
      if (!session) return false
      const stream = this.sessionStream.getStreamRecord(conversationId)
      return (
        this.pendingToolCallCount(session.conversationId) > 0 ||
        (stream?.pendingInteractionQueries.size ?? 0) > 0
      )
    })

    if (busySessionIds.length > 0) {
      warnings.push(
        `Refused to clear cache because ${busySessionIds.length} active session(s) still have pending work.`
      )
      return {
        clearedLoadedSessions: 0,
        clearedPersistedSessions: 0,
        clearedToolResultDirs: 0,
        warnings,
      }
    }

    // 1. Drop every in-memory record in lifecycle / context-state /
    //    session-stream. We deliberately do not call `deleteSession`
    //    here because that fan-out also issues per-conversation SQL
    //    DELETEs and per-conversation rmSyncs, which is O(N²) when we
    //    are about to truncate everything anyway.
    let clearedLoadedSessions = 0
    for (const conversationId of loadedSessionIds) {
      const session = this.sessions.get(conversationId)
      if (session) {
        const stream = this.sessionStream.getStreamRecord(
          session.conversationId
        )
        if (stream) stream.pendingInteractionQueries.clear()
        this.onSessionCleanupHandler?.(conversationId, session)
      }
      this.clearScheduledPersist(conversationId)
      this.sessions.delete(conversationId)
      this.contextState.deleteRecord(conversationId)
      this.sessionStream.deleteRecord(conversationId)
      clearedLoadedSessions++
    }

    // 2. Truncate the v2 SQLite schema in one shot. The `sessions`
    //    table is the parent of every other session-* table via
    //    `ON DELETE CASCADE`, so a single `DELETE FROM sessions` also
    //    wipes session_messages, tool_call_ledger, turn_events,
    //    session_file_states, session_todos, session_message_blobs,
    //    and session_read_paths. If the persistence layer happens to
    //    not be ready yet (very early in boot), skip silently — there
    //    is nothing on disk to clear.
    let clearedPersistedSessions = 0
    if (this.persistence.isReady) {
      try {
        const persistedTotal = this.sessionPersistence.deleteAllSessions()
        // The dashboard payload reports "persisted-only" sessions
        // separately, so subtract the in-memory set from the total.
        clearedPersistedSessions = Math.max(
          0,
          persistedTotal - clearedLoadedSessions
        )
      } catch (error) {
        this.logger.error(
          `Failed to truncate persisted session cache: ${String(error)}`
        )
        warnings.push(
          `Failed to fully clear persisted session cache: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    // 3. Remove every tool-result spool directory, including orphan
    //    directories whose conversation row no longer exists.
    let clearedToolResultDirs = 0
    try {
      clearedToolResultDirs = this.toolResultStorage.clearAll().clearedDirCount
    } catch (error) {
      this.logger.warn(
        `Failed to clear tool-results directory: ${String(error)}`
      )
      warnings.push(
        `Failed to clear tool-results directory: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.logger.log(
      `Cleared session caches (loaded=${clearedLoadedSessions} persisted=${clearedPersistedSessions} toolDirs=${clearedToolResultDirs})`
    )

    return {
      clearedLoadedSessions,
      clearedPersistedSessions,
      clearedToolResultDirs,
      warnings,
    }
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
      const stream = this.sessionStream.getStreamRecord(conversationId)
      if (!stream) continue

      const hasPendingWork =
        this.pendingToolCallCount(session.conversationId) > 0 ||
        stream.pendingInteractionQueries.size > 0
      if (hasPendingWork) {
        this.logger.debug(
          `Skipping cleanup for session ${conversationId}: pendingToolCalls=${this.pendingToolCallCount(session.conversationId)}, pendingInteractionQueries=${stream.pendingInteractionQueries.size}`
        )
        continue
      }

      this.clearScheduledPersist(conversationId)
      this.onSessionCleanupHandler?.(conversationId, session)
      this.sessions.delete(conversationId)
      this.contextState.deleteRecord(conversationId)
      this.sessionStream.deleteRecord(conversationId)
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

  getAnalyticsSummary(limit = 12): ChatSessionAnalyticsSummary {
    const now = Date.now()
    const sessions = new Map<
      string,
      {
        session: SessionRecord
        loaded: boolean
      }
    >()

    for (const [conversationId, session] of this.sessions.entries()) {
      sessions.set(conversationId, { session, loaded: true })
    }

    if (this.persistence.isReady) {
      try {
        for (const summary of this.sessionPersistence.listSessions()) {
          const conversationId = summary.conversationId as string
          if (sessions.has(conversationId)) continue
          try {
            const row = this.sessionPersistence.loadSession(
              ConversationId.of(conversationId)
            )
            if (!row) continue
            const persisted = row.config as unknown as PersistedChatSessionV1

            // Analytics-side lifecycle:
            //   1. Parse config blob → SessionRecord (pure)
            //   2. Use the session for analytics WITHOUT mounting it
            //      into `this.sessions` — these are "transient view"
            //      sessions, not active ones. The next mutating
            //      operation that needs them will go through
            //      getSession()→loadPersistedSession() and properly
            //      mount + log + audit at that point.
            //
            // Step 1 of the refactor removed the analytics-side silent
            // integrity-repair-and-rewrite loop because protocol
            // integrity is now a ledger invariant, not something the
            // analytics dashboard fixes after the fact.
            const session = this.parsePersistedSession(persisted)
            sessions.set(conversationId, {
              session,
              loaded: false,
            })
          } catch (error) {
            this.logger.warn(
              `Failed to deserialize analytics session ${conversationId}: ${String(error)}`
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
    session: SessionRecord,
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
      agentType: ctx.agentType,
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
    // P0-2 / smoke-regression #1: when a sub-agent settles (completed /
    // failed / killed), the IDE never emits matching `streamClose`
    // frames for the shell streams the sub-agent owned, because from
    // the IDE's perspective the sub-agent's outer toolCall has already
    // finished. Without an explicit sweep here, those shell_stream
    // pending entries linger in `session.pendingToolCalls` forever and
    // the parent BiDi loop logs `Still waiting for pendingToolCalls=N`
    // indefinitely. Cheap no-op when no owned entries are pending.
    let strandedOwned = 0
    for (const [pendingToolCallId, pending] of this.listPendingToolCallEntries(
      session.conversationId
    )) {
      if (pending.subagentOwner !== subagentId) continue
      this.resolvePendingToolCallEntry(
        session.conversationId,
        pendingToolCallId
      )
      // Phase H7a: view.delete() auto-resolves the store mirror.
      strandedOwned += 1
      this.logger.warn(
        `Released stranded pending tool call ${pendingToolCallId} ` +
          `(${pending.toolName}) owned by settled sub-agent ${subagentId}`
      )
    }
    session.lastActivityAt = new Date()
    this.logger.log(
      `Cleared SubAgentContext for ${conversationId}: subagentId=${subagentId} ` +
        `(remaining=${session.subAgentContexts.size}, ` +
        `releasedStrandedPending=${strandedOwned})`
    )
    this.schedulePersist(conversationId)
  }

  /**
   * P0-2 (#17 extension) / smoke-regression #17:
   *
   * Scan all sessions and release pending shell_stream tool calls
   * whose owning shell process has terminated but never produced a
   * matching `ExecClientControlMessage.streamClose` consumed by the
   * service layer. Without this watchdog the parent BiDi loop logs
   * `Still waiting for pendingToolCalls=N` indefinitely (562 such
   * lines observed across a single 2-hour smoke session in the
   * pre-fix bridge log).
   *
   * Per Cursor `agent.v1`, `ExecClientControlMessage.streamClose` is
   * a control-plane signal that the IDE has finished writing stream
   * chunks for `id`. cursor-request-parser parses it into
   * `execStreamClose` ParsedCursorRequest, but cursor-connect-stream
   * has no consumer for that case (verified: `streamClose` does not
   * appear in the service file at all). Adding a service-layer
   * handler now would race with `consumePendingToolCallByExecId` on
   * shell_result frames, so this is a strictly additive watchdog —
   * only entries demonstrably abandoned past STALE_SHELL_STREAM_MS
   * are reaped. Live commands and the existing happy path are
   * unaffected.
   *
   * Stale criterion (all must hold):
   *   1. `pendingToolCall.shellStreamOutput.started === true`
   *   2. `sentAt` older than STALE_SHELL_STREAM_MS (5 min)
   *   3. NOT owned by any active sub-agent (already swept by
   *      `clearSubAgentContext`'s strandedOwned loop on settle)
   *
   * Returns the number of pending entries released across all
   * sessions.
   */
  static readonly STALE_SHELL_STREAM_MS = 5 * 60 * 1000

  /** P0-2 (#17) watchdog 计时器句柄，仅进程级状态，不进入持久化。 */
  private shellStreamWatchdogInterval?: NodeJS.Timeout

  sweepStaleShellStreamPending(now: number = Date.now()): number {
    let releasedTotal = 0
    const threshold = SessionLifecycleService.STALE_SHELL_STREAM_MS
    for (const session of this.sessions.values()) {
      const subAgentOwnedToolCallIds = new Set<string>()
      for (const ctx of session.subAgentContexts.values()) {
        for (const id of ctx.pendingToolCallIds) {
          subAgentOwnedToolCallIds.add(id)
        }
      }
      let releasedInSession = 0
      for (const [toolCallId, pending] of this.listPendingToolCallEntries(
        session.conversationId
      )) {
        if (subAgentOwnedToolCallIds.has(toolCallId)) continue
        if (!pending.shellStreamOutput?.started) continue
        const idleMs = now - pending.sentAt.getTime()
        if (idleMs < threshold) continue
        this.resolvePendingToolCallEntry(session.conversationId, toolCallId)
        // Phase H7a: view.delete() auto-resolves the store mirror.
        releasedInSession += 1
        this.logger.warn(
          `Released stranded top-level shell_stream pending tool call ` +
            `${toolCallId} (${pending.toolName}); idle=${idleMs}ms, ` +
            `streamClose never observed`
        )
      }
      if (releasedInSession > 0) {
        session.lastActivityAt = new Date()
        this.schedulePersist(session.conversationId)
        releasedTotal += releasedInSession
      }
    }
    return releasedTotal
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
    this.contextState.markContextStateDirty(conversationId)
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
      this.contextState.markContextStateDirty(conversationId)
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
  private loadConfiguredAdditionalRoots(session: SessionRecord): void {
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

// ─── Inlined from the deleted cursor-turn-state.ts ────────────
// Cursor IDE-protocol-facing turn state machine. Distinct from
// turn-event.ts (which is the bridge-internal lifecycle audit
// log) — this captures cursor-specific phases (waiting_for_tools,
// max_output_tokens_recovery, backend_switch, etc.) that the
// bridge surfaces for IDE-side trace consumers.

export type CursorTurnPhase =
  | "received"
  | "context_preparing"
  | "context_ready"
  | "request_streaming"
  | "waiting_for_tools"
  | "continuing_after_tool"
  | "retrying"
  | "completed"
  | "failed"
  | "aborted"

export type CursorTurnOrigin =
  | "chat"
  | "tool_result"
  | "shell_result"
  | "recovery"

export type CursorTurnTransitionReason =
  | "new_chat_turn"
  | "context_preparation_started"
  | "context_collapse_applied"
  | "context_compaction_applied"
  | "context_prepared"
  | "backend_stream_started"
  | "reactive_context_retry"
  | "backend_switch"
  | "assistant_tool_batch"
  | "tool_result_continuation"
  | "shell_result_continuation"
  | "empty_stream_retry"
  | "thinking_only_recovery"
  | "max_output_tokens_escalate"
  | "max_output_tokens_recovery"
  | "max_output_tokens_exhausted"
  | "partial_stream_finalized"
  | "assistant_final"
  | "friendly_final"
  | "superseded_stream"
  | "stream_aborted"
  | "stream_error"

export type CursorTurnDetailValue = string | number | boolean | null

export type CursorTurnDetails = Record<string, CursorTurnDetailValue>

export interface CursorTurnTransition {
  reason: CursorTurnTransitionReason
  phase: CursorTurnPhase
  at: number
  attempt: number
  backend?: string
  model?: string
  details?: CursorTurnDetails
}

export interface CursorTurnState {
  id: string
  conversationId: string
  origin: CursorTurnOrigin
  phase: CursorTurnPhase
  startedAt: number
  updatedAt: number
  attempt: number
  streamId?: string
  backend?: string
  model?: string
  backendModel?: string
  lastTransition: CursorTurnTransition
  transitions: CursorTurnTransition[]
}

export interface CreateCursorTurnStateInput {
  id: string
  conversationId: string
  origin: CursorTurnOrigin
  now: number
  initialReason?: CursorTurnTransitionReason
  streamId?: string
  backend?: string
  model?: string
  backendModel?: string
  details?: CursorTurnDetails
}

export interface CursorTurnTransitionInput {
  phase: CursorTurnPhase
  reason: CursorTurnTransitionReason
  now: number
  backend?: string
  model?: string
  backendModel?: string
  streamId?: string
  incrementAttempt?: boolean
  details?: CursorTurnDetails
}

const MAX_RETAINED_TRANSITIONS = 32

export function createCursorTurnState(
  input: CreateCursorTurnStateInput
): CursorTurnState {
  const firstTransition: CursorTurnTransition = {
    reason: input.initialReason ?? "new_chat_turn",
    phase: "received",
    at: input.now,
    attempt: 0,
    backend: input.backend,
    model: input.model,
    details: input.details,
  }

  return {
    id: input.id,
    conversationId: input.conversationId,
    origin: input.origin,
    phase: "received",
    startedAt: input.now,
    updatedAt: input.now,
    attempt: 0,
    streamId: input.streamId,
    backend: input.backend,
    model: input.model,
    backendModel: input.backendModel,
    lastTransition: firstTransition,
    transitions: [firstTransition],
  }
}

export function transitionCursorTurnState(
  state: CursorTurnState,
  input: CursorTurnTransitionInput
): CursorTurnState {
  const nextAttempt = input.incrementAttempt ? state.attempt + 1 : state.attempt
  const transition: CursorTurnTransition = {
    reason: input.reason,
    phase: input.phase,
    at: input.now,
    attempt: nextAttempt,
    backend: input.backend ?? state.backend,
    model: input.model ?? state.model,
    details: input.details,
  }

  return {
    ...state,
    phase: input.phase,
    updatedAt: input.now,
    attempt: nextAttempt,
    streamId: input.streamId ?? state.streamId,
    backend: input.backend ?? state.backend,
    model: input.model ?? state.model,
    backendModel: input.backendModel ?? state.backendModel,
    lastTransition: transition,
    transitions: [...state.transitions, transition].slice(
      -MAX_RETAINED_TRANSITIONS
    ),
  }
}

export function summarizeCursorTurnState(state: CursorTurnState): string {
  const parts = [
    `turn=${state.id}`,
    `conversation=${state.conversationId}`,
    `phase=${state.phase}`,
    `reason=${state.lastTransition.reason}`,
    `attempt=${state.attempt}`,
  ]

  if (state.backend) parts.push(`backend=${state.backend}`)
  if (state.backendModel) parts.push(`backendModel=${state.backendModel}`)
  if (state.model) parts.push(`model=${state.model}`)
  if (state.streamId) parts.push(`stream=${state.streamId}`)

  return parts.join(" ")
}
