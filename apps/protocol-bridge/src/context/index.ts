/**
 * Context Module Exports
 *
 * Provides conversation history management, projection, and compaction.
 */

// Types
export * from "./types"

// Context services
export {
  resolveAutoCompactTokenLimit,
  type ContextAutoCompactInput,
} from "./context-auto-compact-policy"
export {
  CodexContextAdapterService,
  CODEX_SUMMARIZATION_PROMPT,
  CODEX_SUMMARY_PREFIX,
} from "./codex-context-adapter.service"
export type {
  CodexCompactReferenceInput,
  CodexRemoteCompactProvider,
  CodexRemoteCompactRequest,
  CodexRemoteCompactResult,
} from "./codex-context-adapter.service"
export { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
export type {
  ContextAttachmentSnapshot,
  SessionTodoAttachmentLike,
} from "./context-attachment-builder.service"
export { ContextCompactRunnerService } from "./context-compact-runner.service"
export type {
  ContextCompactRunnerHookProvider,
  ContextCompactRunnerSummaryProvider,
  ContextCompactRunnerSummaryRequest,
  ContextCompactRunnerSummaryResult,
} from "./context-compact-runner.service"
export {
  ContextCompactionService,
  ContextProjectionBudgetExceededError,
} from "./context-compaction.service"
export type {
  ContextCompactionCandidate,
  ContextCompactionResult,
} from "./context-compaction.service"
export {
  ContextHookExecutorService,
  type PreCompactHookPayload,
} from "./context-hook-executor.service"
export { ContextManagerService } from "./context-manager.service"
export type {
  ReactiveRecoveryOutcome,
  ReactiveRecoveryRequest,
} from "./context-manager.service"
export { ContextNativeCacheEditService } from "./context-native-cache-edit.service"
export type { ContextNativeCacheEditApplyResult } from "./context-native-cache-edit.service"
export { ContextNativeManagementService } from "./context-native-management.service"
export type {
  AnthropicNativeContextManagementInput,
  ContextNativeEditStrategy,
  ContextNativeManagementConfig,
} from "./context-native-management.service"
export { ContextProjectionService } from "./context-projection.service"
export { ContextRequestPlannerService } from "./context-request-planner.service"
export type {
  ContextProjectionOptions,
  ContextProjectionBudget,
  ContextRequestBudget,
  ContextRequestBudgetInput,
} from "./context-request-planner.service"
export { ContextTelemetryService } from "./context-telemetry.service"
export type {
  ContextTelemetryEvent,
  ContextTelemetryEventDetail,
} from "./context-telemetry.service"
export {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  createAttachmentRecord,
  createHookResultRecord,
  createMicrocompactBoundaryRecord,
  createSnipBoundaryRecord,
  deriveCompactionHistoryFromTranscript,
  findLastCompactBoundaryIndex,
  getActiveCompactCommitFromTranscript,
  getRecordsAfterCompactBoundary,
  isAttachmentRecord,
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isHookResultRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
  projectSnippedView,
  stripInternalContextEvents,
} from "./context-transcript-events"
export { ContextUsageLedgerService } from "./context-usage-ledger.service"
export { SessionMemoryCompactionService } from "./session-memory-compaction.service"
export type { SessionMemoryBuildOptions } from "./session-memory-compaction.service"
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
export { ToolResultStorageService } from "./tool-result-storage.service"
export type {
  ToolResultStorageReadChunkResult,
  ToolResultStorageWriteResult,
} from "./tool-result-storage.service"

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

// Sub-agent session-memory formatting (shared by streaming service
// and compaction-time extraction so the two entry shapes stay aligned)
export {
  buildSubAgentMemorySourceCompactionId,
  formatSubAgentMemoryBody,
  formatSubAgentMemoryEntry,
} from "./sub-agent-memory-formatter"
export type {
  SubAgentMemoryFormatInput,
  SubAgentMemoryFormatOptions,
} from "./sub-agent-memory-formatter"

// Modules
export { ContextModule } from "./context.module"
