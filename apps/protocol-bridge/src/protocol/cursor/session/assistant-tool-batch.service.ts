import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common"
import { ConversationId } from "../turn/turn.types"
import type { BackendType } from "../../../llm/shared/model-router.service"
import { SessionLifecycleService } from "./session-lifecycle.service"

/**
 * AssistantToolBatchService
 *
 * The bridge tracks one in-flight assistant tool batch per
 * conversation. A "batch" is the set of tool_use blocks the model
 * emitted in a single message_stop — the IDE may settle them in any
 * order, but exactly one tool_result claims the right to drive the
 * follow-up continuation. The state machine guards against:
 *
 *   - re-claiming the continuation after it has already fired
 *   - claiming continuation while a sibling tool is still unsettled
 *   - back-end mismatch (a stale batch from a different backend)
 *
 * Pre-step-4 the state lived as `session.activeAssistantToolBatch` /
 * `session.toolExecutionOrderCounter` on the giant SessionRecord
 * object; this service owns it as `Map<ConversationId, Record>`.
 *
 * `mark dirty` / `lastActivityAt` updates flow through the lifecycle
 * service via `forwardRef` so the legacy persist scheduling continues
 * to fire whenever a batch transitions.
 */

export interface AssistantToolBatch {
  id: string
  backend: BackendType
  toolCallIds: string[]
  unsettledToolCallIds: string[]
  continuationClaimed?: boolean
  readyForContinuation?: boolean
}

interface AssistantToolBatchRecord {
  toolExecutionOrderCounter: number
  activeAssistantToolBatch?: AssistantToolBatch
}

@Injectable()
export class AssistantToolBatchService {
  private readonly logger = new Logger(AssistantToolBatchService.name)
  private readonly records = new Map<ConversationId, AssistantToolBatchRecord>()

  constructor(
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  // ── batch state machine ────────────────────────────────────────

  startAssistantToolBatch(
    conversationId: string,
    backend: BackendType,
    toolCallIds: string[],
    options?: { readyForContinuation?: boolean }
  ): void {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)

    const normalizedToolCallIds = toolCallIds
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)

    if (normalizedToolCallIds.length === 0) {
      record.activeAssistantToolBatch = undefined
      this.touchSession(conversationId)
      return
    }

