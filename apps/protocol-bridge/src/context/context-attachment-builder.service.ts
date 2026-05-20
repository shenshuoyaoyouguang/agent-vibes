import { Injectable } from "@nestjs/common"
import { TokenCounterService } from "./token-counter.service"
import type {
  ContextProjectionAttachment,
  InvestigationMemorySummaryLike,
} from "./types"

export interface SessionTodoAttachmentLike {
  content: string
  status: string
}

// Re-export for convenient import by downstream consumers.
export type { InvestigationMemorySummaryLike } from "./types"

export interface ContextAttachmentSnapshot {
  readPaths: string[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  todos: SessionTodoAttachmentLike[]
  investigationSummaries?: InvestigationMemorySummaryLike[]
  /**
   * Snapshots of every foreground sub-agent currently running on the
   * conversation. Multiple entries appear when the parent dispatched
   * several `task` tool calls in the same batch (cf.
   * `dispatchPreparedToolBatch`). Empty array when no sub-agent is
   * active.
   */
  activeSubAgents?: Array<{
    subagentId: string
    model: string
    turnCount: number
    toolCallCount: number
    modifiedFiles: string[]
    pendingToolCallIds: string[]
  }>
}

@Injectable()
export class ContextAttachmentBuilderService {
  private readonly TOTAL_ATTACHMENT_BUDGET = 2200
  private readonly MAX_ATTACHMENT_TOKENS = 700
  private readonly INVESTIGATION_MEMORY_MAX_ATTACHMENT_TOKENS = 1500
  private readonly INVESTIGATION_MEMORY_MAX_ITEMS = 6
  private readonly INVESTIGATION_MEMORY_MAX_DETAIL_TOKENS = 420
  /** Per-snapshot caps for the file-content attachment. */
  private readonly FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS = 1600
  private readonly FILE_SNAPSHOT_MAX_FILES = 5
  private readonly FILE_SNAPSHOT_MAX_TOKENS_PER_FILE = 320
  private readonly FILE_SNAPSHOT_MAX_LINES_PER_FILE = 80

  constructor(private readonly tokenCounter: TokenCounterService) {}

  buildAttachments(
    snapshot: ContextAttachmentSnapshot,
    options?: { maxTokens?: number }
  ): ContextProjectionAttachment[] {
    const budget = Math.max(
      options?.maxTokens || this.TOTAL_ATTACHMENT_BUDGET,
      0
    )
    if (budget <= 0) return []

    // Attachment priority: investigation memory is placed first because it
    // captures distilled evidence from the current agent turn.  When the total
    // attachment budget is tight, earlier candidates consume budget first and
    // later ones are dropped — so ordering encodes importance.
    const candidates: Array<ContextProjectionAttachment | null> = [
      this.buildInvestigationMemoryAttachment(snapshot),
      this.buildSubAgentAttachment(snapshot),
      this.buildTodosAttachment(snapshot),
      this.buildFileSnapshotsAttachment(snapshot),
      this.buildFileStatesAttachment(snapshot),
      this.buildReadPathsAttachment(snapshot),
    ]

    const attachments: ContextProjectionAttachment[] = []
    let consumed = 0

    for (const candidate of candidates) {
      if (!candidate) continue
      if (candidate.tokenCount <= 0) continue
      if (consumed + candidate.tokenCount > budget) continue
      attachments.push(candidate)
      consumed += candidate.tokenCount
    }

    return attachments
  }

  // Investigation memory is rendered as a stable attachment instead of being
  // appended to the live system prompt, so backends like Codex can treat it as
  // part of the projected context/fingerprint path rather than a per-turn hack.
  //
  // Budget-aware construction: items are evaluated newest-first so that when
  // the token budget is tight, older (less relevant) items are dropped while
  // the most recent evidence and the footer instruction are always preserved.
  private buildInvestigationMemoryAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const summaries = snapshot.investigationSummaries || []
    if (summaries.length === 0) return null

    const footer =
      "Prefer synthesizing from this collected evidence instead of repeating equivalent investigative tool calls."

