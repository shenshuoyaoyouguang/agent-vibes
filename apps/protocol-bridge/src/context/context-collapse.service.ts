import { Injectable } from "@nestjs/common"
import { randomUUID } from "crypto"
import type { ContextCompactionCandidate } from "./context-compaction.service"
import {
  createContextCollapseSummaryRecord,
  isContextCollapseSummaryRecord,
  isMessageRecord,
} from "./context-transcript-events"
import { TokenCounterService } from "./token-counter.service"
import {
  ContextCollapseCommit,
  ContextCollapseState,
  ContextConversationState,
  ContextTranscriptRecord,
  UnifiedMessage,
} from "./types"

export interface ContextCollapseApplyInput {
  summary: string
}

export interface ContextCollapseProjectionResult {
  records: ContextTranscriptRecord[]
  appliedCommitIds: string[]
  skippedCommitIds: string[]
}

@Injectable()
export class ContextCollapseService {
  constructor(private readonly tokenCounter: TokenCounterService) {}

  ensureState(state: ContextConversationState): ContextCollapseState {
    if (!state.contextCollapseState) {
      state.contextCollapseState = { commits: [] }
    }
    if (!Array.isArray(state.contextCollapseState.commits)) {
      state.contextCollapseState.commits = []
    }
    return state.contextCollapseState
  }

  getActiveCommits(state: ContextConversationState): ContextCollapseCommit[] {
    return this.ensureState(state).commits.filter((commit) =>
      this.isValidCommit(commit)
    )
  }

  applyGeneratedCollapse(
    state: ContextConversationState,
    candidate: ContextCompactionCandidate,
    input: ContextCollapseApplyInput
  ): ContextCollapseCommit {
    const summary = input.summary.trim()
    if (!summary) {
      throw new Error("Context collapse summary is empty")
    }

    const collapseState = this.ensureState(state)
    const id = randomUUID()
    const sourceMessageCount =
      candidate.archivedRecords.filter(isMessageRecord).length
    const commit: ContextCollapseCommit = {
      id,
      createdAt: Date.now(),
      strategy: candidate.strategy,
      parentCollapseId:
        collapseState.commits[collapseState.commits.length - 1]?.id,
      archivedRecordIds: candidate.archivedRecords.map((record) => record.id),
      archivedThroughRecordId:
        candidate.archivedRecords[candidate.archivedRecords.length - 1]!.id,
      summaryRecordId: `context_collapse_summary_${id}`,
      sourceRecordCount: candidate.archivedRecords.length,
      sourceMessageCount,
      sourceTokenCount: candidate.sourceTokenCount,
      retainedStartRecordId: candidate.retainedRecords[0]?.id,
      retainedRecordCount: candidate.retainedRecords.length,
      retainedTokenCount: candidate.retainedTokenCount,
      summary,
      summaryTokenCount: this.tokenCounter.countText(summary),
      projectedTokenCount: 0,
    }

    collapseState.commits = [...collapseState.commits, commit]
    collapseState.updatedAt = commit.createdAt
    commit.projectedTokenCount = this.countRecords(this.projectRecords(state))
    return commit
  }

  projectRecords(
    state: ContextConversationState,
    records: readonly ContextTranscriptRecord[] = state.records
  ): ContextTranscriptRecord[] {
    return this.projectRecordsWithMetadata(state, records).records
  }

  projectRecordsWithMetadata(
    state: ContextConversationState,
    records: readonly ContextTranscriptRecord[] = state.records
  ): ContextCollapseProjectionResult {
    let projected = [...records]
    const appliedCommitIds: string[] = []
    const skippedCommitIds: string[] = []

    for (const commit of this.getActiveCommits(state)) {
      if (projected.some((record) => record.id === commit.summaryRecordId)) {
        appliedCommitIds.push(commit.id)
        continue
      }

      const archivedIds = new Set(commit.archivedRecordIds)
      const indexes: number[] = []
      projected.forEach((record, index) => {
        if (archivedIds.has(record.id)) {
          indexes.push(index)
        }
      })
      if (indexes.length === 0) {
        skippedCommitIds.push(commit.id)
        continue
      }

      const firstIndex = Math.min(...indexes)
      const indexSet = new Set(indexes)
      const summaryRecord = createContextCollapseSummaryRecord(
        commit,
        projected[firstIndex]?.createdAt ?? commit.createdAt
      )
      const next: ContextTranscriptRecord[] = []
      for (let index = 0; index < projected.length; index++) {
        if (index === firstIndex) {
          next.push(summaryRecord)
        }
        if (!indexSet.has(index)) {
          next.push(projected[index]!)
        }
      }
      projected = next
      appliedCommitIds.push(commit.id)
    }

    return {
      records: projected,
      appliedCommitIds,
      skippedCommitIds,
    }
  }

  reset(state: ContextConversationState): void {
    const collapseState = this.ensureState(state)
    if (collapseState.commits.length === 0) {
      return
    }
    state.contextCollapseState = {
      commits: [],
      updatedAt: Date.now(),
    }
  }

  private countRecords(records: readonly ContextTranscriptRecord[]): number {
    return this.tokenCounter.countMessages(
      records
        .filter(
          (record) =>
            isMessageRecord(record) || isContextCollapseSummaryRecord(record)
        )
        .map((record) => ({
          role: record.role,
          content: record.content,
        })) as UnifiedMessage[]
    )
  }

  private isValidCommit(value: unknown): value is ContextCollapseCommit {
    if (!value || typeof value !== "object") return false
    const commit = value as ContextCollapseCommit
    return (
      typeof commit.id === "string" &&
      Array.isArray(commit.archivedRecordIds) &&
      commit.archivedRecordIds.length > 0 &&
      typeof commit.summaryRecordId === "string" &&
      typeof commit.summary === "string"
    )
  }
}
