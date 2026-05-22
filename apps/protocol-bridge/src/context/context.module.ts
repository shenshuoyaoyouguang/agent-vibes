import { Module } from "@nestjs/common"
import { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
import { CodexContextAdapterService } from "./codex-context-adapter.service"
import { ContextCompactRunnerService } from "./context-compact-runner.service"
import { ContextCompactionService } from "./context-compaction.service"
import { ContextHookExecutorService } from "./context-hook-executor.service"
import { ContextManagerService } from "./context-manager.service"
import { ContextNativeCacheEditService } from "./context-native-cache-edit.service"
import { ContextNativeManagementService } from "./context-native-management.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextRequestPlannerService } from "./context-request-planner.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"
import { SessionMemoryCompactionService } from "./session-memory-compaction.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import { ToolResultCompactionService } from "./tool-result-compaction.service"
import { ToolResultStorageService } from "./tool-result-storage.service"

/**
 * Context Module
 *
 * Provides unified context management for proxy request paths.
 *
 * Components:
 * - TokenCounterService: Accurate token counting (tiktoken)
 * - ToolIntegrityService: Tool use/result pair integrity
 * - ContextProjectionService: Read-time API view over transcript + compaction boundary
 * - ContextCompactRunnerService: No-tools backend compact-summary execution
 * - ContextCompactionService: Boundary-based compaction + explicit budget failure
 * - ContextManagerService: Single orchestration entry point for session and stateless requests
 * - ContextRequestPlannerService: Request budget + pre-send projection planner
 * - ContextNativeManagementService: Provider-native context edit strategy builder
 * - ContextNativeCacheEditService: Claude cache-edit lifecycle for warm prompt-cache tool-result deletion
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
    ToolIntegrityService,
    ToolResultCompactionService,
    ToolResultStorageService,
    ContextAttachmentBuilderService,
    ContextCompactRunnerService,
    ContextProjectionService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextHookExecutorService,
    ContextManagerService,
    ContextNativeCacheEditService,
    ContextNativeManagementService,
    ContextRequestPlannerService,
    SessionMemoryCompactionService,
  ],
  exports: [
    TokenCounterService,
    CodexContextAdapterService,
    ToolIntegrityService,
    ToolResultCompactionService,
    ToolResultStorageService,
    ContextAttachmentBuilderService,
    ContextCompactRunnerService,
    ContextProjectionService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextHookExecutorService,
    ContextManagerService,
    ContextNativeCacheEditService,
    ContextNativeManagementService,
    ContextRequestPlannerService,
    SessionMemoryCompactionService,
  ],
})
export class ContextModule {}
