import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common"
import {
  type SessionRecord,
  type SessionStreamRecord,
  type PendingToolCall,
  type QueuedEditDispatch,
  type SessionBackgroundCommand,
  SessionLifecycleService,
} from "./session-lifecycle.service"
import { ConversationId } from "../turn/turn.types"
import type { TurnId } from "../turn/turn.types"

/**
 * SessionStreamService — step 4 真正拆解 product.
 *
 * Owns the streaming-side state and methods that previously lived
 * directly on SessionLifecycleService:
 *
 *   - shell stream stdout/stderr accumulation
 *   - background command lifecycle
 *   - per-path edit serialisation (acquireOrQueueEdit / pickNextEditForPath)
 *   - InteractionQuery registration / resolution
 *   - currentStreamId rotation + pending rebind
 *   - cross-session sweeps for overdue deadlines and async-ask followups
 *
 * Field storage (backgroundCommands map, edit-path holders/queues,
 * pendingInteractionQueries, currentStreamId) is still attached to
 * the legacy `SessionRecord` object owned by SessionLifecycleService;
 * the methods reach into those fields through `sessionLifecycle.getSession(cid)`
 * and through the `iterateSessions` accessor for cross-session sweeps.
 *
 * forwardRef breaks the bidirectional cycle: lifecycle ↔ stream both
 * resolve through @Inject(forwardRef(...)). markSessionDirty +
 * lastActivityAt updates flow back into the lifecycle so the v1 blob
 * persistence cadence is preserved.
 */
@Injectable()
export class SessionStreamService {
  private readonly logger = new Logger(SessionStreamService.name)

  /** Threshold after which a shell-stream pending tool call is considered stranded. */
  static readonly STALE_SHELL_STREAM_MS = 5 * 60 * 1000

  // Step 4 物理拆: 独立持有 SessionStreamRecord 对象。
  private readonly streamRecords = new Map<string, SessionStreamRecord>()

  constructor(
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  // ── Record lifecycle (step 4 物理拆) ─────────────────────────

  getStreamRecord(conversationId: string): SessionStreamRecord | undefined {
    return this.streamRecords.get(conversationId)
  }

  createInitialRecord(
    conversationId: string,
    init: SessionStreamRecord
  ): SessionStreamRecord {
    this.streamRecords.set(conversationId, init)
    return init
  }

  deleteRecord(conversationId: string): boolean {
    return this.streamRecords.delete(conversationId)
  }

  iterateRecords(): IterableIterator<[string, SessionStreamRecord]> {
    return this.streamRecords.entries()
  }

  // ── shell streams ─────────────────────────────────────────────

  initShellStream(conversationId: string, toolCallId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
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

  appendShellStdout(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stdout.push(data)
      this.logger.debug(`Appended ${data.length} chars stdout to ${toolCallId}`)
    }
  }

  appendShellStderr(
    conversationId: string,
    toolCallId: string,
    data: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.stderr.push(data)
      this.logger.debug(`Appended ${data.length} chars stderr to ${toolCallId}`)
    }
  }

