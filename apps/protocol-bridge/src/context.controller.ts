import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
} from "@nestjs/common"
import { ApiOperation, ApiTags } from "@nestjs/swagger"
import { ContextTelemetryService } from "./context"
import { CursorConnectStreamService } from "./protocol/cursor/cursor-connect-stream.service"
import { SessionLifecycleService } from "./protocol/cursor/session/session-lifecycle.service"
import { ContextStateService } from "./protocol/cursor/session/context-state.service"

interface ManualCompactRequestBody {
  /** Cursor session id whose contextState we should compact. */
  conversationId?: string
  /**
   * Optional override for the synthetic budget pressure used to drive the
   * compaction planner.  Smaller values force more aggressive compaction.
   * Defaults to a tight value that produces a boundary commit
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

interface WorkingDirectoriesRequestBody {
  /** One path for convenience; `paths` is preferred for batch updates. */
  path?: string
  /** Absolute or workspace-relative directories to add/remove. */
  paths?: string[]
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
    private readonly telemetry: ContextTelemetryService,
    private readonly chatSessions: SessionLifecycleService,
    private readonly contextState: ContextStateService,
    private readonly cursorStream: CursorConnectStreamService
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

  @Get(":conversationId/working-directories")
  @ApiOperation({
    summary: "List allowed working directories for a Cursor chat session",
  })
  getWorkingDirectories(@Param("conversationId") conversationId: string) {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    return {
      ok: true,
      conversationId,
      allowedRoots: this.chatSessions.listAllowedWorkspaceRoots(conversationId),
      additionalRoots:
        this.chatSessions.getAdditionalWorkspaceRoots(conversationId),
    }
  }

  @Post(":conversationId/working-directories")
  @ApiOperation({
    summary: "Add additional working directories to a Cursor chat session",
  })
  addWorkingDirectories(
    @Param("conversationId") conversationId: string,
    @Body() body: WorkingDirectoriesRequestBody
  ) {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    const paths = this.normalizeWorkingDirectoryPaths(body)
    if (paths.length === 0) {
      throw new HttpException("paths is required", HttpStatus.BAD_REQUEST)
    }
    const added = paths.map((rawPath) => {
      const entry = this.chatSessions.addAdditionalWorkspaceRoot(
        conversationId,
        rawPath,
        "session"
      )
      if (!entry) {
        throw new HttpException(
          `Invalid working directory: ${rawPath}`,
          HttpStatus.BAD_REQUEST
        )
      }
      return entry
    })
    return {
      ok: true,
      conversationId,
      added,
      allowedRoots: this.chatSessions.listAllowedWorkspaceRoots(conversationId),
      additionalRoots:
        this.chatSessions.getAdditionalWorkspaceRoots(conversationId),
    }
  }

  @Delete(":conversationId/working-directories")
  @ApiOperation({
    summary: "Remove additional working directories from a Cursor chat session",
  })
  deleteWorkingDirectories(
    @Param("conversationId") conversationId: string,
    @Body() body: WorkingDirectoriesRequestBody
  ) {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }
    const paths = this.normalizeWorkingDirectoryPaths(body)
    if (paths.length === 0) {
      throw new HttpException("paths is required", HttpStatus.BAD_REQUEST)
    }
    const removed = paths.filter((rawPath) =>
      this.chatSessions.removeAdditionalWorkspaceRoot(conversationId, rawPath)
    )
    return {
      ok: true,
      conversationId,
      removed,
      allowedRoots: this.chatSessions.listAllowedWorkspaceRoots(conversationId),
      additionalRoots:
        this.chatSessions.getAdditionalWorkspaceRoots(conversationId),
    }
  }

  @Post("compact")
  @ApiOperation({
    summary:
      "Force a manual compaction commit on the given session's transcript",
  })
  async manualCompact(
    @Body() body: ManualCompactRequestBody
  ): Promise<ManualCompactResponseBody> {
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

    const result = await this.cursorStream.compactConversationNow(
      conversationId,
      maxTokens
    )

    if (!result.applied) {
      return {
        ok: true,
        conversationId,
        applied: false,
        reason: "no_progress",
        estimatedTokens: result.estimatedTokens,
      }
    }

    this.logger.warn(
      `Manual compaction applied for ${conversationId}: ${result.archivedMessageCount} records archived, ` +
        `summary=${result.summaryTokenCount} tokens`
    )

    return {
      ok: true,
      conversationId,
      applied: true,
      estimatedTokens: result.estimatedTokens,
      archivedMessageCount: result.archivedMessageCount,
      summaryTokenCount: result.summaryTokenCount,
    }
  }

  @Post(":conversationId/force-snip")
  @ApiOperation({
    summary:
      "Force-snip the conversation: hide every message older than the most " +
      "recent N from the model-facing view (default keep_recent=4). Mirrors " +
      "Claude Code's /force-snip slash command.",
  })
  forceSnip(
    @Param("conversationId") conversationId: string,
    @Body() body: { keep_recent?: number; reason?: string } | undefined
  ): {
    ok: boolean
    conversationId: string
    applied: boolean
    snippedCount: number
    keptCount: number
    totalRecords: number
    boundaryId?: string
    reason?: string
  } {
    const session = this.chatSessions.getSession(conversationId)
    if (!session) {
      throw new HttpException(
        `Session not found: ${conversationId}`,
        HttpStatus.NOT_FOUND
      )
    }

    const requestedKeep =
      typeof body?.keep_recent === "number" && Number.isFinite(body.keep_recent)
        ? Math.max(2, Math.floor(body.keep_recent))
        : 4
    const trimmedReason =
      typeof body?.reason === "string" && body.reason.trim().length > 0
        ? body.reason.trim().slice(0, 240)
        : "user-triggered force-snip"

    const targets = this.contextState.resolveSnipTargets(
      conversationId,
      requestedKeep
    )
    if (targets.removedRecordIds.length === 0) {
      return {
        ok: true,
        conversationId,
        applied: false,
        snippedCount: 0,
        keptCount: targets.keptCount,
        totalRecords: targets.totalCount,
      }
    }

    const boundary = this.contextState.registerSnipBoundary(conversationId, {
      removedRecordIds: targets.removedRecordIds,
      trigger: "user",
      reason: trimmedReason,
    })

    this.logger.warn(
      `Force-snip applied for ${conversationId}: removed ${targets.removedRecordIds.length} record(s), kept ${targets.keptCount}, boundary=${boundary?.id}`
    )

    return {
      ok: true,
      conversationId,
      applied: Boolean(boundary),
      snippedCount: targets.removedRecordIds.length,
      keptCount: targets.keptCount,
      totalRecords: targets.totalCount,
      boundaryId: boundary?.id,
      reason: trimmedReason,
    }
  }

  private normalizeWorkingDirectoryPaths(
    body: WorkingDirectoriesRequestBody
  ): string[] {
    const raw = [
      ...(Array.isArray(body.paths) ? body.paths : []),
      ...(typeof body.path === "string" ? [body.path] : []),
    ]
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of raw) {
      const normalized = typeof value === "string" ? value.trim() : ""
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      out.push(normalized)
    }
    return out
  }
}
