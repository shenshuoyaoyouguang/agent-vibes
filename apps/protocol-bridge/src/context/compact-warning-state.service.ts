import { Injectable } from "@nestjs/common"
import { ContextCompactWarningState, ContextConversationState } from "./types"

/**
 * Per-session boolean store mirroring cc's
 * `services/compact/compactWarningState.ts`. The state controls whether
 * the predictive "compaction imminent" hook emits telemetry — after a
 * successful microcompact / cache_edits emission / boundary compaction
 * we suppress the warning for one round to avoid double-notifying users
 * about a problem we just fixed.
 *
 * Lifecycle (matches cc):
 *   - `clearCompactWarningSuppression(state)` is called on the next
 *     `ensureWithinBudget` entry so a fresh round can re-evaluate the
 *     threshold.
 *   - `suppressCompactWarning(state)` is called on every successful
 *     compaction event so subsequent threshold checks within the same
 *     round are silent.
 *
 * State is stored on `ContextConversationState.compactWarningState` so
 * it lives with the session — bridge is multi-tenant and a global
 * boolean (cc's CLI shape) would mix sessions.
 */
@Injectable()
export class CompactWarningStateService {
  isSuppressed(state: ContextConversationState): boolean {
    return state.compactWarningState?.suppressed === true
  }

  suppressCompactWarning(state: ContextConversationState): void {
    const next = this.ensureState(state)
    next.suppressed = true
  }

  clearCompactWarningSuppression(state: ContextConversationState): void {
    const next = this.ensureState(state)
    next.suppressed = false
  }

  /** Called by the hook after each successful emission. */
  markEmitted(state: ContextConversationState): void {
    const next = this.ensureState(state)
    next.lastEmittedEpoch = Date.now()
  }

  private ensureState(
    state: ContextConversationState
  ): ContextCompactWarningState {
    if (!state.compactWarningState) {
      state.compactWarningState = { suppressed: false }
    }
    return state.compactWarningState
  }
}
