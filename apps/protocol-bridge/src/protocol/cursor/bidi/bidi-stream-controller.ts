import { Logger } from "@nestjs/common"
import { TurnOutbound } from "./bidi-outbound"
import type { TurnLifecycle } from "../turn/turn-lifecycle.service"
import {
  BidiId,
  ConversationId,
  StreamId,
  type CancelReason,
} from "../turn/turn.types"
import type { BidiAttachment, SealReason } from "./bidi-types"

/**
 * The shape the controller hands to inbound dispatchers — basically
 * a typed view of "frames the IDE just sent us" without any of the
 * generator plumbing. The legacy `handleBidiStream` is the only
 * thing that emits these today; under the new architecture the
 * controller fans out to per-frame handlers that the supervisor
 * routes.
 *
 * The Phase D scope is to express the contract; wiring to the actual
 * decoded ConnectRPC frames lands in the integration phase.
 */
export type InboundFrame =
  | { kind: "user-message"; text: string; raw: Buffer }
  | { kind: "tool-result"; toolCallId: string; raw: Buffer }
  | { kind: "shell-result"; toolCallId: string; raw: Buffer }
  | { kind: "abort-stream"; reason: string }
  | { kind: "heartbeat" }
  | { kind: "client-control"; raw: Buffer }
  | { kind: "unknown"; raw: Buffer }

export interface InboundDispatcher {
  /**
   * Handle a decoded inbound frame. The controller calls this in
   * order; the dispatcher is responsible for spawning turns or
   * routing tool_results via the supervisor + PendingToolStore.
   */
  dispatch(frame: InboundFrame, attachment: BidiAttachment): Promise<void>
}

/**
 * Small interface so the controller can hand the supervisor's
 * cancel knob to BiDi-close paths without dragging the whole
 * supervisor into the controller's API surface.
 *
 * `cleanupBidi` is the step-5 entry point: when supplied, the
 * controller delegates the entire seal+cancel+ledger-sweep+drain
 * sequence to `TurnCleanupCoordinator.cleanup({ kind: "bidi-closed" })`
 * so every termination path goes through one funnel. The legacy
 * `cancelBidi`-only fallback is kept for tests that wire a bare
 * lifecycle without a coordinator.
 */
interface SupervisorBridge {
  cancelBidi(bidiId: BidiId, reason: CancelReason): number
  cleanupBidi?(
    bidiId: BidiId,
    outbound: TurnOutbound,
    reason: SealReason
  ): Promise<void>
}

/**
 * One per BiDi attachment. Owns the TurnOutbound, manages the
 * lifecycle of the inbound iterator, and seals on close.
 *
 * `handle()` is shaped as an AsyncIterable<Buffer> so it can be
 * returned directly from a ConnectRPC server-streaming handler. The
 * controller does NOT yield from inside turn-runners — instead, it
 * exposes a BufferChannel that runners write to via the
 * `TurnOutbound`, and `handle()` simply iterates that channel.
 *
 * This separation is the load-bearing structural change: today, the
 * outbound is the generator function's `yield` site, which means
 * frame ownership is implicit in the JavaScript stack. With the
 * channel as the seam, ownership is explicit (the writer stack on
 * the outbound) and the generator just drains.
 */
export class BidiStreamController {
  private readonly logger = new Logger(BidiStreamController.name)
  readonly attachment: BidiAttachment
  readonly outbound: TurnOutbound

  private readonly outboundChannel = new BufferChannelLite()
  private streamSealed = false

  constructor(args: {
    conversationId: string
    bidiId: string
    streamId: string
    supervisor: SupervisorBridge
  }) {
    this.attachment = {
      conversationId: args.conversationId,
      bidiId: args.bidiId,
      streamId: args.streamId,
      attachedAt: new Date(),
    }
    this.outbound = new TurnOutbound({
      conversationId: args.conversationId,
      bidiId: args.bidiId,
      emit: (frame) => {
        if (this.streamSealed) return
        this.outboundChannel.push(frame)
      },
      onSealed: (reason) => {
        // When the outbound seals, finalise the channel so the
        // generator returned by `handle()` exits.
        this.streamSealed = true
        this.outboundChannel.close()
        this.logger.debug(
          `outbound sealed bidi=${args.bidiId.substring(0, 8)} reason=${reason.kind}`
        )
      },
    })
    this.supervisor = args.supervisor
  }

  private readonly supervisor: SupervisorBridge

  /**
   * Server-streaming generator: yields every frame the outbound
   * accepts, in arrival order. Exits when the outbound is sealed.
   */
  async *handle(): AsyncGenerator<Buffer> {
    for await (const frame of this.outboundChannel) {
      yield frame
    }
  }

