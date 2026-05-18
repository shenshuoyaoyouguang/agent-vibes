import { Module } from "@nestjs/common"
import { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
import { ContextCompactionService } from "./context-compaction.service"
import { ContextHookExecutorService } from "./context-hook-executor.service"
import { ContextManagerService } from "./context-manager.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextSummaryService } from "./context-summary.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import { ToolResultCompactionService } from "./tool-result-compaction.service"

/**
 * Context Module
 *
 * Provides unified context management for proxy request paths.
 *
 * Components:
 * - TokenCounterService: Accurate token counting (tiktoken)
 * - ToolIntegrityService: Tool use/result pair integrity
 * - ContextProjectionService: Read-time API view over transcript + compaction boundary
 * - ContextSummaryService: Structured compaction summary generation
 * - ContextCompactionService: Boundary-based compaction + final hard fit
 * - ContextManagerService: Single orchestration entry point for session and stateless requests
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
    ToolIntegrityService,
    ToolResultCompactionService,
    ContextAttachmentBuilderService,
    ContextProjectionService,
    ContextSummaryService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextHookExecutorService,
    ContextManagerService,
  ],
  exports: [
    TokenCounterService,
    ToolIntegrityService,
    ToolResultCompactionService,
    ContextAttachmentBuilderService,
    ContextProjectionService,
    ContextSummaryService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextHookExecutorService,
    ContextManagerService,
  ],
})
export class ContextModule {}
