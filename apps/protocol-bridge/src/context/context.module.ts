import { Module } from "@nestjs/common"
import { CompactWarningHookService } from "./compact-warning-hook.service"
import { CompactWarningStateService } from "./compact-warning-state.service"
import { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
import { CodexContextAdapterService } from "./codex-context-adapter.service"
import { ContextCollapseService } from "./context-collapse.service"
import { ContextCompactRunnerService } from "./context-compact-runner.service"
import { ContextCompactionService } from "./context-compaction.service"
import { ContextHookExecutorService } from "./context-hook-executor.service"
import { ContextManagerService } from "./context-manager.service"
import { ContextNativeManagementService } from "./context-native-management.service"
import { ContextPipelineService } from "./context-pipeline.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextRequestPlannerService } from "./context-request-planner.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { PostCompactCleanupService } from "./post-compact-cleanup.service"
import { ReasoningMemoryService } from "./reasoning-memory.service"
import { TokenCounterService } from "./token-counter.service"
import { SessionMemoryCompactionService } from "./session-memory-compaction.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import { ToolResultStorageService } from "./tool-result-storage.service"

/**
 * Context Module
 *
 * Provides unified context management for proxy request paths.
 *
 * Components:
 * - TokenCounterService: Accurate token counting (tiktoken)
 * - ToolIntegrityService: Tool-pair-aware truncation helpers (no repair)
 * - ContextProjectionService: Read-time API view over transcript + compaction boundary
 * - ContextCompactRunnerService: No-tools backend compact-summary execution
 * - ContextCompactionService: Boundary-based compaction + explicit budget failure
 * - ContextManagerService: Single orchestration entry point for session and stateless requests
 * - ContextRequestPlannerService: Request budget + pre-send projection planner
 * - ContextNativeManagementService: Provider-native context edit strategy builder
 * - SessionMemoryCompactionService: Durable structured memory extracted at compaction boundaries
 * - ContextTelemetryService: Lightweight in-memory event counters for diagnostics
 *
 * Design:
 * - Maintain a canonical transcript or ephemeral transcript state
 * - Project backend-facing messages at send time
 * - Record compaction as first-class state instead of ad hoc truncation
 */
@Module({
  providers: [
    TokenCounterService,
    CodexContextAdapterService,
    CompactWarningStateService,
    CompactWarningHookService,
    PostCompactCleanupService,
    ToolIntegrityService,
    ToolResultStorageService,
    ContextAttachmentBuilderService,
    ContextCollapseService,
    ContextCompactRunnerService,
    ContextPipelineService,
    ContextProjectionService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextHookExecutorService,
    ContextManagerService,
    ContextNativeManagementService,
    ContextRequestPlannerService,
    ReasoningMemoryService,
    SessionMemoryCompactionService,
  ],
  exports: [
    TokenCounterService,
    CodexContextAdapterService,
    CompactWarningStateService,
    CompactWarningHookService,
    PostCompactCleanupService,
    ToolIntegrityService,
    ToolResultStorageService,
    ContextAttachmentBuilderService,
    ContextCollapseService,
    ContextCompactRunnerService,
    ContextPipelineService,
    ContextProjectionService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextHookExecutorService,
    ContextManagerService,
    ContextNativeManagementService,
    ContextRequestPlannerService,
    ReasoningMemoryService,
    SessionMemoryCompactionService,
  ],
})
export class ContextModule {}
