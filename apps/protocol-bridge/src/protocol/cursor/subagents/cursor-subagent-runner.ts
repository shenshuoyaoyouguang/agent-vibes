import { Logger } from "@nestjs/common"
import type { TurnHandle } from "../turn/turn-handle"
import type { TurnRunner } from "../turn/turn-runner"
import type { TurnTerminalResult } from "../turn/turn.types"

/**
 * Foreground sub-agent turn runner: a bridge that runs the
 * cursor-side `executeSubAgentTask` body inside a child turn so the
 * supervisor manages its lifecycle.
 *
 * This is intentionally NOT shaped like the generic
 * `ForegroundSubagentRunner<PreparedContext, BackendEvent>` 5-hook
 * contract. The cursor sub-agent body is a single 982-line async
 * function that interleaves prepare / call / event / dispatch /
 * finalize through helpers on `CursorConnectStreamService`. Pulling
 * those apart is a separate refactor (see roadmap). For now we just
 * need the supervisor to KNOW about the sub-agent so:
 *
 *   - cancelling the parent cancels the sub-agent (via
 *     `handle.signal` linked into the cursor abort bridge)
 *   - the sub-agent's frames go through the parent's outbound under
 *     its own writer-stack entry
 *   - sub-agent terminal status is observable (no orphan promises)
 *
 * The `body()` callback is the existing `executeSubAgentTask` /
 * `spawnBackgroundSubAgent` invocation. It already observes
 * `session.currentTurnAbortController.signal`; the supervisor's
 * cancel flows there via the bridge installed in
 * `CursorConnectStreamService`.
 */
export class CursorSubAgentRunner implements TurnRunner {
  readonly displayName: string
  private readonly logger = new Logger(CursorSubAgentRunner.name)
  private readonly body: (handle: TurnHandle) => Promise<void>

  constructor(args: {
    subagentName: string
    body: (handle: TurnHandle) => Promise<void>
  }) {
    this.displayName = `foreground-subagent:${args.subagentName}`
    this.body = args.body
  }

  async run(handle: TurnHandle): Promise<TurnTerminalResult> {
    try {
      await this.body(handle)
      // If cancelled mid-body, the cursor abort bridge already raised
      // through the body's await chain — caught below.
      return { status: "completed", summary: "" }
    } catch (err) {
      const reason = handle.cancellationReason()
      if (reason) {
        return { status: "cancelled", reason }
      }
      const e = err instanceof Error ? err : new Error(String(err))
      this.logger.error(
        `sub-agent body error turn=${handle.turnId} name=${this.displayName}: ${e.message}`
      )
      return { status: "failed", error: e }
    }
  }
}
