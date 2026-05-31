/**
 * Branded primitive identifiers for the turn subsystem. Branding is
 * pure compile-time — at runtime these are still strings — but the
 * brand prevents accidental cross-wiring of TurnIds, ConversationIds,
 * and StreamIds at call sites.
 */

declare const __turnIdBrand: unique symbol
declare const __conversationIdBrand: unique symbol
declare const __streamIdBrand: unique symbol
declare const __bidiIdBrand: unique symbol

export type TurnId = string & { readonly [__turnIdBrand]: "TurnId" }
export type ConversationId = string & {
  readonly [__conversationIdBrand]: "ConversationId"
}
export type StreamId = string & { readonly [__streamIdBrand]: "StreamId" }
export type BidiId = string & { readonly [__bidiIdBrand]: "BidiId" }

/**
 * What kind of work the turn represents. Drives outbound ownership,
 * abort propagation rules, and transcript-staging semantics.
 *
 * - `user`: top-level turn started from an inbound user message; owns
 *   its own outbound, has no parent.
 * - `foreground-subagent`: spawned by a `task` tool call without
 *   `run_in_background`; borrows the parent's outbound, lives in the
 *   parent's abort scope.
 * - `synthetic-compaction`: an LLM call the bridge originates to
 *   summarize old transcript. Has no outbound. Skips the normal
 *   prepare-then-compact pipeline so it does not recurse.
 * - `recovery`: short-lived turn that emits a synthetic recovery
 *   frame after a crash or interruption. Owns its own outbound but
 *   never opens a backend HTTP call.
 */
export type TurnKind =
  | "user"
  | "foreground-subagent"
  | "synthetic-compaction"
  | "recovery"

export const TurnId = {
  of(raw: string): TurnId {
    return raw as TurnId
  },
  generate(prefix: TurnKind): TurnId {
    return `${prefix}:${crypto.randomUUID()}` as TurnId
  },
}
export const ConversationId = {
  of(raw: string): ConversationId {
    return raw as ConversationId
  },
  /**
   * Build the provisional ConversationId used while a BiDi attachment
   * is still pre-attach: the umbrella turn must own the outbound
   * writer the moment the HTTP/2 stream opens, but the real
   * `conversation_id` only arrives on the first inbound message. The
   * sentinel form is `pending:<bidiId>`, anchored to the BiDi's own
   * UUID so two concurrent attachments never collide.
   *
   * Treat the result as opaque — only `isProvisional` is allowed to
   * inspect the literal shape. Callers that need the underlying
   * bidiId should keep their own reference.
   */
  provisional(bidiId: BidiId): ConversationId {
    return `pending:${bidiId}` as ConversationId
  },
  /**
   * True when the ConversationId is the BiDi-attach sentinel produced
   * by `provisional()`. The persistence layer must NOT write
   * `turn_events` rows under such an id: those rows FK to a
   * `sessions(conversation_id)` that, by definition, does not exist
   * (and never will — the umbrella's turn audit log is BiDi-scoped,
   * not conversation-scoped). The real chat-parent / foreground
   * sub-agent / recovery turns spawn under the real cid and persist
   * normally.
   */
  isProvisional(id: ConversationId | string): boolean {
    return typeof id === "string" && id.startsWith("pending:")
  },
}
export const StreamId = {
  of(raw: string): StreamId {
    return raw as StreamId
  },
  provisional(bidiId: BidiId): StreamId {
    return `pending:${bidiId}` as StreamId
  },
}
export const BidiId = {
  of(raw: string): BidiId {
    return raw as BidiId
  },
}

/**
 * Where in the standard parent-turn fsm the turn currently sits. Each
 * transition is monotonic forwards; `terminal` is the only sink.
 *
 *   preparing-context → calling-backend → streaming-content
 *     → dispatching-tools → awaiting-tool-results → committing → terminal
 *
 * Subagent and synthetic turns short-circuit some phases (e.g.
 * synthetic-compaction never enters dispatching-tools) but the values
 * they pass through are still members of this enum so observers can
 * use a single switch.
 */
export type TurnPhase =
  | "preparing-context"
  | "calling-backend"
  | "streaming-content"
  | "dispatching-tools"
  | "awaiting-tool-results"
  | "committing"
  | "terminal"

/**
 * The reason a Turn was cancelled. Drives downstream behaviour:
 * `user-cancel` synthesizes abort tool_results and persists
 * restartRecovery; `superseded` waits the foreground grace period
 * and only then aborts; `bidi-closed` retains pending tool calls
 * intact so a future resumeAction can pick them up.
 */
export type CancelReason =
  | { kind: "user-cancel"; reason: string }
  | { kind: "superseded"; by: TurnId }
  | { kind: "bidi-closed" }
  | { kind: "parent-cancelled"; ancestor: TurnId }
  | { kind: "shutdown" }

/**
 * Final result of a Turn. The shape is deliberately discriminated so
 * `awaitTerminal()` consumers cannot forget to handle the cancelled
 * branch — TypeScript will refuse to narrow `result.summary` until
 * they exclude the cancellation cases.
 */
export type TurnTerminalResult =
  | { status: "completed"; summary: string }
  | { status: "cancelled"; reason: CancelReason }
  | { status: "failed"; error: Error }
