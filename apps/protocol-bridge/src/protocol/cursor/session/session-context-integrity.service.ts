import { Injectable, Logger } from "@nestjs/common"
import type {
  ContextConversationState,
  ContextTranscriptRecord,
} from "../../../context/types"
import { isMessageRecord } from "../../../context/context-transcript-events"
import { ToolResultStorageService } from "../../../context/tool-result-storage.service"

export interface SessionContextIntegrityRepairInput {
  conversationId: string
  messageRecords: ContextTranscriptRecord[]
  contextState: ContextConversationState
  pendingToolUseIds?: Iterable<string>
}

export interface SessionContextIntegrityRepairReport {
  messageRecords: ContextTranscriptRecord[]
  contextRecords: ContextTranscriptRecord[]
  injectedToolResults: number
  removedToolResults: number
  removedReplacementRecords: number
  removedStoredReferences: number
  changed: boolean
}

@Injectable()
export class SessionContextIntegrityService {
  private readonly logger = new Logger(SessionContextIntegrityService.name)

  constructor(private readonly toolResultStorage: ToolResultStorageService) {}

  repairLoadedSessionState(
    input: SessionContextIntegrityRepairInput
  ): SessionContextIntegrityRepairReport {
    const pendingToolUseIds = new Set(input.pendingToolUseIds || [])
    const messageRepair = this.repairTranscriptRecords(
      input.messageRecords,
      pendingToolUseIds
    )
    const contextRepair = this.repairTranscriptRecords(
      input.contextState.records,
      pendingToolUseIds
    )
    const validToolUseIds = this.collectToolUseIds([
      ...messageRepair.records,
      ...contextRepair.records,
    ])
    const pruneResult = this.toolResultStorage.pruneReplacementState(
      input.contextState.toolResultReplacementState,
      validToolUseIds,
      input.conversationId
    )

    const report: SessionContextIntegrityRepairReport = {
      messageRecords: messageRepair.records,
      contextRecords: contextRepair.records,
      injectedToolResults:
        messageRepair.injectedToolResults + contextRepair.injectedToolResults,
      removedToolResults:
        messageRepair.removedToolResults + contextRepair.removedToolResults,
      removedReplacementRecords: pruneResult.removedReplacements,
      removedStoredReferences: pruneResult.removedStoredReferences,
      changed:
        messageRepair.changed ||
        contextRepair.changed ||
        pruneResult.removedReplacements > 0 ||
        pruneResult.removedStoredReferences > 0,
    }

    if (report.changed) {
      this.logger.warn(
        `Session context integrity repaired for ${input.conversationId}: ` +
          `injected=${report.injectedToolResults}, ` +
          `removedToolResults=${report.removedToolResults}, ` +
          `removedReplacements=${report.removedReplacementRecords}, ` +
          `removedStoredReferences=${report.removedStoredReferences}`
      )
    }

    return report
  }

  private repairTranscriptRecords(
    records: ContextTranscriptRecord[],
    pendingToolUseIds: Set<string>
  ): {
    records: ContextTranscriptRecord[]
    injectedToolResults: number
    removedToolResults: number
    changed: boolean
  } {
    const pass1: ContextTranscriptRecord[] = []
    let removedToolResults = 0
    let changed = false

    for (let index = 0; index < records.length; index++) {
      const record = records[index]
      if (!record) continue
      if (!isMessageRecord(record) || record.role !== "user") {
        pass1.push(record)
        continue
      }

      const previousMessage = [...pass1]
        .reverse()
        .find((candidate) => isMessageRecord(candidate))
      const allowedToolUseIds =
        previousMessage?.role === "assistant"
          ? this.extractToolUseIds(previousMessage.content)
          : new Set<string>()

      const filtered = this.removeInvalidToolResults(record, allowedToolUseIds)
      removedToolResults += filtered.removedToolResults
      changed = changed || filtered.changed
      pass1.push(filtered.record)
    }

    const output: ContextTranscriptRecord[] = []
    let injectedToolResults = 0
    for (let index = 0; index < pass1.length; index++) {
      const record = pass1[index]
      if (!record) continue
      output.push(record)
      if (!isMessageRecord(record) || record.role !== "assistant") continue

      const toolUseIds = this.extractToolUseIds(record.content)
      if (toolUseIds.size === 0) continue

      const nextMessage = pass1
        .slice(index + 1)
        .find((candidate) => isMessageRecord(candidate))
      const adjacentResultIds =
        nextMessage?.role === "user"
          ? this.extractToolResultIds(nextMessage.content)
          : new Set<string>()
      const missingToolUseIds = Array.from(toolUseIds).filter(
        (toolUseId) =>
          !adjacentResultIds.has(toolUseId) && !pendingToolUseIds.has(toolUseId)
      )
      if (missingToolUseIds.length === 0) continue

      output.push(
        this.createSyntheticToolResultRecord(record, missingToolUseIds, index)
      )
      injectedToolResults += missingToolUseIds.length
      changed = true
    }

    return { records: output, injectedToolResults, removedToolResults, changed }
  }

  private removeInvalidToolResults(
    record: ContextTranscriptRecord,
    allowedToolUseIds: Set<string>
  ): {
    record: ContextTranscriptRecord
    removedToolResults: number
    changed: boolean
  } {
    if (!Array.isArray(record.content)) {
      return { record, removedToolResults: 0, changed: false }
    }

    let removedToolResults = 0
    const filtered = record.content.filter((block) => {
      if (!block || typeof block !== "object") return true
      if ((block as { type?: unknown }).type !== "tool_result") return true
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id
      if (typeof toolUseId === "string" && allowedToolUseIds.has(toolUseId)) {
        return true
      }
      removedToolResults++
      return false
    })

    if (removedToolResults === 0) {
      return { record, removedToolResults: 0, changed: false }
    }

    return {
      record: {
        ...record,
        content:
          filtered.length > 0
            ? (filtered as ContextTranscriptRecord["content"])
            : ".",
      },
      removedToolResults,
      changed: true,
    }
  }

  private createSyntheticToolResultRecord(
    assistantRecord: ContextTranscriptRecord,
    toolUseIds: string[],
    index: number
  ): ContextTranscriptRecord {
    return {
      id: `synthetic_tool_result_${assistantRecord.id}_${index}`,
      role: "user",
      kind: "message",
      createdAt: assistantRecord.createdAt + 1,
      content: toolUseIds.map((toolUseId) => ({
        type: "tool_result" as const,
        tool_use_id: toolUseId,
        content:
          "Tool execution was interrupted or result was lost during session recovery.",
      })),
    }
  }

  private collectToolUseIds(records: ContextTranscriptRecord[]): Set<string> {
    const ids = new Set<string>()
    for (const record of records) {
      if (!isMessageRecord(record) || record.role !== "assistant") continue
      for (const id of this.extractToolUseIds(record.content)) {
        ids.add(id)
      }
    }
    return ids
  }

  private extractToolUseIds(content: unknown): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(content)) return ids
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const record = block as { type?: unknown; id?: unknown }
      if (record.type === "tool_use" && typeof record.id === "string") {
        ids.add(record.id)
      }
    }
    return ids
  }

  private extractToolResultIds(content: unknown): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(content)) return ids
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const record = block as { type?: unknown; tool_use_id?: unknown }
      if (
        record.type === "tool_result" &&
        typeof record.tool_use_id === "string"
      ) {
        ids.add(record.tool_use_id)
      }
    }
    return ids
  }
}
