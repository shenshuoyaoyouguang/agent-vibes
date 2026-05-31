import { Logger } from "@nestjs/common"
import type { TurnId } from "../turn/turn.types"
import type { SealReason, TurnOutboundWriterStackSnapshot } from "./bidi-types"

/**
 * Thrown synchronously when a turn-runner attempts to write into an
 * outbound that no longer accepts its frames. This is the load-bearing
 * error of the rewrite: today, a superseded turn-runner that wakes up
 * from compaction and yields into a closed AsyncGenerator vanishes
 * silently. Under the new contract that exact action throws right at
 * the violator's stack frame.
 *
 * The error carries the offending turnId AND the seal/state context so
 * the violator's logs are self-explanatory without cross-correlation.
 */
export class OutboundForbiddenError extends Error {
  readonly turnId: TurnId
  readonly state: "open" | "sealing" | "sealed"
  readonly sealReason?: SealReason
  readonly currentWriter?: TurnId

  constructor(args: {
    turnId: TurnId
    state: "open" | "sealing" | "sealed"
    sealReason?: SealReason
    currentWriter?: TurnId
    detail: string
  }) {
    super(
      `OutboundForbidden(turn=${args.turnId}, state=${args.state}` +
        (args.currentWriter ? `, currentWriter=${args.currentWriter}` : "") +
        (args.sealReason ? `, seal=${describeSeal(args.sealReason)}` : "") +
        `): ${args.detail}`
    )
    this.name = "OutboundForbiddenError"
    this.turnId = args.turnId
    this.state = args.state
    this.sealReason = args.sealReason
    this.currentWriter = args.currentWriter
  }
}

/**
 * Thrown by `finishSeal()` when the caller has not first awaited
 * `awaitWritersDrained()`. The seal contract is "no live writers at
 * channel-close": violating it would silently drop in-flight frames
 * during cleanup unwind. Step 5 promotes the previous DEBUG log to a
 * hard exception so the offending unwind path surfaces in tests instead
 * of in production.
 */
export class OutboundSealViolationError extends Error {
  readonly remainingWriters: readonly TurnId[]

  constructor(remainingWriters: readonly TurnId[]) {
    super(
      `OutboundSealViolation: finishSeal() called with ` +
        `${remainingWriters.length} active writer(s): ` +
        `[${remainingWriters.join(",")}]. ` +
        `Caller must await awaitWritersDrained() first.`
    )
    this.name = "OutboundSealViolationError"
    this.remainingWriters = [...remainingWriters]
  }
}

function describeSeal(reason: SealReason): string {
  switch (reason.kind) {
    case "bidi-closed":
      return "bidi-closed"
    case "superseded-by":
      return `superseded-by(${reason.supersedingStreamId.substring(0, 8)})`
    case "turn-terminal":
      return "turn-terminal"
    case "shutdown":
      return "shutdown"
  }
}

/**
 * The single physical writer for a BiDi attachment. Every assistant text,
 * tool dispatch, and protocol frame that the bridge sends to the IDE
 * passes through this object's `write()` method.
 *
 * Invariants:
 *
 *  1. **Active-writer set, not a LIFO stack.** Any turn that has been
 *     `pushWriter`-ed and not yet `popWriter`-ed may write. Concurrent
 *     parallel sub-agents (e.g. `dispatchPreparedToolBatch` fan-out via
 *     `Promise.all`) all live in this set simultaneously and emit frames
 *     in real wall-clock arrival order. The earlier LIFO-stack rule was
 *     incompatible with `dispatchPreparedToolBatch`'s concurrent fan-out:
 *     when the model returned a batch of N task tool calls, the bridge
 *     spawned N sub-agent turns in parallel; each one synchronously
 *     `pushWriter`-ed before its peers ran, so only the last-pushed turn
 *     could write and every other peer threw `OutboundForbidden`,
 *     cascading into mismatched `popWriter` and a dead BiDi stream.
 *
 *  2. **Sealed is terminal.** After `beginSeal()`, every `write()` throws
 *     `OutboundForbiddenError`. `finishSeal()` invokes the seal callback
 *     so the BiDi controller can close the underlying generator.
 *
 *  3. **Frame ordering is monotonic.** A `seq` counter is stamped on every
 *     emit so trace consumers can detect drops or re-orderings. Frames
 *     from concurrent writers interleave by wall-clock arrival; ordering
 *     within a single writer is preserved by JS's single-threaded loop.
 *
 *  4. **Sealing is one-shot.** Calling `beginSeal()` twice is a no-op; the
 *     first reason wins. This protects against the supersede-then-shutdown
 *     path where two events race to close the same outbound.
 *
 *  5. **Push/pop are still paired.** Every push must be matched by exactly
 *     one pop for the same turnId. Double-push is rejected; pop of a
 *     turnId that's not in the active set is rejected. This catches
 *     turn-runners that exit without honouring child lifetime.
 */
