import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import {
  type ContextStateRecord,
  createCursorTurnState,
  makeSessionMessage,
  type MessageContent,
  type PendingToolCall,
  type SessionMessage,
  type SessionMessageInit,
  type SessionReadSnapshot,
  type SessionSnipBoundary,
  type SessionSnipState,
  type SessionTodoItem,
  type SessionToolMetrics,
  type SessionTopLevelAgentTurnState,
  type SessionTranscriptEvent,
  SessionLifecycleService,
  summarizeCursorTurnState,
  transitionCursorTurnState,
  type CursorTurnDetails,
  type CursorTurnOrigin,
  type CursorTurnPhase,
  type CursorTurnState,
  type CursorTurnTransitionReason,
} from "./session-lifecycle.service"
import {
  applyTaskBudgetCompactionDeduction,
  type SessionTaskBudgetState,
  syncSessionTaskBudgetTotal,
  toTaskBudgetParam,
  type TaskBudgetParam,
} from "./task-budget-state"
import type {
  ContextConversationState,
  ContextInvestigationMemoryEntry,
  ContextTranscriptRecord,
  ContextUsageLedgerState,
  ContextUsageSnapshot,
  ContentBlock,
  InvestigationMemorySummaryLike,
} from "../../../context/types"
import type { BackendType } from "../../../llm/shared/model-router.service"
import { ConversationId, type TurnId } from "../turn/turn.types"
import { MessageStore } from "./message-store.service"
import { ToolCallLedger } from "./tool-call-ledger.service"

/**
 * ContextStateService — step 4 真正拆解 product.
 *
 * Owns the in-session "context state" domain: transcript writes,
 * cursor turn state machine, task budget, read paths / snapshots,
 * file states, tool metrics, snip projection, investigation memory,
 * per-session counters.
 *
 * Field storage stays on the legacy SessionRecord owned by
 * SessionLifecycleService; this service reads / writes those fields
 * through `sessionLifecycle.getSession(cid)`. Persistence
 * scheduling and the structural transcript helpers
 * (appendTranscriptEvent / reconcileMessageRecords / etc.) live on
 * SessionLifecycleService and are accessed via that handle.
 *
 * forwardRef is used because step-4 lifecycle helpers are accessed
 * from here and the lifecycle conversely may call back — circular
 * DI is resolved at constructor time.
 */
@Injectable()
export class ContextStateService {
  private readonly logger = new Logger(ContextStateService.name)

  // Step 4 物理拆: 独立持有 ContextStateRecord 对象,与
  // SessionLifecycleService.lifecycleRecords / SessionStreamService.streamRecords
  // 完全分离的物理对象。
  private readonly contextRecords = new Map<string, ContextStateRecord>()

  // Mirror the constants on SessionLifecycleService so methods that
  // were lifted from there can stay verbatim. Keep these in sync if
  // the values ever drift on the lifecycle side.
  private readonly TURN_STATE_HISTORY_LIMIT = 32
  private readonly MAX_READ_SNAPSHOTS_PER_FILE = 4
  private readonly MAX_READ_SNAPSHOTS_PER_SESSION = 64
  private readonly MAX_READ_SNAPSHOT_CHARS = 32_768

  constructor(
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly messageStore: MessageStore,
    private readonly toolCallLedger: ToolCallLedger
  ) {}

  // ── Record lifecycle (step 4 物理拆) ─────────────────────────

  /**
   * Get the context-state record for a conversation. Returns
   * undefined if the conversation has no in-memory record yet (the
   * lifecycle service is responsible for creating it via
   * createInitialRecord on session create / load).
   */
  getContextRecord(conversationId: string): ContextStateRecord | undefined {
    return this.contextRecords.get(conversationId)
  }

  /**
   * Create a fresh ContextStateRecord — called by SessionLifecycleService
   * on createFreshSession / parsePersistedSession. Returns the record
   * so the lifecycle layer can stamp it into the v1 persisted blob
   * round-trip during the migration window.
   */
  createInitialRecord(
    conversationId: string,
    init: ContextStateRecord
  ): ContextStateRecord {
    this.contextRecords.set(conversationId, init)
    return init
  }

  /**
   * Drop the context record for a conversation — called by
   * SessionLifecycleService.deleteSession / clearAllSessionCaches.
   */
  deleteRecord(conversationId: string): boolean {
    return this.contextRecords.delete(conversationId)
  }

  /**
   * Iterate every context record in memory. Used by cross-session
   * sweeps that need access to context-state fields.
   */
  iterateRecords(): IterableIterator<[string, ContextStateRecord]> {
    return this.contextRecords.entries()
  }

  startCursorTurn(
    conversationId: string,
    input: {
      origin: CursorTurnOrigin
      initialReason?: CursorTurnTransitionReason
      streamId?: string
      backend?: string
      model?: string
      backendModel?: string
      details?: CursorTurnDetails
    }
  ): CursorTurnState | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return undefined