    // Reserve tokens for the footer so it is never truncated.  The header
    // line is added by buildAttachment and accounted for when that method
    // trims body to maxTokens, so we do not reserve it here to avoid
    // double-counting.
    const reservedTokens = this.tokenCounter.countText(footer) + 2 // separators
    const itemBudget = Math.max(
      0,
      this.INVESTIGATION_MEMORY_MAX_ATTACHMENT_TOKENS - reservedTokens
    )

    // Evaluate from newest to oldest so the most recent evidence survives
    // budget constraints.  We collect in reverse, then flip for display.
    const recent = summaries.slice(-this.INVESTIGATION_MEMORY_MAX_ITEMS)
    const selected: string[] = []
    let consumedTokens = 0

    for (let i = recent.length - 1; i >= 0; i--) {
      const summary = recent[i]!
      const detailText = this.trimToBudget(
        summary.details?.trim() || "",
        this.INVESTIGATION_MEMORY_MAX_DETAIL_TOKENS
      )
      // Use a temporary marker; real numbering is assigned after reversal.
      const itemText = detailText
        ? `- ${summary.label}\n${detailText}`
        : `- ${summary.label}`
      const itemTokens = this.tokenCounter.countText(itemText)
      if (consumedTokens + itemTokens > itemBudget) break
      selected.push(itemText)
      consumedTokens += itemTokens
    }

    if (selected.length === 0) return null

    // Restore chronological order and assign stable numbering.
    selected.reverse()
    const numberedLines = selected
      .map((line, index) => line.replace(/^- /, `${index + 1}. `))
      .join("\n\n")

    return this.buildAttachment(
      "investigation_memory",
      "Investigation Memory",
      [numberedLines, footer].filter(Boolean).join("\n\n"),
      this.INVESTIGATION_MEMORY_MAX_ATTACHMENT_TOKENS
    )
  }