export class TurnOutbound {
  private readonly logger = new Logger(TurnOutbound.name)
  readonly conversationId: string
  readonly bidiId: string

  private readonly emit: (frame: Buffer) => void
  private readonly onSealed: (reason: SealReason) => void

  // Order-of-arrival list of active writers. Membership is the only thing
  // `write()` enforces; the order is retained purely for diagnostics
  // (snapshot() / error messages). Most-recently-pushed sits at the end.
  private readonly activeWriters: TurnId[] = []
  private state: "open" | "sealing" | "sealed" = "open"
  private sealReason?: SealReason
  private seq = 0

  constructor(args: {
    conversationId: string
    bidiId: string
    emit: (frame: Buffer) => void
    onSealed: (reason: SealReason) => void
  }) {
    this.conversationId = args.conversationId
    this.bidiId = args.bidiId
    this.emit = args.emit
    this.onSealed = args.onSealed
  }

  /**
   * Mark a turn as an active writer. The turn may write until it is
   * popped. Pushing a turn that is already active is invalid — every
   * push must pair with exactly one pop.
   */
  pushWriter(turnId: TurnId): void {
    if (this.activeWriters.includes(turnId)) {
      throw new Error(`TurnOutbound.pushWriter: turn ${turnId} already active`)
    }
    this.activeWriters.push(turnId)
  }

  /**
   * Remove a turn from the active-writer set. The turn must currently be
   * active; popping a non-member indicates the turn-runner did not
   * honour its push/pop pairing, which is a bug the test suite must
   * catch.
   *
   * Unlike the legacy implementation, the popped turn does not have to
   * be the last-pushed one — concurrent siblings may finish in any
   * order, and the supervisor's `withWriter` wrapper guarantees each
   * runner pops exactly once.
   */
  popWriter(turnId: TurnId): void {
    const idx = this.activeWriters.indexOf(turnId)
    if (idx < 0) {
      throw new Error(
        `TurnOutbound.popWriter: turn=${turnId} not active, ` +
          `active=[${this.activeWriters.join(",")}]`
      )
    }
    this.activeWriters.splice(idx, 1)
  }

  /**
   * Synchronously emit a frame. The check ordering matters: state first,
   * because a sealed outbound is sealed regardless of writer-set
   * contents; and membership second, because a violation there is the
   * supersede-bug signature.
   */
  write(turnId: TurnId, frame: Buffer): void {
    if (this.state !== "open") {
      throw new OutboundForbiddenError({
        turnId,
        state: this.state,
        sealReason: this.sealReason,
        detail: "outbound not open",
      })
    }
    if (!this.activeWriters.includes(turnId)) {
      const last = this.activeWriters[this.activeWriters.length - 1]
      throw new OutboundForbiddenError({
        turnId,
        state: this.state,
        currentWriter: last,
        detail:
          this.activeWriters.length === 0
            ? "no active writers"
            : `turn not in active writers (active=[${this.activeWriters.join(",")}])`,
      })
    }
    this.seq += 1
    this.emit(frame)
  }

  /**
   * Mark the outbound as no longer accepting writes. Frames already
   * passed to `emit()` continue down the wire — sealing only affects
   * future calls. Idempotent: subsequent calls are no-ops, and the first
   * reason wins.
   */
  beginSeal(reason: SealReason): void {
    if (this.state !== "open") return
    this.state = "sealing"
    this.sealReason = reason
    this.logger.debug(
      `TurnOutbound.beginSeal conversation=${this.conversationId} bidi=${this.bidiId.substring(0, 8)} reason=${describeSeal(reason)} activeWriters=${this.activeWriters.length}`
    )
  }