  /**
   * Drive an inbound stream of decoded frames into the dispatcher.
   * The controller is purposefully ignorant of how frames are
   * decoded — `decode` is the seam where the integration layer
   * plugs in cursor's ConnectRPC schema parsers.
   */
  async pump(
    source: AsyncIterable<InboundFrame>,
    dispatcher: InboundDispatcher
  ): Promise<void> {
    try {
      for await (const frame of source) {
        await dispatcher.dispatch(frame, this.attachment)
      }
    } catch (err) {
      this.logger.error(
        `inbound pump failed bidi=${this.attachment.bidiId.substring(0, 8)}: ${(err as Error).message}`
      )
      this.seal({ kind: "bidi-closed" })
      throw err
    } finally {
      this.seal({ kind: "bidi-closed" })
    }
  }

  /**
   * Seal the outbound and cancel any turns still active for this
   * conversation. Idempotent.
   *
   * Step 5 routed the full seal protocol through
   * `TurnCleanupCoordinator.cleanup` so the cancel + ledger sweep +
   * writer drain + finishSeal sequence happens under one funnel.
   * When `supervisor.cleanupBidi` is unavailable (legacy test paths
   * without coordinator wiring) we fall back to the pre-step-5
   * direct seal — that fallback is *not* used in production.
   */
  seal(reason: SealReason): void {
    if (this.streamSealed) return
    this.streamSealed = true
    if (this.supervisor.cleanupBidi) {
      // Coordinator owns the unwind; do not touch outbound directly
      // here — the coordinator will call beginSeal → drain → ledger
      // sweep → finishSeal in order. Fire-and-forget by design:
      // BidiStreamController.seal is invoked from generator finally
      // blocks that cannot await, and the BiDi outbound is the
      // observed completion signal for the connection lifecycle.
      void this.supervisor
        .cleanupBidi(BidiId.of(this.attachment.bidiId), this.outbound, reason)
        .catch((err) => {
          this.logger.error(
            `cleanup(bidi-closed) failed bidi=${this.attachment.bidiId.substring(0, 8)}: ${(err as Error).message}`
          )
        })
      return
    }
    // Fallback for tests that wire BidiStreamController without a
    // coordinator: do the original direct seal.
    this.outbound.beginSeal(reason)
    this.outbound.finishSeal()
    this.supervisor.cancelBidi(
      BidiId.of(this.attachment.bidiId),
      this.cancelReasonForSeal(reason)
    )
  }

  /**
   * Rotate the streamId without sealing. Used when the IDE issues a
   * new chat request inside the same BiDi — the outbound stays
   * open, but a new TurnId is allocated under the new streamId.
   *
   * NOTE: streamId is read-only on the BidiAttachment (it is the
   * rotation point recorded at attach-time); this method updates a
   * private mutable copy that the supervisor consults.
   */
  private rotatedStreamId: string | undefined
  rotateStreamId(nextStreamId: string): void {
    this.rotatedStreamId = nextStreamId
  }
  currentStreamId(): StreamId {
    return StreamId.of(this.rotatedStreamId ?? this.attachment.streamId)
  }
  currentConversationId(): ConversationId {
    return ConversationId.of(this.attachment.conversationId)
  }

  private cancelReasonForSeal(reason: SealReason): CancelReason {
    switch (reason.kind) {
      case "bidi-closed":
        return { kind: "bidi-closed" }
      case "shutdown":
        return { kind: "shutdown" }
      case "superseded-by":
        // The streamId being superseded does NOT translate to a
        // turn-level supersede here — that's the supervisor's job
        // when a new turn is spawned. Treat this as bidi-closed.
        return { kind: "bidi-closed" }
      case "turn-terminal":
        return { kind: "bidi-closed" }
    }
  }
}

/**
 * Tiny inline buffer channel — same contract as
 * `concurrency/buffer-channel.ts` but specialised to Buffer to keep
 * the bidi-layer module standalone (no `concurrency` import cycle
 * worry while we wire integration). When the integration phase
 * lands and the imports are clean, this will be replaced with the
 * shared `BufferChannel<Buffer>` instance.
 */
class BufferChannelLite implements AsyncIterable<Buffer> {
  private readonly queue: Buffer[] = []
  private resolvers: Array<(v: IteratorResult<Buffer>) => void> = []
  private closed = false

  push(value: Buffer): void {
    if (this.closed) return
    const r = this.resolvers.shift()
    if (r) r({ value, done: false })
    else this.queue.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.queue.length === 0) {
      const waiters = this.resolvers
      this.resolvers = []
      for (const r of waiters)
        r({ value: undefined as unknown as Buffer, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as Buffer,
            done: true,
          })
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve)
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({
          value: undefined as unknown as Buffer,
          done: true,
        })
      },
    }
  }
}

/**
 * Used by tests to construct a `SupervisorBridge` without a real
 * `TurnLifecycle`. Production callers always pass an actual
 * supervisor.
 */
export type { TurnLifecycle }
