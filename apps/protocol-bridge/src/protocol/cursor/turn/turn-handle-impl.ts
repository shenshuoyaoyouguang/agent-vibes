import { Logger } from "@nestjs/common"
import type { TurnOutbound } from "../bidi/bidi-outbound"
import type {
  CancelReason,
  ConversationId,
  StreamId,
  TurnId,
  TurnKind,
  TurnPhase,
  TurnTerminalResult,
} from "./turn.types"
import type { TurnHandle } from "./turn-handle"

/**
 * Concrete TurnHandle. Owns the AbortController for its turn — the
 * supervisor reaches in via `cancel()` and `dispose()` but turn-runners
 * only see the handle's public surface.
 *
 * The handle does not push/pop the writer stack itself; that is the
 * supervisor's job (see `withWriter`) so push/pop is symmetric across
 * throws and never half-applied.
 */
export class TurnHandleImpl implements TurnHandle {
  private readonly logger = new Logger(TurnHandleImpl.name)
  readonly turnId: TurnId
  readonly turnKind: TurnKind
  readonly conversationId: ConversationId
  readonly streamId: StreamId
  readonly outbound: TurnOutbound | undefined

  private readonly abortController: AbortController
  private cancelReason: CancelReason | undefined
  private terminalResult: TurnTerminalResult | undefined
  private readonly phaseLog: Array<{
    phase: TurnPhase
    detail: string | undefined
    at: number
  }> = []
  private readonly onTerminal: (result: TurnTerminalResult) => void

  constructor(args: {
    turnId: TurnId
    turnKind: TurnKind
    conversationId: ConversationId
    streamId: StreamId
    outbound: TurnOutbound | undefined
    onTerminal: (result: TurnTerminalResult) => void
    parentSignal?: AbortSignal
  }) {
    this.turnId = args.turnId
    this.turnKind = args.turnKind
    this.conversationId = args.conversationId
    this.streamId = args.streamId
    this.outbound = args.outbound
    this.onTerminal = args.onTerminal
    this.abortController = new AbortController()
    if (args.parentSignal) {
      // Foreground subagents inherit the parent's abort scope.
      // If the parent is already cancelled, our signal is too.
      if (args.parentSignal.aborted) {
        this.abortController.abort(args.parentSignal.reason)
        this.cancelReason = {
          kind: "parent-cancelled",
          ancestor: args.turnId, // best-effort; supervisor overwrites with real ancestor
        }
      } else {
        const onParentAbort = () => {
          this.cancel({
            kind: "parent-cancelled",
            ancestor: args.turnId,
          })
        }
        args.parentSignal.addEventListener("abort", onParentAbort, {
          once: true,
        })
      }
    }
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  recordPhase(phase: TurnPhase, detail?: string): void {
    this.phaseLog.push({ phase, detail, at: Date.now() })
  }

  reportTerminal(result: TurnTerminalResult): void {
    if (this.terminalResult) {
      throw new Error(
        `TurnHandle.reportTerminal called twice for turn ${this.turnId} (existing=${this.terminalResult.status})`
      )
    }
    this.terminalResult = result
    this.onTerminal(result)
  }

  cancellationReason(): CancelReason | undefined {
    return this.cancelReason
  }

  /**
   * Supervisor-only: cancel this turn. Idempotent — first reason
   * wins. Aborts the underlying controller so any in-flight async
   * work observing `signal` unwinds.
   */
  cancel(reason: CancelReason): void {
    if (this.cancelReason) return
    this.cancelReason = reason
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(this.formatAbortReason(reason))
    }
  }

  /**
   * Supervisor-only: returns whether terminal has been reported.
   * Used by the supervisor to decide whether to synthesize a
   * cancellation result on the awaitTerminal path.
   */
  hasTerminal(): boolean {
    return this.terminalResult !== undefined
  }

  /**
   * Supervisor-only: synthesize a terminal result on behalf of a
   * runner that did not call `reportTerminal()` before exiting.
   */
  forceTerminal(result: TurnTerminalResult): void {
    if (this.terminalResult) return
    this.terminalResult = result
    this.onTerminal(result)
  }

  phaseHistory(): ReadonlyArray<{
    phase: TurnPhase
    detail: string | undefined
    at: number
  }> {
    return this.phaseLog
  }

  private formatAbortReason(reason: CancelReason): Error {
    switch (reason.kind) {
      case "user-cancel":
        return new Error(`turn cancelled: user-cancel(${reason.reason})`)
      case "superseded":
        return new Error(`turn cancelled: superseded by ${reason.by}`)
      case "bidi-closed":
        return new Error("turn cancelled: bidi-closed")
      case "parent-cancelled":
        return new Error(
          `turn cancelled: parent-cancelled by ${reason.ancestor}`
        )
      case "shutdown":
        return new Error("turn cancelled: shutdown")
    }
  }
}

/**
 * Run `body` with `handle.turnId` pushed onto the outbound writer
 * stack, popping symmetrically afterwards even on throw.
 *
 * For turns that have no outbound (synthetic-compaction), this is a
 * no-op wrapper that just calls `body`.
 *
 * The supervisor uses this around every turn-runner invocation so
 * the runner can call `outbound.write(turnId, frame)` and the stack
 * invariant is automatically maintained. Runners are NOT allowed to
 * touch `pushWriter`/`popWriter` themselves.
 */
export async function withWriter<T>(
  outbound: TurnOutbound | undefined,
  turnId: TurnId,
  body: () => Promise<T>
): Promise<T> {
  if (!outbound) return body()
  outbound.pushWriter(turnId)
  let bodyError: unknown
  try {
    return await body()
  } catch (err) {
    bodyError = err
    throw err
  } finally {
    try {
      outbound.popWriter(turnId)
    } catch (popErr) {
      // popWriter throws if the stack is not in the expected state.
      // The body's error (if any) takes precedence — losing the
      // original error to a pop mismatch would mask the real bug.
      // If there is no body error, the popWriter mismatch is itself
      // the failure — we log loudly and let the body's normal
      // return prevail; the test suite catches mismatches because
      // a stale stack will trip the next push.
      const log = new Logger("withWriter")
      const detail = (popErr as Error).message
      if (bodyError) {
        log.error(
          `popWriter mismatch for turn=${turnId} (suppressed in favour of body error): ${detail}`
        )
      } else {
        log.error(`popWriter mismatch for turn=${turnId}: ${detail}`)
      }
    }
  }
}