  markShellStarted(conversationId: string, toolCallId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.started = true
      this.logger.debug(`Marked shell started for ${toolCallId}`)
    }
  }

  setShellExit(
    conversationId: string,
    toolCallId: string,
    exitCode: number,
    signal?: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pendingCall?.shellStreamOutput) {
      session.lastActivityAt = new Date()
      pendingCall.shellStreamOutput.exitCode = exitCode
      pendingCall.shellStreamOutput.signal = signal
      this.logger.debug(
        `Set shell exit for ${toolCallId}: code=${exitCode}, signal=${signal}`
      )
    }
  }

  getShellOutput(
    conversationId: string,
    toolCallId: string
  ): { stdout: string; stderr: string; exitCode?: number } | null {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return null

    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (!pendingCall?.shellStreamOutput) return null

    return {
      stdout: pendingCall.shellStreamOutput.stdout.join(""),
      stderr: pendingCall.shellStreamOutput.stderr.join(""),
      exitCode: pendingCall.shellStreamOutput.exitCode,
    }
  }

  isShellStreamComplete(conversationId: string, toolCallId: string): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return false
    const pendingCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    return pendingCall?.shellStreamOutput?.exitCode !== undefined
  }

  // ── background commands ───────────────────────────────────────

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
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
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

    stream!.backgroundCommands.set(normalizedCommandId, backgroundCommand)
    session.lastActivityAt = new Date()
    this.sessionLifecycle.markSessionDirty(conversationId)
    return backgroundCommand
  }

  getBackgroundCommand(
    conversationId: string,
    commandId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return undefined
    return stream!.backgroundCommands.get(commandId.trim())
  }

  findBackgroundCommandByToolCallId(
    conversationId: string,
    toolCallId: string
  ): SessionBackgroundCommand | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return undefined
    for (const command of stream!.backgroundCommands.values()) {
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
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return undefined

    const normalizedToolCallId = toolCallId.trim()
    const normalizedCommandId = commandId.trim() || normalizedToolCallId
    if (!normalizedToolCallId || !normalizedCommandId) return undefined

    const existing = this.findBackgroundCommandByToolCallId(
      conversationId,
      normalizedToolCallId
    )
    if (existing) return existing

    const pendingToolCall = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      normalizedToolCallId
    )
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
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session || !Number.isFinite(execIdNumber) || execIdNumber <= 0) {
      return undefined
    }
    const normalizedExecId = Math.floor(execIdNumber)
    for (const command of stream!.backgroundCommands.values()) {
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
    this.sessionLifecycle.markSessionDirty(conversationId)
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
    this.sessionLifecycle.markSessionDirty(conversationId)
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
    this.sessionLifecycle.markSessionDirty(conversationId)
    return true
  }

  // ── per-path edit serialisation ───────────────────────────────

  acquireOrQueueEdit(
    conversationId: string,
    toolCallId: string,
    path: string
  ): { acquired: boolean } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) {
      return { acquired: true }
    }
    const pending = this.sessionLifecycle.getPendingToolCall(
      session.conversationId,
      toolCallId
    )
    if (pending) {
      pending.editPath = path
    }

    const normalizedPath = (path || "").trim()
    if (!normalizedPath) {
      return { acquired: true }
    }

    const holder = stream!.editPathHolderByPath.get(normalizedPath)
    if (!holder) {
      stream!.editPathHolderByPath.set(normalizedPath, toolCallId)
      return { acquired: true }
    }

    if (holder === toolCallId) {
      // Idempotent: same tool call already holds the slot.
      return { acquired: true }
    }

    let queue = stream!.editPathQueueByPath.get(normalizedPath)
    if (!queue) {
      queue = []
      stream!.editPathQueueByPath.set(normalizedPath, queue)
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

  pickNextEditForPath(
    conversationId: string,
    path: string
  ): QueuedEditDispatch | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return undefined

    const normalizedPath = (path || "").trim()
    if (!normalizedPath) return undefined

    if (stream!.editPathHolderByPath.has(normalizedPath)) {
      // 上一持有者尚未释放，调用方应等待。
      return undefined
    }

    const queue = stream!.editPathQueueByPath.get(normalizedPath)
    if (!queue || queue.length === 0) {
      stream!.editPathQueueByPath.delete(normalizedPath)
      return undefined
    }

    const next = queue.shift()!
    if (queue.length === 0) {
      stream!.editPathQueueByPath.delete(normalizedPath)
    }
    stream!.editPathHolderByPath.set(normalizedPath, next.toolCallId)
    return next
  }

  // ── stream id rotation + rebind ───────────────────────────────

  rotateStreamId(conversationId: string): string {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return ""
    const newId = crypto.randomUUID()
    const oldId = stream!.currentStreamId
    stream!.currentStreamId = newId
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Rotated streamId for ${conversationId}: ${oldId.substring(0, 8)} -> ${newId.substring(0, 8)}`
    )
    this.sessionLifecycle.markSessionDirty(conversationId)
    return newId
  }

  getCurrentStreamId(conversationId: string): string | undefined {
    return this.streamRecords.get(conversationId)?.currentStreamId
  }

  isCurrentStream(conversationId: string, streamId: string): boolean {
    if (!streamId) return false
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) return false
    return stream!.currentStreamId === streamId
  }

  rebindPendingToolCallsToCurrentStream(conversationId: string): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (
      !session ||
      this.sessionLifecycle.pendingToolCallCount(session.conversationId) === 0
    )
      return 0

    const currentStreamId = stream!.currentStreamId
    let reboundCount = 0

    for (const [, pending] of this.sessionLifecycle.listPendingToolCallEntries(
      session.conversationId
    )) {
      const streamChanged = pending.streamId !== currentStreamId
      // Pending tools that input-EOF parked in `awaitingClientResult`
      // are exactly what resumeAction was designed to reattach. Move
      // them back to `running` so the lifecycle state machine matches
      // wall-clock reality (the IDE is once again in a position to
      // deliver the tool result), and reset the sweeper deadline so
      // the new BiDi gets the same fresh 90s window the original
      // dispatch did. Any other status is left untouched: a tool that
      // settled to `completed` / `aborted` between EOF and reattach
      // is already done and must not be revived.
      const statusChanged = pending.executionStatus === "awaitingClientResult"
      if (streamChanged) {
        pending.streamId = currentStreamId
      }
      if (statusChanged) {
        pending.executionStatus = "running"
        pending.executionRecoveryReason = undefined
        this.sessionLifecycle.resetPendingToolDeadline(
          conversationId,
          pending.toolCallId
        )
      }
      if (streamChanged || statusChanged) {
        reboundCount++
      }
    }

    if (reboundCount > 0) {
      this.sessionLifecycle.markSessionDirty(conversationId)
    }

    return reboundCount
  }

  // ── interaction queries ───────────────────────────────────────

  registerInteractionQuery(
    conversationId: string,
    queryType: string,
    payload?: Record<string, unknown>,
    options?: {
      turnId?: TurnId
      kind?: string
      deadline?: number
    }
  ): { id: number; promise: Promise<any> } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }

    stream!.interactionQueryId++
    const queryId = stream!.interactionQueryId

    let resolve!: (response: any) => void
    let reject!: (error: Error) => void
    const promise = new Promise<any>((res, rej) => {
      resolve = res
      reject = rej
    })

    stream!.pendingInteractionQueries.set(queryId, {
      resolve,
      reject,
      queryType,
      payload,
      turnId: options?.turnId,
      kind: options?.kind,
      deadline: options?.deadline,
      createdAt: Date.now(),
    })
    session.lastActivityAt = new Date()

    this.logger.log(
      `Registered InteractionQuery id=${queryId} type=${queryType} ` +
        `kind=${options?.kind ?? "(none)"} ` +
        `deadline=${options?.deadline ? new Date(options.deadline).toISOString() : "(none)"} ` +
        `for ${conversationId}`
    )

    this.sessionLifecycle.markSessionDirty(conversationId)
    return { id: queryId, promise }
  }

  resolveInteractionQuery(
    conversationId: string,
    queryId: number,
    response: any
  ): { queryType: string; payload?: Record<string, unknown> } | null {
    const session = this.sessionLifecycle.getSession(conversationId)
    const stream = this.streamRecords.get(conversationId)
    if (!session) {
      this.logger.warn(
        `resolveInteractionQuery: session not found ${conversationId}`
      )
      return null
    }

    const pending = stream!.pendingInteractionQueries.get(queryId)
    if (!pending) {
      this.logger.warn(
        `resolveInteractionQuery: no pending query id=${queryId}`
      )
      return null
    }

    const wasPending =
      this.sessionLifecycle.pendingToolCallCount(conversationId) > 0 ||
      stream!.pendingInteractionQueries.size > 0

    this.logger.log(
      `Resolve InteractionQuery id=${queryId} type=${pending.queryType}`
    )
    pending.resolve(response)
    stream!.pendingInteractionQueries.delete(queryId)
    session.lastActivityAt = new Date()
    this.sessionLifecycle.markSessionDirty(conversationId)
    this.sessionLifecycle.notifyIfBecameIdleAfter(session, wasPending)
    return {
      queryType: pending.queryType,
      payload: pending.payload,
    }
  }

  // ── cross-session sweeps (deadline / async-ask followups) ────

  listOverdueDeadlines(now: number = Date.now()): {
    tools: Array<{
      conversationId: string
      toolCallId: string
      toolName: string
      deadline: number
    }>
    interactionQueries: Array<{
      conversationId: string
      queryId: number
      kind: string | undefined
      deadline: number
    }>
  } {
    const tools: Array<{
      conversationId: string
      toolCallId: string
      toolName: string
      deadline: number
    }> = []
    const interactionQueries: Array<{
      conversationId: string
      queryId: number
      kind: string | undefined
      deadline: number
    }> = []

    for (const [conversationId, stream] of this.streamRecords.entries()) {
      const pendingTools =
        this.sessionLifecycle.pendingToolSnapshotForConversation(
          ConversationId.of(conversationId)
        )
      for (const entry of pendingTools) {
        const payload = entry.payload as PendingToolCall | undefined
        const deadline = payload?.deadline
        if (typeof deadline !== "number") continue
        if (deadline > now) continue
        // Tools whose BiDi was torn down by the IDE (Premature close,
        // network drop, IDE restart) are parked in
        // `executionStatus="awaitingClientResult"` by the input-EOF
        // recovery path so a future `resumeAction` can re-attach and
        // complete them. The deadline timer must NOT expire those —
        // that would emit an inline error result on a sealed outbound
        // (drops with `emit dropped: no active turn or umbrella`) and
        // simultaneously destroy the pending state that resumeAction
        // depends on. Two contradictory recovery strategies cannot
        // both fire on the same toolCall; awaitingClientResult wins
        // because the IDE has already taken ownership of the resume
        // path. Other statuses ("pending", "running") still expire so
        // a stalled live IDE attachment cannot leak forever — the
        // 2026-05-31 list_directory hang is the canonical case.
        if (payload?.executionStatus === "awaitingClientResult") continue
        tools.push({
          conversationId,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          deadline,
        })
      }

      for (const [queryId, iq] of stream.pendingInteractionQueries) {
        if (typeof iq.deadline !== "number") continue
        if (iq.deadline > now) continue
        interactionQueries.push({
          conversationId,
          queryId,
          kind: iq.kind,
          deadline: iq.deadline,
        })
      }
    }

    return { tools, interactionQueries }
  }

  listAsyncAskFollowups(conversationFilter?: string): Array<{
    conversationId: string
    queryId: number
    followupId: string
    text: string
    createdAtMs: number
  }> {
    const out: Array<{
      conversationId: string
      queryId: number
      followupId: string
      text: string
      createdAtMs: number
    }> = []
    for (const conversationId of this.streamRecords.keys()) {
      if (
        conversationFilter !== undefined &&
        conversationId !== conversationFilter
      ) {
        continue
      }
      const stream = this.streamRecords.get(conversationId)
      if (!stream) continue
      for (const [queryId, iq] of stream.pendingInteractionQueries) {
        if (iq.kind !== "async_ask") continue
        const payload = iq.payload as
          | { toolInput?: Record<string, unknown> }
          | undefined
        const toolInput = payload?.toolInput
        const text =
          (typeof toolInput?.title === "string" && toolInput.title.length > 0
            ? toolInput.title
            : typeof toolInput?.question === "string"
              ? toolInput.question
              : "") || ""
        out.push({
          conversationId,
          queryId,
          followupId: queryId.toString(),
          text,
          createdAtMs: iq.createdAt,
        })
      }
    }
    return out
  }

  findAsyncAskFollowupById(
    followupId: string
  ): { conversationId: string; queryId: number } | undefined {
    const queryId = Number.parseInt(followupId, 10)
    if (!Number.isFinite(queryId)) return undefined
    for (const [conversationId, stream] of this.streamRecords.entries()) {
      const iq = stream.pendingInteractionQueries.get(queryId)
      if (iq && iq.kind === "async_ask") {
        return { conversationId, queryId }
      }
    }
    return undefined
  }

  // ─── Field accessors (step 4 终结) ─────────────────────────────

  getBackgroundCommands(
    conversationId: string
  ): Map<string, SessionBackgroundCommand> {
    return (
      this.streamRecords.get(conversationId)?.backgroundCommands ??
      new Map<never, never>()
    )
  }
  getPendingToolCallByExecId(conversationId: string): Map<number, string> {
    return (
      this.streamRecords.get(conversationId)?.pendingToolCallByExecId ??
      new Map<never, never>()
    )
  }
  getEditPathHolderByPath(conversationId: string): Map<string, string> {
    return (
      this.streamRecords.get(conversationId)?.editPathHolderByPath ??
      new Map<never, never>()
    )
  }
  getEditPathQueueByPath(
    conversationId: string
  ): Map<string, QueuedEditDispatch[]> {
    return (
      this.streamRecords.get(conversationId)?.editPathQueueByPath ??
      new Map<never, never>()
    )
  }
  getPendingInteractionQueries(
    conversationId: string
  ): SessionStreamRecord["pendingInteractionQueries"] {
    return (
      this.streamRecords.get(conversationId)?.pendingInteractionQueries ??
      new Map<never, never>()
    )
  }
  getInteractionQueryId(conversationId: string): number {
    return this.streamRecords.get(conversationId)?.interactionQueryId ?? 0
  }
  mapPendingToolCallByExecId(
    conversationId: string,
    execId: number,
    toolCallId: string
  ): void {
    const s = this.streamRecords.get(conversationId)
    if (!s) return
    s.pendingToolCallByExecId.set(execId, toolCallId)
  }
  consumePendingToolCallByExecId(
    conversationId: string,
    execId: number
  ): string | undefined {
    const s = this.streamRecords.get(conversationId)
    if (!s) return undefined
    const id = s.pendingToolCallByExecId.get(execId)
    if (id !== undefined) s.pendingToolCallByExecId.delete(execId)
    return id
  }
}

// Re-export so callers that previously imported types from
// session-lifecycle.service.ts continue to compile.
export type { SessionRecord }