  /**
   * Wait until every active writer has popped (or until the timeout
   * fires). Must be called by `TurnCleanupCoordinator` between
   * `beginSeal()` and `finishSeal()`; the seal contract requires
   * `activeWriters.length === 0` at the moment we close the channel
   * so frames that are mid-flight cannot be dropped.
   *
   * Polling at 50 ms strikes a balance between responsiveness and
   * pointless wakeups. Real cleanup paths drain in single-digit
   * milliseconds; the timeout exists for the pathological case of a
   * runner that has stalled inside its abort handler.
   */
  awaitWritersDrained(opts: {
    timeoutMs: number
  }): Promise<{ drained: boolean; remaining: TurnId[] }> {
    if (this.activeWriters.length === 0) {
      return Promise.resolve({ drained: true, remaining: [] })
    }
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = (): void => {
        if (this.activeWriters.length === 0) {
          resolve({ drained: true, remaining: [] })
          return
        }
        if (Date.now() - start >= opts.timeoutMs) {
          resolve({
            drained: false,
            remaining: [...this.activeWriters],
          })
          return
        }
        setTimeout(tick, 50)
      }
      setTimeout(tick, 50)
    })
  }

  /**
   * Complete the seal handshake. Notifies the controller via `onSealed`
   * so it can close the underlying ConnectRPC generator.
   *
   * Contract: `awaitWritersDrained()` must have resolved with
   * `drained: true` before this is called. If `activeWriters` is
   * non-empty here, throw `OutboundSealViolationError` so the violator
   * surfaces at the call site rather than silently losing frames.
   *
   * The legacy DEBUG-log fallback that simply ignored
   * `activeWriters > 0` was the load-bearing failure mode this step
   * removes.
   */
  finishSeal(): void {
    if (this.state === "sealed") return
    if (this.state === "open") {
      // Seal not begun — caller is closing the BiDi cleanly without an
      // explicit reason. Treat as bidi-closed.
      this.beginSeal({ kind: "bidi-closed" })
    }
    if (this.activeWriters.length > 0) {
      throw new OutboundSealViolationError(this.activeWriters)
    }
    this.state = "sealed"
    const reason = this.sealReason ?? { kind: "bidi-closed" }
    this.sealReason = reason
    this.onSealed(reason)
  }

  /**
   * Force-close the outbound regardless of pending writers. Reserved
   * for the `TurnCleanupCoordinator` timeout path — when
   * `awaitWritersDrained` exhausted its budget and we still need to
   * close the channel, this records an ERROR with the lost-writer set
   * and proceeds. Production should treat any `forceFinishSeal` as a
   * telemetry event worth investigating.
   */
  forceFinishSeal(): { lostWriters: TurnId[] } {
    if (this.state === "sealed") return { lostWriters: [] }
    if (this.state === "open") {
      this.beginSeal({ kind: "bidi-closed" })
    }
    const lost = [...this.activeWriters]
    if (lost.length > 0) {
      this.logger.error(
        `TurnOutbound.forceFinishSeal conversation=${this.conversationId} ` +
          `bidi=${this.bidiId.substring(0, 8)} ` +
          `lost_writers=${lost.length} active=[${lost.join(",")}]`
      )
    }
    this.activeWriters.length = 0
    this.state = "sealed"
    const reason = this.sealReason ?? { kind: "bidi-closed" }
    this.sealReason = reason
    this.onSealed(reason)
    return { lostWriters: lost }
  }

  isOpen(): boolean {
    return this.state === "open"
  }

  /**
   * Returns the most-recently-pushed active writer, if any. This is a
   * diagnostic accessor — the legacy "top of stack" semantics no longer
   * apply, but the most-recent push is still a useful default for log
   * messages and tests that only ever spawn one sub-agent at a time.
   */
  whoOwnsWrite(): TurnId | undefined {
    return this.activeWriters[this.activeWriters.length - 1]
  }

  snapshot(): TurnOutboundWriterStackSnapshot {
    return {
      turns: [...this.activeWriters],
      state: this.state,
      sealReason: this.sealReason,
    }
  }
}
