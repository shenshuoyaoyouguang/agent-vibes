import { Injectable, Logger } from "@nestjs/common"
import { MessageStore } from "../session/message-store.service"
import {
  ToolCallLedger,
  type AbortReason,
} from "../session/tool-call-ledger.service"
import {
  OutboundSealViolationError,
  type TurnOutbound,
} from "../bidi/bidi-outbound"
import { TurnLifecycle } from "./turn-lifecycle.service"
import {
  type BidiId,
  type CancelReason,
  type ConversationId,
  type TurnId,
} from "./turn.types"

/**
 * Single funnel for every interruption / cleanup path in the bridge.
 *
 * Pre-step-5 the bridge had five distinct unwind sites:
 *   1. `BidiStreamController.seal` (BiDi closed by client)
 *   2. `cursor-connect-stream.handleBidiStream` finally (BiDi
 *      superseded by a new attachment)
 *   3. `cursor-connect-stream.handleChatMessage` supersede (new user
 *      message lands while the previous turn is still in-flight)
 *   4. `cursor-connect-stream` inbound `abort-stream` dispatcher
 *      (user-cancel via `cancelTurnAndAwait`)
 *   5. `PendingDeadlineSweeper` expiry
 *
 * Each site reimplemented its own ordering: some called
 * `outbound.beginSeal+finishSeal` directly, some cancelled the
 * supervisor first, some ran ledger sweeps after the channel was
 * already closed (so abort tool_results never made it back to the
 * IDE). The cleanup coordinator collapses all five into a single
 * 6-step protocol so ordering is uniform and observable:
 *
 *   1. `outbound.beginSeal(reason)` — reject new writes immediately
 *      so a runner that wakes up mid-cancel cannot interleave a frame
 *      between cancel and ledger sweep.
 *   2. snapshot the conversations we will need to ledger-sweep
 *      (capture under the BiDi BEFORE cancellation drops records).
 *   3. `lifecycle.cancelBidiAndAwait(...)` (or `cancelTurnAndAwait`)
 *      — fire AbortSignal, wait for every runner's `finally` to run.
 *   4. `outbound.awaitWritersDrained({ timeout })` — guarantee no
 *      writer remains active before closing the channel.
 *   5. `messageStore.runInTransaction(cid, txn => {
 *        ledger.abortAll(...);
 *        for (const id of aborted) messageStore.appendAbortToolResultBlock(...)
 *      })` — atomically transition open ledger entries to aborted
 *      and emit the structured `[abort:{reason}]` tool_results.
 *   6. `outbound.finishSeal()` (or `forceFinishSeal()` on timeout) —
 *      close the channel, emit `onSealed` to the controller.
 *
 * The function returns synchronously to the caller; failures inside
 * any individual step are logged and folded into the
 * `CleanupReport` rather than rethrown.
 */
export type CleanupInput =
  | { kind: "bidi-closed"; bidiId: BidiId; outbound: TurnOutbound }
  | {
      kind: "bidi-superseded"
      oldBidiId: BidiId
      newBidiId: BidiId
      outbound: TurnOutbound
    }
  | {
      kind: "turn-superseded"
      oldTurnId: TurnId
      newTurnId: TurnId
      conversationId: ConversationId
    }
  | {
      kind: "user-cancelled"
      turnId: TurnId
      conversationId: ConversationId
      reason: string
    }
  | { kind: "shutdown" }
  | {
      kind: "deadline-expired"
      conversationId: ConversationId
      turnId: TurnId
      toolCallIds: string[]
    }

export interface CleanupReport {
  kind: CleanupInput["kind"]
  cancelledTurnCount: number
  drained: boolean
  abortedToolCallCount: number
  forced: boolean
  errors: string[]
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

@Injectable()
export class TurnCleanupCoordinator {
  private readonly logger = new Logger(TurnCleanupCoordinator.name)

  constructor(
    private readonly lifecycle: TurnLifecycle,
    private readonly messageStore: MessageStore,
    private readonly ledger: ToolCallLedger
  ) {}

