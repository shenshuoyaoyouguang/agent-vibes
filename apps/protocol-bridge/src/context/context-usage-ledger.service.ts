import { Injectable } from "@nestjs/common"
import { fingerprintProjectedAttachments } from "./attachment-fingerprint"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import { TokenCounterService } from "./token-counter.service"
import {
  ContextConversationState,
  ContextUsageLedgerState,
  ContextUsageSnapshot,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"

@Injectable()
export class ContextUsageLedgerService {
  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly projection: ContextProjectionService
  ) {}

  recordResponseUsage(
    state: ContextConversationState,
    recordId: string,
    usage: Omit<ContextUsageSnapshot, "totalTokens" | "recordedAt">,
    options?: {
      projectedTokenCount?: number
      recordedCompactionId?: string
      attachmentFingerprint?: string
    }
  ): void {
    state.usageLedger = {
      anchorRecordId: recordId,
      lastUsage: {
        ...usage,
        totalTokens:
          usage.inputTokens +
          usage.cachedInputTokens +
          usage.cacheCreationInputTokens +
          usage.outputTokens,
        recordedAt: Date.now(),
      },
      projectedTokenCount: options?.projectedTokenCount,
      recordedCompactionId: options?.recordedCompactionId,
      attachmentFingerprint: options?.attachmentFingerprint,
    }
  }

  buildProjectionLedger(
    state: ContextConversationState,
    projectedMessages: ProjectedContextMessage[]
  ): Pick<
    ContextUsageLedgerState,
    "projectedTokenCount" | "recordedCompactionId" | "attachmentFingerprint"
  > {
    const asUnified = projectedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]

    return {
      projectedTokenCount: this.tokenCounter.countMessages(asUnified),
      recordedCompactionId: this.projection.getActiveCommit(state)?.id,
      attachmentFingerprint: fingerprintProjectedAttachments(projectedMessages),
    }
  }

  estimateProjectedTokens(
    state: ContextConversationState,
    projectedMessages?: ProjectedContextMessage[],
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
    }
  ): number {
    const projected =
      projectedMessages ??
      this.projection.project(state, {
        attachmentSnapshot: options?.attachmentSnapshot,
        attachmentTokenBudget: options?.attachmentTokenBudget,
      })
    const asUnified = projected.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]
    const rawEstimate = this.tokenCounter.countMessages(asUnified)
    const anchorId = state.usageLedger.anchorRecordId
    const usage = state.usageLedger.lastUsage
    const projectedTokenCount = state.usageLedger.projectedTokenCount

    if (!anchorId || !usage || projectedTokenCount == null) {
      return rawEstimate
    }

    const currentCompactionId = this.projection.getActiveCommit(state)?.id
    if (state.usageLedger.recordedCompactionId !== currentCompactionId) {
      return rawEstimate
    }

    const lastAppliedCompaction = state.lastAppliedCompaction
    if (
      currentCompactionId &&
      lastAppliedCompaction &&
      lastAppliedCompaction.compactionId !== currentCompactionId
    ) {
      return rawEstimate
    }

    const currentAttachmentFingerprint =
      fingerprintProjectedAttachments(projected)
    if (
      (state.usageLedger.attachmentFingerprint || "") !==
      currentAttachmentFingerprint
    ) {
      return rawEstimate
    }

    const anchorIndex = projected.findIndex(
      (message) => message.recordId === anchorId
    )
    if (anchorIndex < 0) {
      return rawEstimate
    }

    const suffixMessages = projected.slice(anchorIndex + 1).map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]

    if (suffixMessages.length === 0) {
      return projectedTokenCount
    }

    return projectedTokenCount + this.tokenCounter.countMessages(suffixMessages)
  }
}
