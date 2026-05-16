import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ContextManagerService, ContextTelemetryService } from "./context"
import { ChatSessionManager } from "./protocol/cursor/session/chat-session.service"

interface ManualCompactRequestBody {
  /** Cursor session id whose contextState we should compact. */
  conversationId?: string
  /**
   * Optional override for the synthetic budget pressure used to drive the
   * compaction planner.  Smaller values force more aggressive compaction.
   * Falls back to a tight default that always produces a boundary commit
   * when the transcript has enough material.
   */
  maxTokens?: number
}

interface ManualCompactResponseBody {
  ok: boolean
  conversationId: string
  applied: boolean
  reason?: string
  estimatedTokens?: number
  archivedMessageCount?: number
  summaryTokenCount?: number
}

/**
 * Read-only diagnostics + manual compaction control surface for the
 * dashboard.
 *
 * The endpoints are deliberately minimal: a counter snapshot for the
 * Diagnostics tab, and a one-shot manual compaction for the "compact
 * now" command-palette action.  Everything else (account state, quotas,
 * etc.) lives on `HealthController`.
 */
@ApiTags("Context")
@Controller("api/context")
export class ContextController {
  private readonly logger = new Logger(ContextController.name)

  constructor(
    private readonly contextManager: ContextManagerService,
    private readonly telemetry: ContextTelemetryService,
    private readonly chatSessions: ChatSessionManager
  ) {}

  @Get("telemetry")
  @ApiOperation({
    summary: "Snapshot of the in-memory context-management telemetry counters",
  })
  getTelemetry() {
    const counters = this.telemetry.snapshot()
    const grouped: Record<string, Record<string, number>> = {}
    for (const [key, value] of Object.entries(counters)) {
      const [event, scope] = key.split("::")
      if (!event) continue
      const targetScope = scope || "global"
      grouped[event] = grouped[event] || {}
      grouped[event][targetScope] = value
    }
    return {
      timestamp: new Date().toISOString(),
      counters,
      grouped,
    }
  }

  @Get("sessions")
  @ApiOperation({
    summary:
      "List in-memory Cursor chat sessions with compaction-relevant metadata",
  })
  listSessions() {
    return {
      timestamp: new Date().toISOString(),
      sessions: this.chatSessions.listSessionSummaries(),
    }
  }

  @Post("compact")
  @ApiOperation({
    summary:
      "Force a manual compaction commit on the given session's transcript",
  })
  manualCompact(
    @Body() body: ManualCompactRequestBody
  ): ManualCompactResponseBody {
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId.trim() : ""
    if (!conversationId) {
      throw new HttpException(
        "conversationId is required",
        HttpStatus.BAD_REQUEST
      )
    }

    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }

    // The dashboard typically wants "compact now" rather than "fit into
    // budget X".  Default to a tight budget so the planner produces a
    // boundary commit even when the transcript is comfortably below the
    // current request cap.  Operators can pass a custom value to fine-tune.
    const maxTokens =
      typeof body.maxTokens === "number" &&
      Number.isFinite(body.maxTokens) &&
      body.maxTokens > 0
        ? Math.floor(body.maxTokens)
        : 4_000

    const result = this.contextManager.manualCompact(
      session.contextState,
      this.buildEmptyAttachmentSnapshotForSession(),
      {
        maxTokens,
        // We do not know the system-prompt budget here — the planner uses
        // this only to sanity-clamp the budget, so passing 0 yields the
        // most aggressive compaction.  That matches the "force a summary"
        // intent of the manual entry point.
        systemPromptTokens: 0,
      }
    )

    if (!result.appliedCompaction) {
      return {
        ok: true,
        conversationId,
        applied: false,
        reason: "no_progress",
        estimatedTokens: result.estimatedTokens,
      }
    }

    this.chatSessions.markContextStateDirty(conversationId)
    this.logger.warn(
      `Manual compaction applied for ${conversationId}: ${result.appliedCompaction.commit.archivedMessageCount} records archived, ` +
        `summary=${result.appliedCompaction.commit.summaryTokenCount} tokens`
    )

    return {
      ok: true,
      conversationId,
      applied: true,
      estimatedTokens: result.estimatedTokens,
      archivedMessageCount:
        result.appliedCompaction.commit.archivedMessageCount,
      summaryTokenCount: result.appliedCompaction.commit.summaryTokenCount,
    }
  }

  private buildEmptyAttachmentSnapshotForSession() {
    // The manual compaction path is intentionally session-data-only: the
    // dashboard does not (today) carry the full attachment snapshot the
    // streaming path can build.  Passing an empty snapshot is safe — the
    // planner will simply skip the live attachments slot and base its
    // boundary on the transcript alone.
    return {
      readPaths: [],
      fileStates: [],
      todos: [],
    }
  }
}
