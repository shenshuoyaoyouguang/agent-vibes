/**
 * Type contracts shared by every BiDi-layer module. Kept separate from
 * implementation so types can be imported without dragging in nest DI
 * decorations or runtime classes.
 */

import type { TurnId } from "../turn/turn.types"

/**
 * Why a TurnOutbound transitioned from open → sealing → sealed. The
 * discriminator drives the diagnostic frame the controller can choose to
 * emit (or suppress) before tearing the bidi connection down.
 */
export type SealReason =
  | { kind: "bidi-closed" }
  | { kind: "superseded-by"; supersedingStreamId: string }
  | { kind: "turn-terminal" }
  | { kind: "shutdown" }

/**
 * A single BiDi attachment. One BidiStreamController.handle() invocation
 * owns exactly one of these for its lifetime.
 */
export interface BidiAttachment {
  readonly bidiId: string
  readonly conversationId: string
  /**
   * The streamId in force at the moment the BiDi attached. Subsequent
   * `rotateStreamId` calls within the same BiDi do not change this; it is
   * the protocol-layer identifier exposed in `streamAbortBinding`.
   */
  readonly streamId: string
  readonly attachedAt: Date
}

/**
 * The single source of truth for "who is allowed to write a frame to the
 * BiDi outbound right now". Maintained as an active-writer set so multiple
 * concurrent sub-agents (e.g. parallel task tool fan-out) can all emit
 * frames into the same outbound — frames interleave by wall-clock arrival
 * order. The legacy LIFO-stack semantics are gone; see TurnOutbound for
 * details.
 */
export interface TurnOutboundWriterStackSnapshot {
  readonly turns: readonly TurnId[]
  readonly state: "open" | "sealing" | "sealed"
  readonly sealReason?: SealReason
}