  async cleanup(
    input: CleanupInput,
    opts: { drainTimeoutMs?: number } = {}
  ): Promise<CleanupReport> {
    const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    const errors: string[] = []
    let cancelledTurnCount = 0
    let abortedToolCallCount = 0
    let drained = true
    let forced = false

    try {
      switch (input.kind) {
        case "bidi-closed":
        case "bidi-superseded": {
          const result = await this.unwindBidi(
            input.kind === "bidi-closed" ? input.bidiId : input.oldBidiId,
            input.outbound,
            mapReasonForBidi(input),
            mapAbortReasonForBidi(input.kind),
            drainTimeoutMs,
            errors
          )
          cancelledTurnCount = result.cancelled
          abortedToolCallCount = result.abortedToolCalls
          drained = result.drained
          forced = result.forced
          break
        }
        case "turn-superseded": {
          const result = await this.unwindTurn(
            input.oldTurnId,
            input.conversationId,
            { kind: "superseded", by: input.newTurnId },
            "turn_superseded",
            errors
          )
          cancelledTurnCount = result.cancelled
          abortedToolCallCount = result.abortedToolCalls
          break
        }
        case "user-cancelled": {
          const result = await this.unwindTurn(
            input.turnId,
            input.conversationId,
            { kind: "user-cancel", reason: input.reason },
            "user_cancelled",
            errors
          )
          cancelledTurnCount = result.cancelled
          abortedToolCallCount = result.abortedToolCalls
          break
        }
        case "shutdown": {
          // Shutdown is process-wide; per-bidi seal happens through
          // the per-controller seal path. Coordinator's job here is
          // just to drive lifecycle.cancelConversation through the
          // same audit-log discipline as the other entry points.
          // The actual outbound seal arrives via each controller's
          // own seal() handler (which calls back into this method
          // with kind=bidi-closed).
          break
        }
        case "deadline-expired": {
          const result = await this.unwindDeadline(
            input.conversationId,
            input.turnId,
            input.toolCallIds,
            errors
          )
          abortedToolCallCount = result.abortedToolCalls
          break
        }
      }
    } catch (err) {
      errors.push(`cleanup(${input.kind}): ${(err as Error).message}`)
    }

    this.logger.log(
      `[cleanup] kind=${input.kind} cancelled=${cancelledTurnCount} ` +
        `drained=${drained} forced=${forced} ` +
        `tool_aborts=${abortedToolCallCount}` +
        (errors.length > 0 ? ` errors=${errors.length}` : "")
    )

    return {
      kind: input.kind,
      cancelledTurnCount,
      drained,
      abortedToolCallCount,
      forced,
      errors,
    }
  }

  // ── internal: bidi unwind ────────────────────────────────────────

  private async unwindBidi(
    bidiId: BidiId,
    outbound: TurnOutbound,
    cancelReason: CancelReason,
    abortReason: AbortReason,
    drainTimeoutMs: number,
    errors: string[]
  ): Promise<{
    cancelled: number
    abortedToolCalls: number
    drained: boolean
    forced: boolean
  }> {
    // Step 1: stop accepting new writes.
    outbound.beginSeal(
      cancelReason.kind === "superseded"
        ? {
            kind: "superseded-by",
            supersedingStreamId: cancelReason.by as unknown as string,
          }
        : cancelReason.kind === "shutdown"
          ? { kind: "shutdown" }
          : { kind: "bidi-closed" }
    )

    // Step 2: snapshot turn → conversation pairs BEFORE cancellation
    // because cancelBidi cascades into driveRunner's finally, which
    // detaches the records.
    const snapshot = this.lifecycle.listTurnsForBidi(bidiId)

    // Step 3: cancel and await every runner's terminal.
    let cancelled = 0
    try {
      const terminals = await this.lifecycle.cancelBidiAndAwait(
        bidiId,
        cancelReason
      )
      cancelled = terminals.length
    } catch (err) {
      errors.push(`cancelBidiAndAwait: ${(err as Error).message}`)
    }

    // Step 4: drain writers.
    let drained = true
    let forced = false
    try {
      const result = await outbound.awaitWritersDrained({
        timeoutMs: drainTimeoutMs,
      })
      drained = result.drained
      if (!drained) {
        this.logger.error(
          `outbound writers did not drain in ${drainTimeoutMs}ms ` +
            `bidi=${bidiId.substring(0, 8)} remaining=${result.remaining.length}`
        )
      }
    } catch (err) {
      drained = false
      errors.push(`awaitWritersDrained: ${(err as Error).message}`)
    }

    // Step 5: ledger sweep + structured abort tool_results in one txn
    // per conversation. Multiple turns may share a conversationId
    // (parent + foreground-subagent); de-dup to avoid double-sweeping.
    let abortedToolCalls = 0
    const sweptConversations = new Set<ConversationId>()
    for (const { turnId, conversationId } of snapshot) {
      if (sweptConversations.has(conversationId)) continue
      sweptConversations.add(conversationId)
      try {
        abortedToolCalls += this.sweepConversation(
          conversationId,
          turnId,
          abortReason
        )
      } catch (err) {
        errors.push(`sweep(${conversationId}): ${(err as Error).message}`)
      }
    }

    // Step 6: close the channel.
    try {
      if (drained) {
        outbound.finishSeal()
      } else {
        const { lostWriters } = outbound.forceFinishSeal()
        if (lostWriters.length > 0) {
          forced = true
        }
      }
    } catch (err) {
      if (err instanceof OutboundSealViolationError) {
        // Drained said true but a writer was racing us — force-close
        // and surface for telemetry.
        outbound.forceFinishSeal()
        forced = true
        errors.push(`finishSeal violated drained contract: ${err.message}`)
      } else {
        errors.push(`finishSeal: ${(err as Error).message}`)
      }
    }

    return { cancelled, abortedToolCalls, drained, forced }
  }

