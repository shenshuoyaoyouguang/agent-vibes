import {
  MAX_THINKING_ONLY_RECOVERIES,
  type ModelTurnYield,
} from "./model-turn-yield"

export type TurnCompletionMode = "initial" | "continuation"

export type TurnPreFinalizeDecision =
  | { action: "recover_max_output" }
  | { action: "recover_thinking_only"; nextRound: number }
  | {
      action: "finalize"
      dropPersistedTurnAssistantMessages: boolean
      skipDurableAssistantRecord: boolean
      reason: "normal" | "thinking_only_exhausted"
    }

export interface TurnPreFinalizeInput {
  mode: TurnCompletionMode
  modelYield: ModelTurnYield
  isMaxOutputStopReason: boolean
  thinkingOnlyRecoveryRound: number
  maxThinkingOnlyRecoveries?: number
}

/**
 * Single pre-finalize state machine for Cursor agent turns.
 *
 * Contract:
 *   - This function is called only after the model has produced a
 *     no-tool `message_stop`.
 *   - It decides whether the bridge may emit `agent_turn_ended`, or
 *     must first perform an in-stream recovery/continuation.
 *   - Callers must execute every non-finalize action before sending
 *     `agent_turn_ended`; no bridge-side generation is allowed after
 *     that frame.
 */
export function decideTurnPreFinalize(
  input: TurnPreFinalizeInput
): TurnPreFinalizeDecision {
  if (input.isMaxOutputStopReason || input.modelYield.kind === "truncated") {
    return { action: "recover_max_output" }
  }

  if (input.modelYield.kind === "thinking_only") {
    const maxRecoveries =
      input.maxThinkingOnlyRecoveries ?? MAX_THINKING_ONLY_RECOVERIES
    if (input.thinkingOnlyRecoveryRound < maxRecoveries) {
      return {
        action: "recover_thinking_only",
        nextRound: input.thinkingOnlyRecoveryRound + 1,
      }
    }
    return {
      action: "finalize",
      dropPersistedTurnAssistantMessages: true,
      skipDurableAssistantRecord: true,
      reason: "thinking_only_exhausted",
    }
  }

  return {
    action: "finalize",
    dropPersistedTurnAssistantMessages: false,
    skipDurableAssistantRecord: false,
    reason: "normal",
  }
}