  private buildReadPathsAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.readPaths.length === 0) return null

    const lines = snapshot.readPaths
      .slice(-20)
      .map((path) => `- ${path}`)
      .join("\n")

    return this.buildAttachment("read_paths", "Recently Read Files", lines)
  }

  private buildSubAgentAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    const subAgents = snapshot.activeSubAgents
    if (!subAgents || subAgents.length === 0) return null

    const sections: string[] = []
    for (const subAgent of subAgents) {
      const lines = [
        `- Sub-agent: ${subAgent.subagentId}`,
        `- Model: ${subAgent.model}`,
        `- Completed turns: ${subAgent.turnCount}`,
        `- Tool calls: ${subAgent.toolCallCount}`,
      ]
      if (subAgent.pendingToolCallIds.length > 0) {
        lines.push(
          `- Waiting on tools: ${subAgent.pendingToolCallIds.join(", ")}`
        )
      }
      if (subAgent.modifiedFiles.length > 0) {
        lines.push(
          ...subAgent.modifiedFiles
            .slice(-10)
            .map((filePath) => `- Modified file: ${filePath}`)
        )
      }
      sections.push(lines.join("\n"))
    }

    const heading =
      subAgents.length === 1
        ? "Active Sub-Agent"
        : `Active Sub-Agents (${subAgents.length})`
    return this.buildAttachment("sub_agent", heading, sections.join("\n\n"))
  }

  private buildFileStatesAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.fileStates.length === 0) return null

    const lines = snapshot.fileStates
      .slice(-10)
      .map((state) => {
        const beforeLines = state.beforeContent.split("\n").length
        const afterLines = state.afterContent.split("\n").length
        const delta = afterLines - beforeLines
        const changeLabel =
          delta === 0 ? "0 lines" : `${delta > 0 ? "+" : ""}${delta} lines`
        return `- ${state.path} (${changeLabel})`
      })
      .join("\n")

    return this.buildAttachment("file_states", "Tracked File Changes", lines)
  }

  /**
   * Render the most-recent file edits as an inline content snapshot so that
   * after a compaction the model still has direct visibility into the files
   * it was actively changing.  Without this attachment the post-compact turn
   * has to issue redundant read_file calls just to recover the same context.
   *
   * Each file is bounded both in lines and tokens so a single huge file
   * cannot starve the rest of the snapshot.  We always render the
   * post-edit (`afterContent`) view because that is what a follow-up
   * tool call would observe on disk.
   */
  private buildFileSnapshotsAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.fileStates.length === 0) return null

    const recentFiles = snapshot.fileStates.slice(-this.FILE_SNAPSHOT_MAX_FILES)
    const sections: string[] = []
    let consumedTokens = 0

    // Newest-first selection so the most recently touched file is least
    // likely to be dropped under tight budgets.  Re-render in chronological
    // order at the end for stable output.
    const reversed = [...recentFiles].reverse()
    for (const state of reversed) {
      if (consumedTokens >= this.FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS) break
      const remainingBudget =
        this.FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS - consumedTokens
      const perFileBudget = Math.min(
        this.FILE_SNAPSHOT_MAX_TOKENS_PER_FILE,
        remainingBudget
      )
      const section = this.renderFileSnapshotSection(
        state.path,
        state.afterContent,
        perFileBudget
      )
      if (!section) continue
      const sectionTokens = this.tokenCounter.countText(section)
      if (sectionTokens <= 0) continue
      if (consumedTokens + sectionTokens > remainingBudget) continue
      sections.push(section)
      consumedTokens += sectionTokens
    }

    if (sections.length === 0) return null
    sections.reverse()

    return this.buildAttachment(
      "file_snapshots",
      "Recent File Snapshots",
      sections.join("\n\n"),
      this.FILE_SNAPSHOT_MAX_ATTACHMENT_TOKENS
    )
  }

  private renderFileSnapshotSection(
    path: string,
    content: string,
    maxTokens: number
  ): string {
    const trimmedContent = content.replace(/\s+$/u, "")
    if (!trimmedContent) {
      return `- ${path}\n  (empty)`
    }

    const allLines = trimmedContent.split("\n")
    const totalLines = allLines.length
    const keptLines = allLines.slice(0, this.FILE_SNAPSHOT_MAX_LINES_PER_FILE)
    const truncatedByLines = keptLines.length < totalLines
    const body = keptLines.join("\n")
    const headerLines: string[] = [`- ${path} (${totalLines} lines total)`]

    let snippet = `${headerLines.join("\n")}\n\u0060\u0060\u0060\n${body}\n\u0060\u0060\u0060`
    if (truncatedByLines) {
      snippet += `\n  ... [truncated to first ${keptLines.length} of ${totalLines} lines]`
    }

    if (this.tokenCounter.countText(snippet) <= maxTokens) {
      return snippet
    }

    // Token-aware fallback: shrink line count exponentially until it fits.
    let candidateLineCount = keptLines.length
    while (candidateLineCount > 4) {
      candidateLineCount = Math.max(4, Math.floor(candidateLineCount * 0.7))
      const candidateLines = allLines.slice(0, candidateLineCount)
      const candidate =
        `- ${path} (${totalLines} lines total)\n` +
        `\u0060\u0060\u0060\n${candidateLines.join("\n")}\n\u0060\u0060\u0060\n` +
        `  ... [truncated to first ${candidateLineCount} of ${totalLines} lines]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }
    return ""
  }

  private buildTodosAttachment(
    snapshot: ContextAttachmentSnapshot
  ): ContextProjectionAttachment | null {
    if (snapshot.todos.length === 0) return null

    const lines = snapshot.todos
      .slice(-20)
      .map((todo) => `- [${todo.status}] ${todo.content}`)
      .join("\n")

    return this.buildAttachment("todos", "Todo State", lines)
  }

  private buildAttachment(
    kind: ContextProjectionAttachment["kind"],
    label: string,
    body: string,
    maxTokens?: number
  ): ContextProjectionAttachment {
    const budget = maxTokens ?? this.MAX_ATTACHMENT_TOKENS
    const header = `[Context attachment: ${label}]`
    const content = `${header}\n${this.trimToBudget(body, budget)}`
    return {
      kind,
      label,
      content,
      tokenCount: this.tokenCounter.countText(content),
    }
  }

  private trimToBudget(text: string, maxTokens: number): string {
    const value = text.trim()
    if (!value) return value

    if (this.tokenCounter.countText(value) <= maxTokens) {
      return value
    }

    let end = value.length
    while (end > 64) {
      end = Math.floor(end * 0.8)
      const candidate = `${value.slice(0, end).trim()}\n...[truncated]`
      if (this.tokenCounter.countText(candidate) <= maxTokens) {
        return candidate
      }
    }

    return "...[truncated]"
  }
}
