import { Injectable, Logger } from "@nestjs/common"

/**
 * Per-conversation queue that ensures only one ExecServerMessage is in
 * flight to the Cursor IDE at a time.
 *
 * # Why this exists
 *
 * Empirically, the Cursor IDE accepts AgentServerMessage frames over the
 * `agent.v1.AgentService/Run` BiDi stream sequentially: when the bridge
 * pushes two ExecServerMessage envelopes back-to-back (e.g. a model
 * batch with two parallel `list_directory` tool_use blocks), the IDE
 * only ever returns the result + streamClose for the **last** one. The
 * earlier dispatches are silently dropped — the corresponding pending
 * tool call hangs indefinitely on the bridge side until the user
 * cancels the turn. This was observed on Cursor 3.4.16 with bridge
 * ExecServerMessage.id values 1 and 2 dispatched within ~10ms of each
 * other; the IDE replied only with `id=2` ls_result + streamClose, and
 * never closed exec stream id=1.
 *
 * The fix is to gate the bridge → IDE direction on the IDE's own
 * confirmation that the previous exec slot has closed:
 *
 *   1. Every ExecServerMessage emit is routed through `enqueueAndEmit`.
 *   2. If no exec is in flight for the conversation, the frame is
 *      forwarded to the outbound writer immediately and the slot is
 *      marked busy.
 *   3. Otherwise the frame is parked on a FIFO queue and emitted later.
 *   4. When the IDE sends `ExecClientControlMessage.stream_close` (or
 *      the equivalent terminal `throw`) for the in-flight execId,
 *      `release` is called: the slot is cleared and the next queued
 *      frame is flushed.
 *
 * Edit's read→write protocol is naturally compatible: the IDE's
 * read_result + streamClose for the readArgs slot triggers `release`
 * before the bridge emits the matching writeArgs. If the bridge emits
 * writeArgs synchronously inside the read_result handler (i.e. before
 * the streamClose for the read slot has been parsed), the writeArgs is
 * queued and flushed the moment streamClose arrives — at most a few
 * milliseconds later, and on the same single-threaded event loop turn
 * that processed the read_result.
 *
 * # Lifecycle
 *
 * - `enqueueAndEmit`: dispatch site (replaces a raw `emit(frame)` call
 *   that carries an ExecServerMessage payload).
 * - `release`: called from the inbound parser when an
 *   `execStreamClose` or `execThrow` arrives.
 * - `clearConversation`: called when the BiDi stream tears down or the
 *   conversation is discarded; drops any queued frames so they are not
 *   leaked into a fresh BiDi attachment.
 *
 * # Invariants
 *
 * - Only one in-flight execId per conversation. The serializer never
 *   emits a queued frame while another is in flight; release is the
 *   only path to advance the queue.
 * - `release` for a non-matching execId is a no-op (logged at debug),
 *   so duplicate streamClose / out-of-order throws don't double-flush.
 * - All bookkeeping is per `conversationId`. The serializer never
 *   mixes state across conversations even when the supervisor races
 *   two BiDi attachments for the same cid.
 */
@Injectable()
export class ExecDispatchSerializerService {
  private readonly logger = new Logger(ExecDispatchSerializerService.name)

  private readonly stateByConversation = new Map<
    string,
    {
      inFlight?: { execId: number; label: string; sentAt: Date }
      queue: Array<{ execId: number; frame: Buffer; label: string }>
    }
  >()

  /**
   * Dispatch an ExecServerMessage frame for `conversationId`. If no
   * other ExecServerMessage is currently in flight on this
   * conversation, the frame is emitted immediately via `emit`.
   * Otherwise it is parked until the in-flight slot is released.
   *
   * Returns `true` if the frame was emitted synchronously, `false` if
   * it was queued. This is used purely for tracing — both paths are
   * functionally correct.
   */
  enqueueAndEmit(
    conversationId: string,
    execId: number,
    frame: Buffer,
    label: string,
    emit: (frame: Buffer) => void
  ): boolean {
    if (!Number.isFinite(execId) || execId <= 0) {
      this.logger.warn(
        `enqueueAndEmit: skipping serialization for invalid execId=${execId} (label=${label}); emitting directly`
      )
      emit(frame)
      return true
    }

    const state = this.getOrCreateState(conversationId)
    if (!state.inFlight) {
      state.inFlight = { execId, label, sentAt: new Date() }
      this.logger.debug(
        `ExecDispatch dispatch: conversation=${conversationId} execId=${execId} label=${label}`
      )
      emit(frame)
      return true
    }

    state.queue.push({ execId, frame, label })
    this.logger.debug(
      `ExecDispatch queued: conversation=${conversationId} execId=${execId} label=${label} ` +
        `(in-flight execId=${state.inFlight.execId} label=${state.inFlight.label}, queueDepth=${state.queue.length})`
    )
    return false
  }