    const state = createCursorTurnState({
      id: crypto.randomUUID(),
      conversationId,
      origin: input.origin,
      now: Date.now(),
      initialReason: input.initialReason,
      streamId: input.streamId,
      backend: input.backend,
      model: input.model,
      backendModel: input.backendModel,
      details: input.details,
    })
    ctx!.currentTurnState = state
    ctx!.recentTurnStates = [...ctx!.recentTurnStates, state].slice(
      -this.TURN_STATE_HISTORY_LIMIT
    )
    session.lastActivityAt = new Date()
    this.logger.debug(`[turn-state] ${summarizeCursorTurnState(state)}`)
    return state
  }
  recordCursorTurnTransition(
    conversationId: string,
    input: {
      phase: CursorTurnPhase
      reason: CursorTurnTransitionReason
      streamId?: string
      backend?: string
      model?: string
      backendModel?: string
      incrementAttempt?: boolean
      details?: CursorTurnDetails
    }
  ): CursorTurnState | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx?.currentTurnState) return undefined

    const nextState = transitionCursorTurnState(ctx.currentTurnState, {
      phase: input.phase,
      reason: input.reason,
      now: Date.now(),
      streamId: input.streamId,
      backend: input.backend,
      model: input.model,
      backendModel: input.backendModel,
      incrementAttempt: input.incrementAttempt,
      details: input.details,
    })
    ctx.currentTurnState = nextState
    ctx.recentTurnStates = ctx.recentTurnStates
      .filter((state) => state.id !== nextState.id)
      .concat(nextState)
      .slice(-this.TURN_STATE_HISTORY_LIMIT)
    session.lastActivityAt = new Date()
    this.logger.debug(`[turn-state] ${summarizeCursorTurnState(nextState)}`)
    return nextState
  }
  getCursorTurnState(conversationId: string): CursorTurnState | undefined {
    return this.contextRecords.get(conversationId)?.currentTurnState
  }
  syncTaskBudgetTotal(conversationId: string, total: number): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    ctx!.taskBudgetState = syncSessionTaskBudgetTotal(ctx!.taskBudgetState, {
      total,
      now: Date.now(),
    })
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  applyTaskBudgetCompactionDeduction(
    conversationId: string,
    params: {
      compactionId: string
      preCompactContextTokens: number
    }
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx?.taskBudgetState) return
    const next = applyTaskBudgetCompactionDeduction(ctx.taskBudgetState, {
      compactionId: params.compactionId,
      preCompactContextTokens: params.preCompactContextTokens,
      now: Date.now(),
    })
    if (!next || next === ctx.taskBudgetState) return
    ctx.taskBudgetState = next
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  getTaskBudgetParam(conversationId: string): TaskBudgetParam | undefined {
    return toTaskBudgetParam(
      this.contextRecords.get(conversationId)?.taskBudgetState
    )
  }
  markAssistantBackend(
    conversationId: string,
    backend: BackendType,
    _codexResponseId?: string,
    options?: { model?: string }
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    session.lastActivityAt = new Date()
    session.lastAssistantBackend = backend
    if (options?.model) {
      session.lastAssistantModel = options.model
    }
    // previous_response_id 相关字段已废弃，由 CodexService transport state 管理

    this.sessionLifecycle.schedulePersist(conversationId)
  }
  /**
   * Drop the `toolUseResult` payload from every prior user message before
   * issuing the next backend request. Mirrors cc query.ts:530-538:
   *
   *   By this point the UI has already rendered the tool result and the
   *   next API call only needs message.message.content (tool_result blocks),
   *   not the raw output object. This prevents unbounded memory growth in
   *   long sessions before compact triggers — a single FileRead of a
   *   400KB file would otherwise stay in memory forever.
   *
   * Callers should invoke this at the boundary that feeds the wire DTO
   * (i.e. `truncateMessagesForBackend`) so the cleanup runs once per
   * outbound request regardless of how many sub-flows feed into it.
   */
  clearToolUseResultsBeforeNextSend(conversationId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    let cleared = 0
    for (const msg of ctx!.messages) {
      if (msg.type !== "user") continue
      if (msg.toolUseResult === undefined) continue
      delete msg.toolUseResult
      cleared++
    }
    if (cleared === 0) return
    this.logger.debug(
      `Cleared ${cleared} toolUseResult payload(s) before next send (${conversationId})`
    )
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  /**
   * Update session with new message.
   *
   * Two call shapes are accepted:
   *  - legacy: `addMessage(conversationId, role, content)` — convenience for
   *    call sites that don't care about Anthropic message ids or split-sibling
   *    grouping (most internal helpers).
   *  - structured: `addMessage(conversationId, msg)` where `msg` is an
   *    `Omit<SessionMessage, "uuid" | "timestamp">` — preferred path from the
   *    streaming layer, which carries `message.id` and other metadata so
   *    send-time normalization can merge split-sibling rows.
   */
  addMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: MessageContent
  ): string | undefined
  addMessage(
    conversationId: string,
    msg: SessionMessageInit
  ): string | undefined
  addMessage(
    conversationId: string,
    roleOrMsg: "user" | "assistant" | SessionMessageInit,
    contentMaybe?: MessageContent
  ): string | undefined {
    const result = this.appendMessageWithSeq(
      conversationId,
      roleOrMsg as "user" | "assistant",
      contentMaybe
    )
    return result?.recordId
  }

  /**
   * Step 4 终结: addMessage variant that returns the v2 message_seq
   * (real append-only sequence id from session_messages SQLite table)
   * alongside the v1 record id. Used by callers that need the seq to
   * pair with a same-txn ToolCallLedger.open / .close.
   *
   * Internally runs messageStore.runInTransaction so the v2 row +
   * ledger pair land atomically; the v1 SessionRecord.messages array
   * stays in sync as a pure in-memory mirror for hot-path reads.
   */
  appendMessageWithSeq(
    conversationId: string,
    roleOrMsg: "user" | "assistant" | SessionMessageInit,
    contentMaybe?: MessageContent,
    opts?: {
      ledgerOpen?: { toolUseId: string; toolName: string; turnId: TurnId }
      ledgerClose?: { toolUseId: string }
    }
  ): { recordId: string; messageSeq: number } | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return undefined

    let message: SessionMessage
    if (typeof roleOrMsg === "string") {
      const role = roleOrMsg
      const content = contentMaybe!
      if (
        role === "assistant" &&
        Array.isArray(content) &&
        content.length === 0
      ) {
        this.logger.warn(
          `addMessage: dropping empty assistant message for ${conversationId}`
        )
        return undefined
      }
      message = makeSessionMessage(role, content)
    } else {
      const partial = roleOrMsg
      if (
        partial.type === "assistant" &&
        Array.isArray(partial.message.content) &&
        partial.message.content.length === 0
      ) {
        this.logger.warn(
          `addMessage: dropping empty assistant message for ${conversationId}`
        )
        return undefined
      }
      message = {
        ...partial,
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      } as SessionMessage
    }

    // Step 4 终结: v2 append + ledger pairing in one txn.
    const cid = ConversationId.of(conversationId)
    let messageSeq = 0
    try {
      this.messageStore.runInTransaction(cid, (txn) => {
        const content = message.message.content
        const blocks: ContentBlock[] = Array.isArray(content)
          ? (content as ContentBlock[])
          : [{ type: "text", text: typeof content === "string" ? content : "" }]
        if (message.type === "assistant") {
          // Multi-block assistant message: append each block as its
          // own v2 row but stamp them with the same anthropic
          // message_id so split-sibling merge at send time still
          // groups them. Take the first block's seq as the canonical
          // messageSeq returned; ledger.open is bound to that seq.
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i]
            if (!block) continue
            if (block.type === "tool_result" || block.type === "cache_edits") {
              continue
            }
            const result = this.messageStore.appendAssistantBlock(txn, block, {
              turnId: this.resolveTurnIdForCid(cid),
              messageId: message.message.id,
            })
            if (i === 0) messageSeq = result.seq
          }
        } else {
          // user message — single envelope (may contain tool_result blocks)
          for (const block of blocks) {
            if (block.type === "tool_result") {
              if (this.toolCallLedger.isOpen(cid, block.tool_use_id)) {
                const result = this.messageStore.appendToolResultBlock(
                  txn,
                  block,
                  { turnId: this.resolveTurnIdForCid(cid) }
                )
                if (messageSeq === 0) messageSeq = result.seq
              } else {
                // No matching open ledger entry — fall back to plain
                // user-message append so the v2 row exists. The
                // ledger sweep on cleanup will still handle any
                // orphan from an earlier path.
                const result = this.messageStore.appendUserMessage(
                  txn,
                  [block],
                  { turnId: this.resolveTurnIdForCid(cid) }
                )
                if (messageSeq === 0) messageSeq = result.seq
              }
            } else {
              const result = this.messageStore.appendUserMessage(txn, [block], {
                turnId: this.resolveTurnIdForCid(cid),
              })
              if (messageSeq === 0) messageSeq = result.seq
            }
          }
        }
        if (opts?.ledgerOpen) {
          this.toolCallLedger.open(txn, {
            toolUseId: opts.ledgerOpen.toolUseId,
            toolName: opts.ledgerOpen.toolName,
            turnId: opts.ledgerOpen.turnId,
            openMessageSeq: messageSeq,
          })
        }
        if (opts?.ledgerClose) {
          this.toolCallLedger.close(txn, {
            toolUseId: opts.ledgerClose.toolUseId,
            closeMessageSeq: messageSeq,
          })
        }
      })
    } catch (err) {
      this.logger.warn(
        `appendMessageWithSeq v2 write failed for ${conversationId}: ${(err as Error).message} — continuing with v1-only path`
      )
    }

    // v1 in-memory mirror (kept for hot-path SessionMessage[] reads).
    ctx!.messages.push(message)
    ctx!.messagesGeneration += 1
    const record = this.sessionLifecycle.createTranscriptRecord(message)
    ctx!.messageRecords.push(record)
    this.sessionLifecycle.appendTranscriptEventsForMessage(
      session,
      record,
      message
    )
    this.sessionLifecycle.syncContextRecordsFromMessageRecords(
      ctx!.contextState,
      ctx!.messageRecords
    )
    session.lastActivityAt = new Date()

    const contentForEstimation = message.message.content
    const contentStr =
      typeof contentForEstimation === "string"
        ? contentForEstimation
        : JSON.stringify(contentForEstimation)
    ctx!.usedTokens += Math.ceil(contentStr.length / 4)
    if (this.sessionLifecycle.shouldFlushMessageImmediately(message)) {
      this.sessionLifecycle.clearScheduledPersist(conversationId)
      this.sessionLifecycle.persistSession(conversationId)
    } else {
      this.sessionLifecycle.schedulePersist(conversationId)
    }
    return { recordId: record.id, messageSeq }
  }

  private resolveTurnIdForCid(cid: ConversationId): TurnId {
    // ContextStateService doesn't have direct access to TurnLifecycle
    // (it would create a tighter coupling than the plan wants).
    // Synthesize a deterministic turn id from the conversation id when
    // the caller doesn't supply one — the ledger uses turnId only as
    // a grouping key for `abortAll(turnId)`, and `cursor-connect-stream`
    // calls `appendMessageWithSeq` with the right turnId via opts.
    // Fallback id is unique-per-conversation so an aborted bidi can
    // still sweep its open entries.
    return ("ctx:" + cid) as unknown as TurnId
  }

  /**
   * Mirror of cc claude.ts:2335-2338: when `message_delta` arrives, mutate
   * the usage / stop_reason directly on the most recent assistant message
   * rather than emitting a fresh record. The transcript write queue holds a
   * reference to `message.message`, so direct mutation flows the final usage
   * through to persistence without spawning a new record. No-op if the tail
   * isn't an assistant message (e.g. a synchronous tool result already
   * landed first).
   */
  mutateLastAssistantUsage(
    conversationId: string,
    usage: ContextUsageSnapshot | undefined,
    stopReason?: string | null
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    const last = ctx!.messages[ctx!.messages.length - 1]
    if (!last || last.type !== "assistant") return
    if (usage) last.message.usage = usage
    if (typeof stopReason !== "undefined") last.message.stop_reason = stopReason
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  /**
   * Add blobId to session's message history
   * This is used for building conversationCheckpointUpdate
   */
  addMessageBlobId(conversationId: string, blobId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.messageBlobIds.push(blobId)
      this.logger.log(
        `>>> Added blobId to session ${conversationId}: ${blobId.substring(0, 20)}... (total: ${ctx!.messageBlobIds.length})`
      )
      this.sessionLifecycle.schedulePersist(conversationId)
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
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.turns.push(turnId)
      this.logger.log(
        `>>> Added turn ${ctx!.turns.length} to session ${conversationId}: ${turnId.substring(0, 20)}...`
      )
      this.sessionLifecycle.schedulePersist(conversationId)
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
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.currentAssistantMessage = message
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  /**
   * Clear current assistant message
   */
  clearCurrentAssistantMessage(conversationId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.currentAssistantMessage = undefined
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  /**
   * Track file read operation
   */
  addReadPath(conversationId: string, filePath: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.readPaths.add(filePath)
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  addReadSnapshot(
    conversationId: string,
    snapshot: Omit<SessionReadSnapshot, "capturedAt">
  ): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
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

    const withoutSameWindow = ctx!.readSnapshots.filter((existing) => {
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
    ctx!.readSnapshots = trimmedSnapshots
    this.sessionLifecycle.schedulePersist(conversationId)
    return true
  }
  /**
   * Drop every cached read snapshot for `filePath` in this session.
   *
   * Called after the bridge observes a successful mutation
   * (`writeResult`, `deleteResult`) so the next `applyEditInputToFileText`
   * does not feed a stale `beforeContent` back into the edit pipeline.
   * Without this, a sequence like
   *   read_file(a.txt)            -> snapshot { content: "alpha" }
   *   edit_file_v2 alpha→alpha-1  -> writeResult success, disk = "alpha-1"
   *   edit_file_v2 alpha-1→alpha-2 (no fresh read between)
   * would re-run `applyEditInputToFileText` against the stale "alpha"
   * snapshot and emit "alpha-1-1" / unsafe_overwrite reject — the
   * smoke regression #2 / #3a / #3d failures.
   *
   * Returns the number of snapshots dropped (0 means nothing to do).
   */
  invalidateReadSnapshotsForPath(
    conversationId: string,
    filePath: string,
    reason: string
  ): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return 0
    const normalized = typeof filePath === "string" ? filePath.trim() : ""
    if (!normalized) return 0
    const before = ctx!.readSnapshots.length
    ctx!.readSnapshots = ctx!.readSnapshots.filter(
      (snapshot) => snapshot.filePath !== normalized
    )
    const dropped = before - ctx!.readSnapshots.length
    if (dropped > 0) {
      session.lastActivityAt = new Date()
      this.sessionLifecycle.schedulePersist(conversationId)
      this.logger.debug(
        `Invalidated ${dropped} read snapshot(s) for ${normalized} (${reason})`
      )
    }
    return dropped
  }
  /**
   * 探测某 path 的最近 read snapshot 是否相对当前磁盘 stale，用于
   * edit_file_v2 写盘前的 fail-fast 检测。
   *
   * 参考 claude-code FileEditTool 的 FILE_UNEXPECTEDLY_MODIFIED_ERROR
   * mtime 乐观锁：
   *   1. 先比 mtime/size：snapshot 捕获时记录的 vs 当前 disk
   *   2. 不一致时再比 content：currentReadContent vs snapshot.content
   *      （Windows / cloud sync / antivirus 会无内容变化地触发 mtime
   *      抖动，content fallback 避免假阳性）
   *
   * 仅检查 sourceToolName === 'read_file' 的 snapshot —— edit_file_v2 写
   * 完后该 path 的 snapshot 暂不会主动刷新，跳过这类 snapshot 避免误报
   * "上次 edit 后第二次 edit"序列。
   *
   * 已知限制：若 read_file 之后该 path 没再读过，但被同 session 的
   * edit_file_v2 写过，本方法可能漏报；该场景由 path-level edit
   * serialization 兜底（acquireOrQueueEdit 保证顺序），且后续
   * applyEditInputToFileText 的 target_not_found / ambiguous_target 也会
   * 给模型可恢复的错误信号。
   */
  probeReadSnapshotStaleness(
    conversationId: string,
    filePath: string,
    currentReadContent: string
  ): {
    status: "fresh" | "stale_external" | "no_baseline"
    capturedMtimeMs?: number
    capturedSizeBytes?: number
    currentMtimeMs?: number
    currentSizeBytes?: number
  } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return { status: "no_baseline" }

    const normalizedPath = typeof filePath === "string" ? filePath.trim() : ""
    if (!normalizedPath) return { status: "no_baseline" }

    // 倒序找最新一条 read_file 来源的 snapshot（含尚未被丢弃的 stale 候选）
    let baseline: SessionReadSnapshot | undefined
    for (let i = ctx!.readSnapshots.length - 1; i >= 0; i--) {
      const candidate = ctx!.readSnapshots[i]
      if (
        candidate &&
        candidate.filePath === normalizedPath &&
        candidate.sourceToolName === "read_file"
      ) {
        baseline = candidate
        break
      }
    }
    if (!baseline) return { status: "no_baseline" }
    if (
      typeof baseline.diskMtimeMs !== "number" ||
      typeof baseline.diskSizeBytes !== "number"
    ) {
      return { status: "fresh" }
    }
    if (!path.isAbsolute(normalizedPath)) {
      return { status: "fresh" }
    }

    let currentMtime: number
    let currentSize: number
    try {
      const stat = fs.statSync(normalizedPath)
      currentMtime = stat.mtimeMs
      currentSize = stat.size
    } catch {
      // 文件已不存在 / 不可 stat：无法证明 stale，由后续写入路径处理
      return { status: "fresh" }
    }

    const mtimeDrift = Math.abs(currentMtime - baseline.diskMtimeMs)
    const stable = mtimeDrift <= 1 && currentSize === baseline.diskSizeBytes
    if (stable) {
      return {
        status: "fresh",
        capturedMtimeMs: baseline.diskMtimeMs,
        capturedSizeBytes: baseline.diskSizeBytes,
        currentMtimeMs: currentMtime,
        currentSizeBytes: currentSize,
      }
    }

    // mtime/size 漂移 → 用 content fallback 吸收 FS 噪声
    if (currentReadContent === baseline.content) {
      return {
        status: "fresh",
        capturedMtimeMs: baseline.diskMtimeMs,
        capturedSizeBytes: baseline.diskSizeBytes,
        currentMtimeMs: currentMtime,
        currentSizeBytes: currentSize,
      }
    }

    return {
      status: "stale_external",
      capturedMtimeMs: baseline.diskMtimeMs,
      capturedSizeBytes: baseline.diskSizeBytes,
      currentMtimeMs: currentMtime,
      currentSizeBytes: currentSize,
    }
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
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
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

    for (let index = ctx!.readSnapshots.length - 1; index >= 0; index--) {
      const snapshot = ctx!.readSnapshots[index]
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
   * Track a successful file mutation (write/edit) into
   * `ctx!.fileStates`, which feeds:
   *
   *   - `agent.v1.ConversationCheckpointUpdate.fileStatesV2`
   *     (`map<string, FileStateStructure>` — see proto FileState).
   *   - `ContextAttachmentBuilderService` "Recent File Snapshots" /
   *     "Tracked File Changes" attachments.
   *
   * Semantics aligned with `agent.v1.FileState` (`beforeContent` =
   * session-baseline content, `afterContent` = current content):
   *
   * - First touch: persist both fields as supplied — `beforeContent`
   *   becomes the durable baseline for this path inside the session.
   * - Subsequent touches: keep the **original** `beforeContent` and
   *   only advance `afterContent`. Without this stickiness the baseline
   *   drifts to each intermediate post-edit state and tracked-file deltas
   *   report wrong line counts (e.g. a file restored to its original
   *   1-line content showing as `-2 lines` after a 3-line interim edit).
   */
  addFileState(
    conversationId: string,
    filePath: string,
    beforeContent: string,
    afterContent: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      const existing = ctx!.fileStates.get(filePath)
      const baseline = existing ? existing.beforeContent : beforeContent
      ctx!.fileStates.set(filePath, {
        beforeContent: baseline,
        afterContent,
      })
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  /**
   * Drop the tracked file-state entry for `filePath` after a successful
   * `deleteResult`.
   *
   * The `agent.v1` proto models deletion as **absence** from the
   * `ConversationCheckpointUpdate.fileStatesV2` map — `FileState` /
   * `FileStateStructure` carry no `deleted` / tombstone field — so eviction
   * is the only protocol-aligned way to express "this path no longer
   * exists in this session". Skipping eviction would (a) ship stale
   * `afterContent` in subsequent checkpoints and (b) keep the path in
   * `Recent File Snapshots` / `Tracked File Changes` attachments after the
   * file is gone from disk.
   *
   * Returns true when an entry was removed.
   */
  removeFileState(conversationId: string, filePath: string): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return false
    const removed = ctx!.fileStates.delete(filePath)
    if (removed) {
      session.lastActivityAt = new Date()
      this.sessionLifecycle.schedulePersist(conversationId)
    }
    return removed
  }
  recordCompletedToolCall(
    conversationId: string,
    toolCall: Pick<PendingToolCall, "toolName" | "toolFamilyHint" | "sentAt">
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return

    const durationMs = Math.max(0, Date.now() - toolCall.sentAt.getTime())
    ctx!.toolMetrics.completedCalls += 1
    ctx!.toolMetrics.totalDurationMs += durationMs
    ctx!.toolMetrics.lastCompletedAt = Date.now()

    switch (this.sessionLifecycle.classifyToolCall(toolCall)) {
      case "shell":
        ctx!.toolMetrics.shellCalls += 1
        break
      case "edit":
        ctx!.toolMetrics.editCalls += 1
        break
      case "mcp":
        ctx!.toolMetrics.mcpCalls += 1
        break
      default:
        ctx!.toolMetrics.otherCalls += 1
        break
    }

    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  /**
   * Wholesale replace the session transcript with `messages`. Used by
   * the legacy compaction / transient-cleanup paths that operate on a
   * derived array view and need to write it back. The previous
   * `replaceMessages` ran an `enforceToolProtocol` integrity guard on
   * the candidate; that guard was removed in step 1 because protocol
   * integrity is now owned by `ToolCallLedger`. This method therefore
   * performs only the mechanical write-back: drop empty assistant
   * messages, rebind the TranscriptStore committed array, reconcile
   * messageRecords + contextState, bump messagesGeneration, and
   * schedule a persist.
   *
   * Caller responsibility: `messages` must already be protocol-correct
   * (ledger guarantees this for any new tool_use / tool_result; the
   * compaction / projection paths only delete or reorder existing
   * blocks, never invent new ones).
   */
  replaceMessages(conversationId: string, messages: SessionMessage[]): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return

    // Filter fully empty assistant messages — content arrays of
    // length 0 / empty strings have always been treated as droppable
    // by callers, and persisting them would inflate downstream caches.
    const filteredMessages = messages.filter((msg) => {
      if (msg.message.role !== "assistant") return true
      if (typeof msg.message.content === "string")
        return msg.message.content.length > 0
      if (Array.isArray(msg.message.content))
        return msg.message.content.length > 0
      return true
    })
    const droppedEmpty = messages.length - filteredMessages.length
    if (droppedEmpty > 0) {
      this.logger.warn(
        `replaceMessages: dropped ${droppedEmpty} empty assistant message(s) for ${conversationId}`
      )
    }

    const reconciledRecords = this.sessionLifecycle.reconcileMessageRecords(
      ctx!.messageRecords,
      filteredMessages
    )
    const previousContextRecords = ctx!.contextState.records
    const previousUsageAnchor = ctx!.contextState.usageLedger.anchorRecordId

    const conv = ConversationId.of(conversationId)
    this.sessionLifecycle.transcriptReplaceCommitted(conv, filteredMessages)
    ctx!.messages = this.sessionLifecycle.transcriptGetCommittedRaw(conv)
    ctx!.messagesGeneration += 1
    ctx!.messageRecords = reconciledRecords
    this.sessionLifecycle.appendTranscriptEvent(session, {
      kind: "snapshot_rewrite",
      summary: `messages=${filteredMessages.length}, records=${reconciledRecords.length}`,
    })
    if (
      this.sessionLifecycle.isContextStateCompatible(
        ctx!.contextState,
        reconciledRecords,
        previousContextRecords
      )
    ) {
      this.sessionLifecycle.syncContextRecordsFromMessageRecords(
        ctx!.contextState,
        reconciledRecords
      )
      const lastApplied = ctx!.contextState.lastAppliedCompaction
      if (lastApplied) {
        ctx!.contextState.lastAppliedCompaction = {
          ...lastApplied,
          recordCount: ctx!.contextState.records.length,
        }
      }
      if (
        !this.sessionLifecycle.shouldRetainUsageLedger(
          ctx!.contextState,
          reconciledRecords,
          previousContextRecords
        )
      ) {
        ctx!.contextState.usageLedger = {}
        this.logger.log(
          `Invalidated context usage ledger for ${conversationId} after transcript rewrite before anchor ${previousUsageAnchor}`
        )
      }
    } else {
      const prevActiveCompactionId = ctx!.contextState.activeCompactionId
      const prevCompactionHistoryLen =
        ctx!.contextState.compactionHistory?.length ?? 0
      const prevBoundaryRecords = previousContextRecords.filter(
        (record) =>
          record.kind === "compact_boundary" ||
          record.kind === "compact_summary"
      ).length
      ctx!.contextState =
        this.sessionLifecycle.createContextState(reconciledRecords)
      this.logger.log(
        `Reset context compaction state for ${conversationId} after transcript rewrite invalidated archived context ` +
          `(prevActiveCompactionId=${prevActiveCompactionId ?? "none"}, ` +
          `prevCompactionHistory=${prevCompactionHistoryLen}, ` +
          `prevBoundaryRecords=${prevBoundaryRecords}, ` +
          `prevRecords=${previousContextRecords.length}, ` +
          `reconciledRecords=${reconciledRecords.length})`
      )
    }
    // Re-pin the manager-level turn anchor to the new tail (the
    // anchor is owned by SessionLifecycleService).
    this.sessionLifecycle.repinTurnAnchorAfterReplaceMessages(conversationId)
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  getContextState(
    conversationId: string
  ): ContextConversationState | undefined {
    return this.contextRecords.get(conversationId)?.contextState
  }
  getTranscriptEvents(conversationId: string): SessionTranscriptEvent[] {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    return session ? ctx!.transcriptEvents.map((event) => ({ ...event })) : []
  }
  /**
   * Register a snip boundary that hides the supplied record IDs from the
   * model-facing projection. Returns the boundary descriptor (or undefined if
   * the session is gone).
   *
   * Mirrors Claude Code's `force-snip` / `Snip` tool semantics: the actual
   * messages and records are not deleted from session state — only the
   * projection skips them. That keeps `messageRecords` stable for downstream
   * compaction bookkeeping (archivedThroughRecordId, sessionMemoryEntries) and
   * lets the IDE keep showing the full transcript even after a snip.
   */
  registerSnipBoundary(
    conversationId: string,
    args: {
      removedRecordIds: string[]
      trigger: "model" | "user"
      reason?: string
    }
  ): SessionSnipBoundary | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return undefined

    const filtered = Array.from(new Set(args.removedRecordIds)).filter(
      (id): id is string => typeof id === "string" && id.length > 0
    )
    if (filtered.length === 0) {
      return undefined
    }

    const state: SessionSnipState = ctx!.snipState ?? {
      boundaries: [],
      removedRecordIds: new Set<string>(),
    }
    const boundary: SessionSnipBoundary = {
      id: `snip-${Date.now().toString(36)}-${state.boundaries.length + 1}`,
      createdAt: Date.now(),
      trigger: args.trigger,
      reason: args.reason?.trim() || undefined,
      removedRecordIds: filtered,
      snippedMessageCount: ctx!.messages.length,
    }
    state.boundaries.push(boundary)
    for (const id of filtered) state.removedRecordIds.add(id)
    ctx!.snipState = state
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    this.logger.log(
      `[snip] session=${conversationId} trigger=${args.trigger} removed=${filtered.length} totalBoundaries=${state.boundaries.length}`
    )
    return boundary
  }
  getSnipState(conversationId: string): SessionSnipState | undefined {
    return this.contextRecords.get(conversationId)?.snipState
  }
  resetSnipState(conversationId: string): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx?.snipState) return false
    delete ctx.snipState
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return true
  }
  /**
   * Project ctx!.messages through the snip boundaries.
   *
   * The projection drops the messages whose corresponding messageRecords[i].id
   * is in `snipState.removedRecordIds`. messages and messageRecords are kept
   * in lock-step inside the manager (addMessage / replaceMessages both update
   * them together), so positional alignment is the right anchor.
   *
   * If snipState is empty or the alignment looks suspicious, fall back to
   * returning ctx!.messages unchanged so we never produce a malformed
   * tool_use/tool_result pair.
   */
  getProjectedMessages(conversationId: string): {
    messages: SessionMessage[]
    skipped: number
  } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return { messages: [], skipped: 0 }
    const removed = ctx!.snipState?.removedRecordIds
    if (!removed || removed.size === 0) {
      return { messages: ctx!.messages, skipped: 0 }
    }
    if (ctx!.messages.length !== ctx!.messageRecords.length) {
      this.logger.warn(
        `[snip] projection skipped — messages(${ctx!.messages.length}) and records(${ctx!.messageRecords.length}) length mismatch`
      )
      return { messages: ctx!.messages, skipped: 0 }
    }
    const projected: SessionMessage[] = []
    let skipped = 0
    for (let i = 0; i < ctx!.messages.length; i++) {
      const record = ctx!.messageRecords[i]
      if (record && removed.has(record.id)) {
        skipped++
        continue
      }
      projected.push(ctx!.messages[i]!)
    }
    return { messages: projected, skipped }
  }
  /**
   * Resolve the recordIds that a Snip operation with `keepRecent` should
   * remove. Walks messageRecords from the tail, keeping the most recent
   * `keepRecent` message-typed records and any record that is part of a
   * tool_use/tool_result pair with a kept record (so we never split a pair).
   *
   * Returns an empty array if there is nothing safe to drop.
   */
  resolveSnipTargets(
    conversationId: string,
    keepRecent: number
  ): {
    removedRecordIds: string[]
    keptCount: number
    totalCount: number
  } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return { removedRecordIds: [], keptCount: 0, totalCount: 0 }

    const records = ctx!.messageRecords
    const totalCount = records.length
    if (totalCount === 0 || keepRecent <= 0) {
      return { removedRecordIds: [], keptCount: 0, totalCount }
    }

    // Walk from the tail, accumulating message-typed records until we have
    // `keepRecent` of them. Everything before that index becomes a snip
    // candidate.
    let kept = 0
    let cutIndex = totalCount
    for (let i = totalCount - 1; i >= 0; i--) {
      const record = records[i]!
      const isMessage = !record.kind || record.kind === "message"
      if (isMessage) {
        kept++
        if (kept >= keepRecent) {
          cutIndex = i
          break
        }
      }
    }

    if (cutIndex <= 0) {
      return { removedRecordIds: [], keptCount: kept, totalCount }
    }

    // Collect tool_use IDs referenced by tool_result blocks in the kept tail
    // so we can pull their owning assistant message back into the kept range
    // if they happen to live before cutIndex. Without this we would orphan
    // tool_result blocks and the next request would fail integrity checks.
    const keptToolResultIds = new Set<string>()
    for (let i = cutIndex; i < totalCount; i++) {
      const record = records[i]!
      if (typeof record.content === "string") continue
      if (!Array.isArray(record.content)) continue
      for (const block of record.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_result"
        ) {
          const id = (block as Record<string, unknown>).tool_use_id
          if (typeof id === "string") keptToolResultIds.add(id)
        }
      }
    }

    const removedRecordIds: string[] = []
    for (let i = 0; i < cutIndex; i++) {
      const record = records[i]!
      // Never snip the synthetic compact-summary or compact-boundary records;
      // those are how the model knows about prior context after compaction.
      if (record.kind && record.kind !== "message") continue
      // Do not snip an assistant message that owns a tool_use referenced by a
      // kept tool_result.
      if (
        Array.isArray(record.content) &&
        record.content.some(
          (block) =>
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "tool_use" &&
            keptToolResultIds.has(
              ((block as Record<string, unknown>).id as string) ?? ""
            )
        )
      ) {
        continue
      }
      removedRecordIds.push(record.id)
    }

    return { removedRecordIds, keptCount: kept, totalCount }
  }
  markContextStateDirty(conversationId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    session.lastActivityAt = new Date()
    this.sessionLifecycle.syncContextRecordsFromMessageRecords(
      ctx!.contextState,
      ctx!.messageRecords
    )
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  getInvestigationMemory(
    conversationId: string
  ): ContextInvestigationMemoryEntry[] {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return []
    return ctx!.contextState.investigationMemory.map((entry) => ({
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
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    ctx!.contextState.investigationMemory = entries.map((entry) => ({
      ...entry,
      toolCallIds: [...entry.toolCallIds],
    }))
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
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
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    ctx!.contextState.usageLedger = usageLedgerState || {
      anchorRecordId: recordId,
      lastUsage: usage,
    }
    const inputContextTokens =
      usage.inputTokens +
      usage.cachedInputTokens +
      usage.cacheCreationInputTokens
    ctx!.usedTokens = inputContextTokens
    session.usedContextTokens = inputContextTokens
    ctx!.pendingRequestContextLedger = undefined
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  replaceTodos(conversationId: string, todos: SessionTodoItem[]): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    ctx!.todos = todos
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  nextExecId(conversationId: string): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    const next = ctx!.execId++
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return next
  }
  incrementStepId(conversationId: string): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    ctx!.stepId++
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return ctx!.stepId
  }

  // ─── Field accessors (step 4 终结) ─────────────────────────────
  // caller 不再 `ctx!.contextState.xxx` / `ctx!.messages` 等,
  // 通过这些 method 访问 ContextStateFields 字段。

  getMessages(conversationId: string): SessionMessage[] {
    return this.contextRecords.get(conversationId)?.messages ?? []
  }
  getMessagesGeneration(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.messagesGeneration ?? 0
  }
  getMessageRecords(conversationId: string): ContextTranscriptRecord[] {
    return this.contextRecords.get(conversationId)?.messageRecords ?? []
  }
  getNextTranscriptEventSeq(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.nextTranscriptEventSeq ?? 0
  }
  getCurrentTurnState(conversationId: string): CursorTurnState | undefined {
    return this.contextRecords.get(conversationId)?.currentTurnState
  }
  getRecentTurnStates(conversationId: string): CursorTurnState[] {
    return this.contextRecords.get(conversationId)?.recentTurnStates ?? []
  }
  getTaskBudgetState(
    conversationId: string
  ): SessionTaskBudgetState | undefined {
    return this.contextRecords.get(conversationId)?.taskBudgetState
  }
  getTopLevelAgentTurnState(
    conversationId: string
  ): SessionTopLevelAgentTurnState | undefined {
    return this.contextRecords.get(conversationId)?.topLevelAgentTurnState
  }
  setTopLevelAgentTurnState(
    conversationId: string,
    state: SessionTopLevelAgentTurnState
  ): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.topLevelAgentTurnState = state
  }
  getLastEmittedContextSummaryCompactionId(
    conversationId: string
  ): string | undefined {
    return this.contextRecords.get(conversationId)
      ?.lastEmittedContextSummaryCompactionId
  }
  setLastEmittedContextSummaryCompactionId(
    conversationId: string,
    id: string | undefined
  ): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.lastEmittedContextSummaryCompactionId = id
  }
  getLastEmittedContextSummaryCompactionEpoch(
    conversationId: string
  ): number | undefined {
    return this.contextRecords.get(conversationId)
      ?.lastEmittedContextSummaryCompactionEpoch
  }
  setLastEmittedContextSummaryCompactionEpoch(
    conversationId: string,
    epoch: number | undefined
  ): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.lastEmittedContextSummaryCompactionEpoch = epoch
  }
  getPendingContextSummaryUiUpdate(
    conversationId: string
  ): ContextStateRecord["pendingContextSummaryUiUpdate"] | undefined {
    return this.contextRecords.get(conversationId)
      ?.pendingContextSummaryUiUpdate
  }
  setPendingContextSummaryUiUpdate(
    conversationId: string,
    value: ContextStateRecord["pendingContextSummaryUiUpdate"]
  ): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.pendingContextSummaryUiUpdate = value
  }
  getUsedTokens(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.usedTokens ?? 0
  }
  setUsedTokens(conversationId: string, value: number): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.usedTokens = value
  }
  getReadPaths(conversationId: string): Set<string> {
    return (
      this.contextRecords.get(conversationId)?.readPaths ?? new Set<never>()
    )
  }
  getReadSnapshots(conversationId: string): SessionReadSnapshot[] {
    return this.contextRecords.get(conversationId)?.readSnapshots ?? []
  }
  getFileStates(
    conversationId: string
  ): Map<string, { beforeContent: string; afterContent: string }> {
    return (
      this.contextRecords.get(conversationId)?.fileStates ??
      new Map<never, never>()
    )
  }
  getToolMetrics(conversationId: string): SessionToolMetrics | undefined {
    return this.contextRecords.get(conversationId)?.toolMetrics
  }
  getMessageBlobIds(conversationId: string): string[] {
    return this.contextRecords.get(conversationId)?.messageBlobIds ?? []
  }
  getTurns(conversationId: string): string[] {
    return this.contextRecords.get(conversationId)?.turns ?? []
  }
  getCurrentAssistantMessage(
    conversationId: string
  ): Record<string, unknown> | undefined {
    return this.contextRecords.get(conversationId)?.currentAssistantMessage
  }
  getStepId(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.stepId ?? 0
  }
  getExecId(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.execId ?? 0
  }
  getTodos(conversationId: string): SessionTodoItem[] {
    return this.contextRecords.get(conversationId)?.todos ?? []
  }
  getPendingRequestContextLedger(
    conversationId: string
  ): ContextStateRecord["pendingRequestContextLedger"] | undefined {
    return this.contextRecords.get(conversationId)?.pendingRequestContextLedger
  }
  setPendingRequestContextLedger(
    conversationId: string,
    value: ContextStateRecord["pendingRequestContextLedger"]
  ): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.pendingRequestContextLedger = value
  }
}
