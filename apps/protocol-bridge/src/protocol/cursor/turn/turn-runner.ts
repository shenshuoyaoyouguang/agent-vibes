import type { TurnHandle } from "./turn-handle"
import type { TurnTerminalResult } from "./turn.types"

/**
 * The single contract every turn-shape implements. A runner's only
 * job is to: read inputs from its constructor, observe `handle.signal`
 * for cancellation, emit frames via `handle.outbound!.write(...)`, and
 * resolve with a terminal result.
 *
 * `run()` MUST resolve. It must NOT throw — runners that hit
 * exceptions translate them to `{ status: "failed", error }` and
 * return normally. The supervisor treats a thrown promise as a bug
 * and logs it loudly; behaviourally it is also coerced to `failed`.
 *
 * `run()` MUST NOT push or pop the writer stack itself. The
 * supervisor wraps the call in `withWriter(...)` so symmetry is
 * preserved across throws.
 */
export interface TurnRunner {
  /**
   * Diagnostic name. Shown in logs and traces. Convention:
   * `<turn-kind>:<purpose>` e.g. `user:chat`, `synthetic-compaction:summary`.
   */
  readonly displayName: string

  /**
   * Execute the turn against the supplied handle. Resolves with the
   * terminal result. The supervisor is responsible for invoking
   * `handle.reportTerminal()` if the runner did not already.
   */
  run(handle: TurnHandle): Promise<TurnTerminalResult>
}
