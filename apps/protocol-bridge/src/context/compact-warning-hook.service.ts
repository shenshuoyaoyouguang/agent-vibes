import { Injectable } from "@nestjs/common"
import { CompactWarningStateService } from "./compact-warning-state.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextConversationState } from "./types"

/**
 * Cooldown window between consecutive `compaction.warning_imminent`
 * telemetry emissions for a single session. Suppression already covers
 * the post-compaction silent window; this guard prevents tight loops
 * (rapid threshold flapping near the cutoff) from spamming telemetry.
 */
const WARNING_COOLDOWN_MS = 30_000

/**
 * Threshold ratio below which we never emit. Mirrors cc's TokenWarning
 * UI which lights up at the 80% mark of the auto-compact limit. Above
 * 100% the system has already entered hard-failure territory and the
 * compaction itself is the right signal.
 */
const WARNING_LOW_RATIO = 0.8
const WARNING_HIGH_RATIO = 1.0

/**
 * Predictive "compaction imminent" hook — bridge port of cc's
 * `compactWarningHook`. cc surfaces the signal through a React hook
 * (useSyncExternalStore) so the TokenWarning component re-renders when
 * suppress/clear flips. Bridge is server-side and the equivalent
 * surface is a `compaction.warning_imminent` telemetry event consumed
 * by Diagnostics tooling. Per the implementation plan we deliberately
 * do NOT mint a new Cursor protocol frame — the warning lives in
 * telemetry until a UI consumer asks for it.
 */
@Injectable()
export class CompactWarningHookService {
  constructor(
    private readonly telemetry: ContextTelemetryService,
    private readonly warningState: CompactWarningStateService
  ) {}

  /**
   * Evaluate the current token estimate against the auto-compact limit
   * and emit telemetry when the ratio enters the warning band. Caller
   * is expected to invoke this BEFORE deciding whether to compact, so
   * the warning fires once per round just before the actual compaction.
   *
   * No-ops:
   *   - suppression flag set → caller already compacted this round
   *   - ratio < 0.8 → still healthy
   *   - ratio ≥ 1.0 → over-budget; the compaction telemetry is the
   *     correct signal
   *   - cooldown window not elapsed → debounce flapping
   */
  maybeEmit(input: {
    state: ContextConversationState
    sessionId?: string
    estimatedTokens: number
    autoCompactLimit?: number
  }): void {
    if (!input.autoCompactLimit || input.autoCompactLimit <= 0) return
    if (this.warningState.isSuppressed(input.state)) return
    const ratio = input.estimatedTokens / input.autoCompactLimit
    if (ratio < WARNING_LOW_RATIO || ratio >= WARNING_HIGH_RATIO) return

    const lastEmittedEpoch = input.state.compactWarningState?.lastEmittedEpoch
    if (
      lastEmittedEpoch !== undefined &&
      Date.now() - lastEmittedEpoch < WARNING_COOLDOWN_MS
    ) {
      return
    }

    this.telemetry.recordEvent({
      event: "compaction.warning_imminent",
      scope: input.sessionId ?? "global",
      metadata: {
        ratio: Math.round(ratio * 1000) / 1000,
        estimatedTokens: input.estimatedTokens,
        limit: input.autoCompactLimit,
      },
    })

    this.warningState.markEmitted(input.state)
    // After emission we suppress until the next round explicitly
    // clears. Mirrors cc behavior — once the user is told, don't keep
    // re-warning within the same round.
    this.warningState.suppressCompactWarning(input.state)
  }
}