  /**
   * Mark the in-flight slot as released and flush the next queued
   * frame, if any. The caller passes the same `emit` it used when
   * enqueuing so the serializer doesn't have to capture writer state.
   *
   * Returns the execId of the frame that was flushed (if any), or
   * undefined when nothing was queued.
   */
  release(
    conversationId: string,
    execId: number,
    emit: (frame: Buffer) => void
  ): number | undefined {
    if (!Number.isFinite(execId) || execId <= 0) return undefined

    const state = this.stateByConversation.get(conversationId)
    if (!state) return undefined

    if (!state.inFlight || state.inFlight.execId !== execId) {
      // Either we never tracked this execId (e.g. inline tool that
      // bypassed the serializer) or release has already been called
      // for it. Both are benign — just log at debug.
      this.logger.debug(
        `ExecDispatch release: conversation=${conversationId} execId=${execId} ` +
          `(in-flight execId=${state.inFlight?.execId ?? "(none)"}); ignoring`
      )
      return undefined
    }

    const released = state.inFlight
    state.inFlight = undefined
    this.logger.debug(
      `ExecDispatch released: conversation=${conversationId} execId=${released.execId} label=${released.label} ` +
        `held_ms=${Date.now() - released.sentAt.getTime()} queueDepth=${state.queue.length}`
    )

    const next = state.queue.shift()
    if (!next) {
      this.maybeCleanup(conversationId, state)
      return undefined
    }

    state.inFlight = {
      execId: next.execId,
      label: next.label,
      sentAt: new Date(),
    }
    this.logger.debug(
      `ExecDispatch dispatch (after release): conversation=${conversationId} execId=${next.execId} label=${next.label}`
    )
    emit(next.frame)
    return next.execId
  }

  /**
   * Drop everything tracked for a conversation. Called on BiDi
   * teardown, supersede, or session deletion. Frames currently parked
   * on the queue are NOT emitted — the IDE has either gone away or is
   * about to receive a fresh stream where their original execIds no
   * longer make sense.
   */
  clearConversation(conversationId: string): void {
    const state = this.stateByConversation.get(conversationId)
    if (!state) return
    if (state.inFlight || state.queue.length > 0) {
      this.logger.debug(
        `ExecDispatch clear: conversation=${conversationId} ` +
          `dropped in-flight=${state.inFlight ? state.inFlight.execId : "(none)"} ` +
          `queueDepth=${state.queue.length}`
      )
    }
    this.stateByConversation.delete(conversationId)
  }

  /**
   * Diagnostic snapshot — used by tests and turn telemetry to verify
   * the serializer is in the expected state. Returns `undefined` when
   * the conversation has no tracked state.
   */
  snapshot(conversationId: string):
    | {
        inFlight?: { execId: number; label: string; sentAt: Date }
        queueDepth: number
        queuedExecIds: number[]
      }
    | undefined {
    const state = this.stateByConversation.get(conversationId)
    if (!state) return undefined
    return {
      inFlight: state.inFlight
        ? { ...state.inFlight, sentAt: new Date(state.inFlight.sentAt) }
        : undefined,
      queueDepth: state.queue.length,
      queuedExecIds: state.queue.map((entry) => entry.execId),
    }
  }

  private getOrCreateState(
    conversationId: string
  ): NonNullable<ReturnType<typeof this.stateByConversation.get>> {
    let state = this.stateByConversation.get(conversationId)
    if (!state) {
      state = { queue: [] }
      this.stateByConversation.set(conversationId, state)
    }
    return state
  }

  private maybeCleanup(
    conversationId: string,
    state: { inFlight?: unknown; queue: unknown[] }
  ): void {
    if (!state.inFlight && state.queue.length === 0) {
      this.stateByConversation.delete(conversationId)
    }
  }
}
