import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import type { CursorConnectStreamService } from "../cursor-connect-stream.service"
import { SessionLifecycleService } from "./session-lifecycle.service"
import { SessionStreamService } from "./session-stream.service"

/**
 * Periodically scans all in-memory sessions for pending tool calls
 * and interaction queries whose wall-clock `deadline` has passed,
 * and expires them through the appropriate
 * `CursorConnectStreamService` public method:
 *
 *   - pending tool call → `expirePendingToolCall(...)` (synthetic
 *     error tool_result so the agent loop unwinds)
 *   - pending IQ kind="async_ask" → `expireAsyncAskQuestion(..., reason="bridge_expired")`
 *     (synthesizes the IDE's queued-followup completion frame so the
 *     "1 Queued" badge clears)
 *   - other pending IQ kinds → reject the promise with TimeoutError
 *
 * The sweeper exists because the bridge maintains state (pending
 * tool calls, queued async asks) that has no natural cleanup signal
 * from the IDE side after EOF / supersede / a forgotten queued
 * question. Without it, those entries leak forever and the
 * conversation never returns to idle for cleanup.
 *
 * Wiring: `CursorConnectStreamService` is injected lazily via a
 * setter to avoid the DI cycle (the stream service depends on
 * sessionManager, which is injected here too). The cursor module's
 * `onApplicationBootstrap` calls `setStreamService` before the first
 * sweep tick.
 */
@Injectable()
export class PendingDeadlineSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingDeadlineSweeper.name)
  private readonly SWEEP_INTERVAL_MS = 5_000
  private interval: ReturnType<typeof setInterval> | undefined
  private streamService: CursorConnectStreamService | undefined
  private sweepInProgress = false

  constructor(
    private readonly sessionManager: SessionLifecycleService,
    private readonly sessionStream: SessionStreamService
  ) {}

  /**
   * Setter injection to break the
   *   SessionLifecycleService → PendingDeadlineSweeper → CursorConnectStreamService → SessionLifecycleService
   * cycle. Called from `CursorModule.onApplicationBootstrap`.
   */
  setStreamService(streamService: CursorConnectStreamService): void {
    this.streamService = streamService
  }

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.sweep()
    }, this.SWEEP_INTERVAL_MS)
    if (typeof this.interval.unref === "function") {
      // Don't keep the process alive just for this sweeper.
      this.interval.unref()
    }
    this.logger.log(
      `PendingDeadlineSweeper started (interval=${this.SWEEP_INTERVAL_MS}ms)`
    )
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }

  /**
   * Public for tests — production callers go through the timer.
   */
  async sweep(): Promise<void> {
    if (this.sweepInProgress) {
      // Sweep tick took longer than interval. Skip rather than pile
      // up — next tick will pick up anything new.
      return
    }
    this.sweepInProgress = true
    try {
      const stream = this.streamService
      if (!stream) {
        // Bootstrap hasn't completed yet. Nothing to do until the
        // module wires the cycle.
        return
      }

      const overdue = this.sessionStream.listOverdueDeadlines()
      if (overdue.tools.length === 0 && overdue.interactionQueries.length === 0)
        return

      // Expire tools first so any agent already inside the
      // user-message turn unwinds before we walk the IQ list.
      for (const t of overdue.tools) {
        try {
          await stream.expirePendingToolCall(
            t.conversationId,
            t.toolCallId,
            `deadline exceeded (${new Date(t.deadline).toISOString()})`
          )
        } catch (err) {
          this.logger.error(
            `expirePendingToolCall threw for tool=${t.toolName} ` +
              `toolCallId=${t.toolCallId} on ${t.conversationId}: ${(err as Error).message}`
          )
        }
      }

      for (const iq of overdue.interactionQueries) {
        try {
          if (iq.kind === "async_ask") {
            stream.expireAsyncAskQuestion(
              iq.conversationId,
              iq.queryId,
              "bridge_expired"
            )
          } else {
            // Generic IQ timeout — reject the promise with a
            // TimeoutError. Caller decides how to render it.
            this.sessionStream.resolveInteractionQuery(
              iq.conversationId,
              iq.queryId,
              {
                approved: false,
                resultCase: "error",
                rawResponse: { error: "deadline_exceeded" },
              }
            )
          }
        } catch (err) {
          this.logger.error(
            `expire IQ threw for queryId=${iq.queryId} kind=${iq.kind ?? "(none)"} ` +
              `on ${iq.conversationId}: ${(err as Error).message}`
          )
        }
      }

      this.logger.warn(
        `Sweeper expired ${overdue.tools.length} tool(s) + ` +
          `${overdue.interactionQueries.length} IQ(s) across in-memory sessions`
      )
    } finally {
      this.sweepInProgress = false
    }
  }
}