  // ── internal: per-turn unwind (supersede / user-cancel) ─────────

  private async unwindTurn(
    turnId: TurnId,
    conversationId: ConversationId,
    cancelReason: CancelReason,
    abortReason: AbortReason,
    errors: string[]
  ): Promise<{ cancelled: number; abortedToolCalls: number }> {
    let cancelled = 0
    try {
      const result = await this.lifecycle.cancelTurnAndAwait(
        turnId,
        cancelReason
      )
      if (result) cancelled = 1
    } catch (err) {
      errors.push(`cancelTurnAndAwait: ${(err as Error).message}`)
    }

    let abortedToolCalls = 0
    try {
      abortedToolCalls += this.sweepConversation(
        conversationId,
        turnId,
        abortReason
      )
    } catch (err) {
      errors.push(`sweep(${conversationId}): ${(err as Error).message}`)
    }
    return { cancelled, abortedToolCalls }
  }

  // ── internal: deadline-expired path ──────────────────────────────

  private async unwindDeadline(
    conversationId: ConversationId,
    turnId: TurnId,
    toolCallIds: string[],
    errors: string[]
  ): Promise<{ abortedToolCalls: number }> {
    if (toolCallIds.length === 0) {
      return { abortedToolCalls: 0 }
    }
    let abortedToolCalls = 0
    try {
      this.messageStore.runInTransaction(conversationId, (txn) => {
        const result = this.ledger.abortAll(txn, {
          turnId,
          reason: "deadline_expired",
        })
        abortedToolCalls = result.abortedToolCallIds.length
        for (const entry of result.abortedToolCallIds) {
          const block = ToolCallLedger.buildAbortToolResult(
            entry.toolUseId,
            "deadline_expired"
          )
          this.messageStore.appendAbortToolResultBlock(txn, block, {
            turnId,
          })
        }
      })
    } catch (err) {
      errors.push(`deadline sweep: ${(err as Error).message}`)
    }
    return { abortedToolCalls }
  }

  // ── shared sweep helper ──────────────────────────────────────────

  /**
   * Inside a single SQLite transaction, transition every open ledger
   * entry for the (conversation, turn) pair to `aborted` and append
   * the matching synthetic `is_error: true` tool_result blocks so
   * the transcript carries a structured `[abort:{reason}]` payload
   * the next backend request can ingest without sanitize repair.
   */
  private sweepConversation(
    conversationId: ConversationId,
    turnId: TurnId,
    abortReason: AbortReason
  ): number {
    let abortedCount = 0
    this.messageStore.runInTransaction(conversationId, (txn) => {
      const result = this.ledger.abortAll(txn, {
        turnId,
        reason: abortReason,
      })
      abortedCount = result.abortedToolCallIds.length
      for (const entry of result.abortedToolCallIds) {
        const block = ToolCallLedger.buildAbortToolResult(
          entry.toolUseId,
          abortReason
        )
        this.messageStore.appendAbortToolResultBlock(txn, block, {
          turnId,
        })
      }
    })
    return abortedCount
  }
}

function mapReasonForBidi(
  input: Extract<CleanupInput, { kind: "bidi-closed" | "bidi-superseded" }>
): CancelReason {
  if (input.kind === "bidi-superseded") {
    // A superseded BiDi is structurally a bidi-close from the
    // lifecycle's perspective — there is no parent turn to anchor a
    // `superseded` cancel against, and the new BiDi already has its
    // own umbrella. Use bidi-closed so cancelTurn cascades correctly.
    return { kind: "bidi-closed" }
  }
  return { kind: "bidi-closed" }
}

function mapAbortReasonForBidi(
  kind: "bidi-closed" | "bidi-superseded"
): AbortReason {
  return kind === "bidi-superseded" ? "turn_superseded" : "bidi_teardown"
}
