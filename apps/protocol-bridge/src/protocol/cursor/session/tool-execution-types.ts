export type ToolExecutionOwner = "bridge" | "client"

export type ToolExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "awaitingClientResult"
  | "aborted"
  | "discarded"

export type ToolExecutionRecoveryReason =
  | "input_eof"
  | "retry"
  | "stream_fallback"
  | "abort"
  | "session_restore"

export interface PendingToolExecutionState {
  executionOwner?: ToolExecutionOwner
  executionStatus?: ToolExecutionStatus
  executionRecoveryReason?: ToolExecutionRecoveryReason
  executionOrder?: number
}
