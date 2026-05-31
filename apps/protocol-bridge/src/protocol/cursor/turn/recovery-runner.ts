import { Logger } from "@nestjs/common"
import type { TurnHandle } from "./turn-handle"
import type { TurnRunner } from "./turn-runner"
import type { TurnTerminalResult } from "./turn.types"

/**
 * What the recovery turn knows. Captured at turn-spawn time by the
 * supervisor's reattach path; the runner emits one or more frames
 * that bring the IDE's UI into a sane state and then terminates.
 */
export interface RecoveryFrame {
  /**
   * The encoded protocol frame the IDE expects. The integration
   * layer constructs this — the runner does not know about the
   * cursor protocol shape.
   */
  readonly buffer: Buffer
  /**
   * Optional log line emitted alongside the frame, for trace
   * visibility.
   */
  readonly trace?: string
}

/**
 * Recovery turn runner. Owns its own outbound (so it can write
 * synthetic frames to the IDE) but never opens a backend HTTP call.
 * Used for:
 *
 *  - "interrupted by user" synthetic message after a cancel
 *  - "previous tool call lost on reconnect" notice when the IDE
 *    reattaches after a crash
 *  - "compaction in progress" UI announcement when a long-running
 *    compaction is the first thing a reconnected client should know
 *    about
 *
 * Recovery turns are short-lived and idempotent: emitting twice is
 * a programming bug but does not corrupt state, because each frame
 * is a discrete UI update with its own toolCallId or messageId.
 */
export class RecoveryRunner implements TurnRunner {
  private readonly logger = new Logger(RecoveryRunner.name)
  readonly displayName: string
  private readonly frames: ReadonlyArray<RecoveryFrame>

  constructor(args: {
    reasonTag: string
    frames: ReadonlyArray<RecoveryFrame>
  }) {
    this.displayName = `recovery:${args.reasonTag}`
    this.frames = args.frames
  }

  async run(handle: TurnHandle): Promise<TurnTerminalResult> {
    try {
      const ob = handle.outbound
      if (!ob) {
        // Should not happen: the supervisor only spawns recovery
        // turns under a real outbound.
        return {
          status: "failed",
          error: new Error("recovery turn missing outbound"),
        }
      }
      handle.recordPhase("streaming-content")
      for (const frame of this.frames) {
        if (handle.signal.aborted) break
        if (frame.trace) this.logger.debug(frame.trace)
        ob.write(handle.turnId, frame.buffer)
      }
      handle.recordPhase("terminal")
      return {
        status: "completed",
        summary: `recovery emitted ${this.frames.length} frames`,
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      const reason = handle.cancellationReason()
      if (reason) return { status: "cancelled", reason }
      return { status: "failed", error: e }
    }
  }
}
