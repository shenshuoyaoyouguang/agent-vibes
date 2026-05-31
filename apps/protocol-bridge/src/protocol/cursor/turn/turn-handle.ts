import type { TurnOutbound } from "../bidi/bidi-outbound"
import type {
  CancelReason,
  ConversationId,
  StreamId,
  TurnId,
  TurnKind,
  TurnPhase,
  TurnTerminalResult,
} from "../turn/turn.types"

/**
 * The handle a Turn-runner uses to talk to the rest of the bridge.
 * Deliberately small: a runner gets exactly one of these and never
 * touches the controller, the BiDi attachment, or the Nest DI graph
 * directly. Everything they need to do is one of:
 *
 *  - read identity (`turnId`, `conversationId`, `streamId`)
 *  - emit an outbound frame (`outbound.write(turnId, frame)`)
 *  - observe cancellation (`signal`)
 *  - mark themselves as advanced through an FSM phase (`recordPhase`)
 *  - report a terminal result (`reportTerminal`)
 *
 * A turn that needs to spawn a child turn does so via the
 * supervisor that produced this handle, not via the handle itself.
 * That keeps the supervisor as the single owner of the turn graph.
 */
export interface TurnHandle {
  readonly turnId: TurnId
  readonly turnKind: TurnKind
  readonly conversationId: ConversationId
  readonly streamId: StreamId

  /**
   * AbortSignal that fires when the turn is cancelled for any reason
   * (user-cancel, supersede, parent-cancel, shutdown, bidi-closed).
   * Runners should propagate this to every async operation they kick
   * off — backend HTTP calls, sub-agent spawns, file IO with
   * cancellable readers — so cancellation is observed without
   * polling.
   */
  readonly signal: AbortSignal

  /**
   * The outbound writer for this turn's BiDi attachment. May be
   * `undefined` for turn kinds that do not own an outbound
   * (synthetic-compaction). When defined, the runner MUST pass its
   * own `turnId` to `outbound.write()`; the writer-stack invariant
   * will throw `OutboundForbiddenError` if it is not the top of
   * stack.
   */
  readonly outbound: TurnOutbound | undefined

  /**
   * Record an FSM phase transition for observability. Pure
   * book-keeping — does not gate execution. The supervisor uses this
   * to drive turn-state telemetry and to time the foreground grace
   * period before aborting on supersede.
   */
  recordPhase(phase: TurnPhase, detail?: string): void

  /**
   * Report the terminal result. Calling this twice is a programmer
   * error — the second call throws. The supervisor resolves the
   * `awaitTerminal()` promise off this report.
   */
  reportTerminal(result: TurnTerminalResult): void

  /**
   * Convenience for runners: returns the cancellation reason if the
   * turn has already been cancelled, otherwise `undefined`. Mostly
   * used in catch handlers that want to distinguish a "we were
   * aborted" error from a genuine backend failure without having to
   * inspect the AbortError shape.
   */
  cancellationReason(): CancelReason | undefined
}
