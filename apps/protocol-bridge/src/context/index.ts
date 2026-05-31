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
export { CompactWarningStateService } from "./compact-warning-state.service"
export { CompactWarningHookService } from "./compact-warning-hook.service"
export { PostCompactCleanupService } from "./post-compact-cleanup.service"
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
export { ContextCollapseService } from "./context-collapse.service"
export type {
  ContextCollapseApplyInput,
  ContextCollapseProjectionResult,
} from "./context-collapse.service"
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
  ContextCompactionPlan,
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
export { ContextNativeManagementService } from "./context-native-management.service"
export type {
  AnthropicNativeContextManagementInput,
  ContextNativeEditStrategy,
  ContextNativeManagementConfig,
} from "./context-native-management.service"
export {
  ContextPipeline,
  ContextPipelineService,
} from "./context-pipeline.service"
export { ContextProjectionService } from "./context-projection.service"
export { ContextRequestPlannerService } from "./context-request-planner.service"
export { ReasoningMemoryService } from "./reasoning-memory.service"
export type {
  ReasoningRecord,
  ReasoningCapture,
  ReasoningPreamble,
  ReasoningPreambleBudget,
} from "./reasoning-memory.service"
export type {
  ContextProjectionOptions,
  ContextProjectionBudget,
  ContextRequestBudget,
  ContextRequestBudgetDecision,
  ContextRequestBudgetInput,
  ContextRequestBudgetSelectionSource,
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
  createContextCollapseSummaryRecord,
  createMicrocompactBoundaryRecord,
  createSnipBoundaryRecord,
  deriveCompactionHistoryFromTranscript,
  findLastCompactBoundaryIndex,
  getActiveCompactCommitFromTranscript,
  getRecordsAfterCompactBoundary,
  isAttachmentRecord,
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isContextCollapseSummaryRecord,
  isHookResultRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
  projectSnippedView,
  renderContextCollapseSummary,
  stripInternalContextEvents,
} from "./context-transcript-events"
export { ContextUsageLedgerService } from "./context-usage-ledger.service"
export { SessionMemoryCompactionService } from "./session-memory-compaction.service"
export type { SessionMemoryBuildOptions } from "./session-memory-compaction.service"
export { TokenCounterService } from "./token-counter.service"
export { ToolIntegrityService } from "./tool-integrity.service"
export type { EnforceToolProtocolOptions } from "./tool-integrity.service"
export { ToolResultStorageService } from "./tool-result-storage.service"
export type {
  ToolResultStorageProcessInput,
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
