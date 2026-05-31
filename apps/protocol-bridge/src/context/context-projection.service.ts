import { Injectable } from "@nestjs/common"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import {
  getActiveCompactCommitFromTranscript,
  getRecordsAfterCompactBoundary,
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isContextCollapseSummaryRecord,
  isAttachmentRecord,
  isHookResultRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
  renderCompactBoundary,
  renderCompactSummary,
  renderContextCollapseSummary,
} from "./context-transcript-events"
import { ContextCollapseService } from "./context-collapse.service"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextTranscriptRecord,
  ProjectedContextMessage,
} from "./types"

@Injectable()
export class ContextProjectionService {
  constructor(
    private readonly attachments: ContextAttachmentBuilderService,
    private readonly contextCollapse: ContextCollapseService
  ) {}

  project(
    state: ContextConversationState,
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
      recordsOverride?: readonly ContextTranscriptRecord[]
    }
  ): ProjectedContextMessage[] {
    const sourceRecords = options?.recordsOverride || state.records
    const compactSlice = getRecordsAfterCompactBoundary(sourceRecords)
    const collapsedSlice = this.contextCollapse.projectRecords(
      state,
      compactSlice
    )
    const projected = collapsedSlice.flatMap((record) =>
      this.projectRecord(record)
    )
    const activeCommit = getActiveCompactCommitFromTranscript(sourceRecords)
    const hasPostCompactAttachments = compactSlice.some(isAttachmentRecord)
    const liveAttachments =
      options?.attachmentSnapshot && !hasPostCompactAttachments
        ? this.attachments.buildAttachments(options.attachmentSnapshot, {
            maxTokens: options.attachmentTokenBudget,
          })
        : []

    return [
      ...projected,
      ...this.buildAttachmentMessages(liveAttachments, activeCommit?.id),
    ]
  }

  getActiveCommit(
    state: ContextConversationState
  ): ContextCompactionCommit | undefined {
    return getActiveCompactCommitFromTranscript(state.records)
  }

  renderCompactionBoundary(commit: ContextCompactionCommit): string {
    return renderCompactBoundary(commit)
  }

  renderCompactionSummary(commit: ContextCompactionCommit): string {
    return renderCompactSummary(commit)
  }

  private projectRecord(
    record: ContextTranscriptRecord
  ): ProjectedContextMessage[] {
    if (isMessageRecord(record)) {
      return [
        {
          role: record.role,
          content: record.content,
          source: "record",
          recordId: record.id,
          // Carry the Anthropic split-sibling key through compaction so
          // send-time mergeAssistantMessagesById can fold siblings.
          // Undefined for assistant rows persisted before commit 17b66d3
          // and for every user record (Anthropic only mints message.id
          // on assistant turns).
          ...(record.messageId ? { messageId: record.messageId } : {}),
        },
      ]
    }

    if (isCompactBoundaryRecord(record)) {
      const commit = record.compactMetadata?.commit
      return [
        {
          role: "user",
          content:
            typeof record.content === "string"
              ? record.content
              : commit
                ? renderCompactBoundary(commit)
                : "Conversation compacted",
          source: "boundary",
          // Compaction boundaries are infrastructure plumbing, not user
          // turns. cc utils/messages.ts:484 + bridge/bridgeMessaging.ts:117
          // hide isMeta user messages from the IDE-facing transcript.
          isMeta: true,
          commitId: commit?.id,
          recordId: record.id,
          compactionEvent: commit
            ? {
                type: "boundary",
                commitId: commit.id,
                epoch: commit.epoch,
                parentCompactionId: commit.parentCompactionId,
                archivedThroughRecordId: commit.archivedThroughRecordId,
                sourceTokenCount: commit.sourceTokenCount,
                projectedTokenCount: commit.projectedTokenCount,
              }
            : undefined,
        },
      ]
    }

    if (isCompactSummaryRecord(record)) {
      const commit = record.compactMetadata?.commit
      return [
        {
          role: "user",
          content:
            typeof record.content === "string"
              ? record.content
              : commit
                ? renderCompactSummary(commit)
                : "",
          source: "summary",
          // Compaction-summary user messages are infrastructure plumbing.
          isMeta: true,
          commitId: commit?.id,
          recordId: record.id,
          compactionEvent: commit
            ? {
                type: "summary",
                commitId: commit.id,
                epoch: commit.epoch,
                parentCompactionId: commit.parentCompactionId,
                archivedThroughRecordId: commit.archivedThroughRecordId,
                summaryTokenCount: commit.summaryTokenCount,
                sourceTokenCount: commit.sourceTokenCount,
                projectedTokenCount: commit.projectedTokenCount,
              }
            : undefined,
        },
      ]
    }

    if (isContextCollapseSummaryRecord(record)) {
      const commit = record.contextCollapseMetadata?.commit
      return [
        {
          role: "user",
          content:
            typeof record.content === "string"
              ? record.content
              : commit
                ? renderContextCollapseSummary(commit)
                : "",
          source: "context_collapse",
          isMeta: true,
          commitId: commit?.id,
          recordId: record.id,
        },
      ]
    }

    if (isSnipBoundaryRecord(record)) {
      // Carry the heuristic snip summary forward as a user-visible message
      // when the boundary has one. Without this, snipped history would
      // disappear silently and the model would re-explore the same files
      // on the next turn. Boundaries persisted before summaries existed
      // (or stripped by an older flow) still drop through as before so
      // we don't pollute history with the bare "Context snipped"
      // placeholder.
      const summary = record.snipMetadata?.summary?.trim()
      if (summary) {
        return [
          {
            role: "user",
            content:
              typeof record.content === "string" ? record.content : summary,
            source: "snip",
            recordId: record.id,
          },
        ]
      }
      return []
    }
    if (isMicrocompactBoundaryRecord(record)) {
      return []
    }

    if (isAttachmentRecord(record)) {
      return [
        {
          role: "user",
          content: record.content,
          source: "attachment",
          // Attachment records are infrastructure plumbing — file
          // contents / diff snippets the IDE injects so the model has
          // working context. cc has no exact mirror here (its attachment
          // surface lives in the prompt template, not the message
          // stream), but isMeta is the closest semantic match for
          // "synthesised, hide from transcript".
          isMeta: true,
          recordId: record.id,
          attachmentKind: record.attachmentMetadata?.kind,
        },
      ]
    }

    if (isHookResultRecord(record)) {
      return [
        {
          role: "user",
          content: record.content,
          source: "hook",
          // Hook results are user-defined script output injected for the
          // model's benefit, not user input. Mirrors cc's PreToolUse /
          // PostToolUse hook injection (settings.json hooks contract).
          isMeta: true,
          recordId: record.id,
          commitId: record.hookMetadata?.compactionId,
        },
      ]
    }

    return []
  }

  private buildAttachmentMessages(
    attachments: ReturnType<
      ContextAttachmentBuilderService["buildAttachments"]
    >,
    commitId?: string
  ): ProjectedContextMessage[] {
    return attachments.map((attachment) => ({
      role: "user" as const,
      content: attachment.content,
      source: "attachment" as const,
      // Same reasoning as the attachment-record branch above.
      isMeta: true,
      commitId,
      attachmentKind: attachment.kind,
    }))
  }
}
