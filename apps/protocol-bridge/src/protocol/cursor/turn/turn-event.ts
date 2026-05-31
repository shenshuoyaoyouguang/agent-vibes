import type {
  CancelReason,
  TurnId,
  TurnKind,
  TurnPhase,
  TurnTerminalResult,
} from "./turn.types"

/**
 * TurnEvent — append-only audit record for a single turn's life.
 *
 * Every state change worth knowing about lands here:
 *   - lifecycle transitions: spawned, phase-changed, cancelled, terminal
 *   - model output decisions: model-yield (text / tool_batch / thinking_only / empty / truncated / transport_failed)
 *   - tool batch dispatch / settlement
 *   - budget / nudge decisions: budget-decision, thinking-only-recovery
 *
 * Phase is *derived* from the audit log (latest `phase-changed` event),
 * not stored as a scalar — that was the source of the
 * `lastTransitionReason` cross-BiDi pollution we are eliminating.
 *
 * The discriminated-union shape lets observers exhaustively switch on
 * `kind`; new event kinds must be added here so consumers can be
 * type-checked into handling them.
 */
export type TurnEvent =
  | TurnSpawnedEvent
  | TurnPhaseChangedEvent
  | TurnModelYieldEvent
  | TurnToolBatchDispatchedEvent
  | TurnToolResultReceivedEvent
  | TurnThinkingOnlyRecoveryEvent
  | TurnCancelledEvent
  | TurnTerminalEvent

export interface TurnSpawnedEvent {
  kind: "spawned"
  ts: number
  parent?: TurnId
  turnKind: TurnKind
  runner: string
}

export interface TurnPhaseChangedEvent {
  kind: "phase-changed"
  ts: number
  phase: TurnPhase
  detail?: string
}

/**
 * The model produced an end-of-turn outcome at message_stop. Carries
 * the `ModelTurnYield` ADT (defined in step 6 / model-turn-yield.ts);
 * for now the payload is opaque so step 4 stays decoupled from the
 * yield ADT.
 */
export interface TurnModelYieldEvent {
  kind: "model-yield"
  ts: number
  yield: { kind: string; [key: string]: unknown }
}

export interface TurnToolBatchDispatchedEvent {
  kind: "tool-batch-dispatched"
  ts: number
  toolCallIds: string[]
}

export interface TurnToolResultReceivedEvent {
  kind: "tool-result-received"
  ts: number
  toolCallId: string
  isError: boolean
}

export interface TurnThinkingOnlyRecoveryEvent {
  kind: "thinking-only-recovery"
  ts: number
  /** 1-based round counter (caps at MAX_THINKING_ONLY_RECOVERIES = 1). */
  round: number
}

export interface TurnCancelledEvent {
  kind: "cancelled"
  ts: number
  reason: CancelReason
}

export interface TurnTerminalEvent {
  kind: "terminal"
  ts: number
  result: TurnTerminalResult
}

/**
 * Payload of a phase-changed event with `phase: "completed"`. The
 * supervisor synthesises one when a runner exits without explicitly
 * recording the completion.
 */
export interface TurnTransitionInput {
  phase: TurnPhase
  detail?: string
}

/**
 * Helper type used by consumers that only care about `phase-changed`
 * derivations of the current turn phase.
 */
export type TurnEventOfKind<K extends TurnEvent["kind"]> = Extract<
  TurnEvent,
  { kind: K }
>

/**
 * The turn-local runtime state owned by `TurnLifecycle`. Lives only as
 * long as the turn record itself; never persisted to SQLite. This is
 * the deliberate replacement for the old SessionTopLevelAgentTurnState
 * fields that polluted the cursor_sessions blob.
 */
export interface TurnRuntime {
  /** Step 6: thinking-only recovery counter, capped at 1. */
  thinkingOnlyRecoveryGuard: number
  /** Max-output-tokens recovery attempt, capped at MAX_OUTPUT_TOKENS_RECOVERY_LIMIT. */
  maxOutputTokensRecoveryAttempt: number
}

export function createTurnRuntime(): TurnRuntime {
  return {
    thinkingOnlyRecoveryGuard: 0,
    maxOutputTokensRecoveryAttempt: 0,
  }
}

/**
 * Project the latest `phase-changed` event from an audit log to derive
 * the turn's current phase. Returns `undefined` for an empty log.
 */
export function derivePhase(
  events: readonly TurnEvent[]
): TurnPhase | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.kind === "phase-changed") {
      return event.phase
    }
  }
  return undefined
}

/**
 * Project the most recent thinking-only recovery round from an audit
 * log; returns 0 if none.
 */
export function deriveThinkingOnlyRecoveries(
  events: readonly TurnEvent[]
): number {
  let max = 0
  for (const event of events) {
    if (event.kind === "thinking-only-recovery" && event.round > max) {
      max = event.round
    }
  }
  return max
}

/**
 * Convenience: count tool-batch-dispatched events.
 */
export function countToolBatchDispatches(events: readonly TurnEvent[]): number {
  let n = 0
  for (const event of events) {
    if (event.kind === "tool-batch-dispatched") n += 1
  }
  return n
}