    record.activeAssistantToolBatch = {
      id: `assistant-batch-${Date.now()}`,
      backend,
      toolCallIds: [...normalizedToolCallIds],
      unsettledToolCallIds: [...normalizedToolCallIds],
      continuationClaimed: false,
      readyForContinuation: options?.readyForContinuation ?? true,
    }
    this.touchSession(conversationId)
  }

  addAssistantToolBatchTools(
    conversationId: string,
    backend: BackendType,
    toolCallIds: string[],
    options?: { readyForContinuation?: boolean }
  ): void {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)

    const normalizedToolCallIds = toolCallIds
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)
    if (normalizedToolCallIds.length === 0) return

    const batch = record.activeAssistantToolBatch
    if (!batch || batch.backend !== backend || batch.continuationClaimed) {
      this.startAssistantToolBatch(
        conversationId,
        backend,
        normalizedToolCallIds,
        options
      )
      return
    }

    for (const toolCallId of normalizedToolCallIds) {
      if (!batch.toolCallIds.includes(toolCallId)) {
        batch.toolCallIds.push(toolCallId)
      }
      // The unsettled list mirrors "tools the bridge has not yet
      // received a result for"; we add unconditionally and rely on
      // settleAssistantToolBatchTool to drain entries as results
      // arrive. (Pre-step-4 the lifecycle service consulted its
      // own pending-tool map here before adding; we keep the batch
      // service self-contained — any tool the caller adds is by
      // definition still in flight from its perspective, and a
      // duplicate-add is idempotent because settleAssistantToolBatchTool
      // tolerates absent ids.)
      if (!batch.unsettledToolCallIds.includes(toolCallId)) {
        batch.unsettledToolCallIds.push(toolCallId)
      }
    }
    if (typeof options?.readyForContinuation === "boolean") {
      batch.readyForContinuation = options.readyForContinuation
    }
    this.touchSession(conversationId)
  }

  settleAssistantToolBatchTool(
    conversationId: string,
    toolCallId: string
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    if (!record?.activeAssistantToolBatch) return false

    const normalizedToolCallId =
      typeof toolCallId === "string" ? toolCallId.trim() : ""
    if (!normalizedToolCallId) return false

    const batch = record.activeAssistantToolBatch
    const nextUnsettled = batch.unsettledToolCallIds.filter(
      (id) => id !== normalizedToolCallId
    )
    if (nextUnsettled.length === batch.unsettledToolCallIds.length) {
      return false
    }

    batch.unsettledToolCallIds = nextUnsettled
    this.touchSession(conversationId)
    return true
  }

  hasUnsettledAssistantToolBatchForBackend(
    conversationId: string,
    backend: BackendType
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    if (!record?.activeAssistantToolBatch) return false

    const batch = record.activeAssistantToolBatch
    return (
      batch.backend === backend &&
      (batch.readyForContinuation === false ||
        batch.unsettledToolCallIds.length > 0)
    )
  }

  claimAssistantToolBatchContinuation(
    conversationId: string,
    backend: BackendType,
    toolCallId: string
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    const batch = record?.activeAssistantToolBatch
    if (!record || !batch) return true
    if (batch.backend !== backend) return true
    if (!batch.toolCallIds.includes(toolCallId)) return true
    if (batch.readyForContinuation === false) return false
    if (batch.unsettledToolCallIds.length > 0) return false
    if (batch.continuationClaimed) return false

    batch.continuationClaimed = true
    this.touchSession(conversationId)
    return true
  }

  // ── snapshot / cleanup ─────────────────────────────────────────

  getActiveAssistantToolBatchSnapshot(
    conversationId: string
  ): AssistantToolBatch | undefined {
    const cid = ConversationId.of(conversationId)
    const batch = this.records.get(cid)?.activeAssistantToolBatch
    if (!batch) return undefined
    return {
      id: batch.id,
      backend: batch.backend,
      toolCallIds: [...batch.toolCallIds],
      unsettledToolCallIds: [...batch.unsettledToolCallIds],
      continuationClaimed: batch.continuationClaimed,
      readyForContinuation: batch.readyForContinuation,
    }
  }

  /**
   * Cross-service serialisation hook used by SessionLifecycleService
   * when it persists the legacy session blob: returns the raw batch
   * object (or undefined) so the lifecycle serializer can drop it
   * into PersistedChatSessionV1.activeAssistantToolBatch verbatim.
   * Callers must not mutate the returned reference.
   */
  getRawForPersistence(conversationId: string): AssistantToolBatch | undefined {
    return this.records.get(ConversationId.of(conversationId))
      ?.activeAssistantToolBatch
  }

  /**
   * Restore the batch state from a persisted blob during session
   * rehydration. Used by SessionLifecycleService.parsePersistedSession.
   */
  hydrateFromPersistence(
    conversationId: string,
    batch: AssistantToolBatch | undefined,
    toolExecutionOrderCounter: number
  ): void {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)
    record.activeAssistantToolBatch = batch
      ? {
          ...batch,
          toolCallIds: [...batch.toolCallIds],
          unsettledToolCallIds: [...batch.unsettledToolCallIds],
        }
      : undefined
    record.toolExecutionOrderCounter = toolExecutionOrderCounter
  }

  getToolExecutionOrderCounter(conversationId: string): number {
    return (
      this.records.get(ConversationId.of(conversationId))
        ?.toolExecutionOrderCounter ?? 0
    )
  }

  bumpToolExecutionOrderCounter(conversationId: string): number {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)
    record.toolExecutionOrderCounter += 1
    return record.toolExecutionOrderCounter
  }

  clearAssistantToolBatch(conversationId: string): void {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    if (!record) return
    record.activeAssistantToolBatch = undefined
  }

  /**
   * Drop the entire record on session teardown. Called by
   * SessionLifecycleService.deleteSession.
   */
  forgetSession(conversationId: string): void {
    this.records.delete(ConversationId.of(conversationId))
  }

  // ── internal ───────────────────────────────────────────────────

  private ensureRecord(cid: ConversationId): AssistantToolBatchRecord {
    let record = this.records.get(cid)
    if (!record) {
      record = {
        toolExecutionOrderCounter: 0,
        activeAssistantToolBatch: undefined,
      }
      this.records.set(cid, record)
    }
    return record
  }

  private touchSession(conversationId: string): void {
    // The legacy implementation ran lastActivityAt + schedulePersist
    // on every batch transition. Delegate through the lifecycle
    // service so the v1 blob persistence cadence is preserved.
    this.sessionLifecycle.markSessionDirty(conversationId)
  }
}
