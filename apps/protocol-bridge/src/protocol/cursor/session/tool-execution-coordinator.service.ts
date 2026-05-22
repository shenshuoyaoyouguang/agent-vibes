import { Injectable, Logger } from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import type { ChatSession, PendingToolCall } from "./chat-session.service"
import { ChatSessionManager } from "./chat-session.service"
import type {
  ToolExecutionOwner,
  ToolExecutionRecoveryReason,
  ToolExecutionStatus,
} from "./tool-execution-types"

export interface ToolInputEofRecoveryPlan {
  bridgeLocalToolCallIds: string[]
  awaitingClientToolCallIds: string[]
  unresolvedToolCallIds: string[]
}

@Injectable()
export class ToolExecutionCoordinatorService {
  private readonly logger = new Logger(ToolExecutionCoordinatorService.name)

  constructor(private readonly sessionManager: ChatSessionManager) {}

  classifyOwner(toolName: string): ToolExecutionOwner {
    return this.isBridgeLocalInputEofFallbackTool(toolName)
      ? "bridge"
      : "client"
  }

  registerPendingTool(conversationId: string, toolCallId: string): void {
    const session = this.sessionManager.getSession(conversationId)
    const pending = session?.pendingToolCalls.get(toolCallId)
    if (!session || !pending) return

    this.sessionManager.updatePendingToolExecution(conversationId, toolCallId, {
      executionOwner:
        pending.executionOwner || this.classifyOwner(pending.toolName),
      executionStatus: pending.executionStatus || "pending",
    })
  }

  markRunning(conversationId: string, toolCallId: string): void {
    this.updateStatus(conversationId, toolCallId, "running")
  }

  markCompleted(conversationId: string, toolCallId: string): void {
    this.updateStatus(conversationId, toolCallId, "completed")
  }

  markDiscarded(
    conversationId: string,
    toolCallIds: readonly string[],
    reason: ToolExecutionRecoveryReason
  ): void {
    for (const toolCallId of toolCallIds) {
      this.sessionManager.updatePendingToolExecution(
        conversationId,
        toolCallId,
        {
          executionStatus: "discarded",
          executionRecoveryReason: reason,
        }
      )
    }
  }

  buildInputEofRecoveryPlan(
    conversationId: string,
    streamId: string,
    candidateToolCallIds: readonly string[]
  ): ToolInputEofRecoveryPlan {
    const session = this.sessionManager.getSession(conversationId)
    if (!session) {
      return {
        bridgeLocalToolCallIds: [],
        awaitingClientToolCallIds: [],
        unresolvedToolCallIds: [],
      }
    }

    const candidateSet = new Set(candidateToolCallIds.filter(Boolean))
    const pendingIds = Array.from(session.pendingToolCalls.entries())
      .filter(([toolCallId, pending]) => {
        if (candidateSet.size > 0 && !candidateSet.has(toolCallId)) return false
        return pending.streamId === streamId
      })
      .sort((left, right) => {
        const leftOrder = left[1].executionOrder ?? Number.MAX_SAFE_INTEGER
        const rightOrder = right[1].executionOrder ?? Number.MAX_SAFE_INTEGER
        return leftOrder - rightOrder
      })
      .map(([toolCallId]) => toolCallId)

    const bridgeLocalToolCallIds: string[] = []
    const awaitingClientToolCallIds: string[] = []
    const unresolvedToolCallIds: string[] = []

    for (const toolCallId of pendingIds) {
      const pending = session.pendingToolCalls.get(toolCallId)
      if (!pending) continue
      const canRunBridgeLocal = this.canRunBridgeLocalInputEofFallback(
        session,
        pending
      )
      if (canRunBridgeLocal) {
        bridgeLocalToolCallIds.push(toolCallId)
        this.sessionManager.updatePendingToolExecution(
          conversationId,
          toolCallId,
          {
            executionOwner: "bridge",
            executionStatus: "running",
            executionRecoveryReason: "input_eof",
          }
        )
        continue
      }

      awaitingClientToolCallIds.push(toolCallId)
      unresolvedToolCallIds.push(toolCallId)
      this.sessionManager.updatePendingToolExecution(
        conversationId,
        toolCallId,
        {
          executionOwner: pending.executionOwner || "client",
          executionStatus: "awaitingClientResult",
          executionRecoveryReason: "input_eof",
        }
      )
    }

    if (awaitingClientToolCallIds.length > 0) {
      this.logger.warn(
        `Input EOF left ${awaitingClientToolCallIds.length} client-owned pending tool call(s) awaiting resumeAction: ${awaitingClientToolCallIds.join(", ")}`
      )
    }

    return {
      bridgeLocalToolCallIds,
      awaitingClientToolCallIds,
      unresolvedToolCallIds,
    }
  }

  isBridgeLocalInputEofFallbackTool(toolName: string): boolean {
    const normalized = toolName.trim().toLowerCase()
    return (
      normalized === "read_file" ||
      normalized === "read_file_v2" ||
      normalized === "list_directory" ||
      normalized === "list_dir" ||
      normalized === "grep_search" ||
      normalized === "view_content_chunk"
    )
  }

  canRunBridgeLocalInputEofFallback(
    session: ChatSession,
    pendingToolCall: PendingToolCall
  ): boolean {
    const normalized = pendingToolCall.toolName.trim().toLowerCase()
    if (!this.isBridgeLocalInputEofFallbackTool(normalized)) return false
    if (normalized === "view_content_chunk") return true
    return this.hasLocalWorkspaceRoot(session)
  }

  private updateStatus(
    conversationId: string,
    toolCallId: string,
    status: ToolExecutionStatus
  ): void {
    this.sessionManager.updatePendingToolExecution(conversationId, toolCallId, {
      executionStatus: status,
    })
  }

  private hasLocalWorkspaceRoot(session: ChatSession): boolean {
    const roots = new Set<string>()
    const rootPath = session.projectContext?.rootPath?.trim()
    if (rootPath) roots.add(rootPath)
    for (const folder of session.projectContext?.workspaceFolders || []) {
      const folderPath = folder?.path?.trim()
      if (folderPath) roots.add(folderPath)
    }
    for (const root of session.additionalRoots?.values() || []) {
      if (root.path) roots.add(root.path)
    }

    for (const root of roots) {
      try {
        const normalized = path.resolve(root)
        if (
          fs.existsSync(normalized) &&
          fs.statSync(normalized).isDirectory()
        ) {
          return true
        }
      } catch {
        continue
      }
    }
    return false
  }
}
