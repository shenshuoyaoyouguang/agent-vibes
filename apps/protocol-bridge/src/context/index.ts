/**
 * Context Module Exports
 *
 * Provides conversation history management, projection, and compaction.
 */

// Types
export * from "./types"

// Context services
export { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
export type {
  ContextAttachmentSnapshot,
  SessionTodoAttachmentLike,
} from "./context-attachment-builder.service"
export { ContextCompactionService } from "./context-compaction.service"
export type { ContextCompactionResult } from "./context-compaction.service"
export {
  ContextHookExecutorService,
  type PreCompactHookPayload,
} from "./context-hook-executor.service"
export { ContextManagerService } from "./context-manager.service"
export type {
  ReactiveRecoveryOutcome,
  ReactiveRecoveryRequest,
} from "./context-manager.service"
export { ContextProjectionService } from "./context-projection.service"
export { ContextSummaryService } from "./context-summary.service"
export { ContextTelemetryService } from "./context-telemetry.service"
export type {
  ContextTelemetryEvent,
  ContextTelemetryEventDetail,
} from "./context-telemetry.service"
export { ContextUsageLedgerService } from "./context-usage-ledger.service"
export { TokenCounterService } from "./token-counter.service"
export { ToolIntegrityService } from "./tool-integrity.service"
export { assertIntegrity, enforceToolProtocol } from "./tool-protocol-integrity"
export type {
  IntegrityViolation,
  RepairResult,
} from "./tool-protocol-integrity"
export { normalizeToolProtocolMessages } from "./tool-protocol-normalizer"
export type { ToolProtocolNormalizationResult } from "./tool-protocol-normalizer"
export { ToolResultCompactionService } from "./tool-result-compaction.service"

// Round-aware truncation helpers
export {
  findRoundAlignedTruncationIndex,
  groupMessagesByApiRound,
  groupTranscriptRecordsByApiRound,
} from "./api-round-grouping"

// Attachment fingerprinting (shared by compaction planner and usage ledger)
export {
  fingerprintAttachments,
  fingerprintProjectedAttachments,
} from "./attachment-fingerprint"

// Backend-agnostic prompt-too-long error inspection
export { detectPromptTooLong } from "./prompt-too-long"
export type { PromptTooLongDetection } from "./prompt-too-long"

// Modules
export { ContextModule } from "./context.module"
