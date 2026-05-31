import { Injectable, Logger } from "@nestjs/common"
import type { BackendType } from "../llm/shared/model-router.service"
import { getBackendCapability } from "../llm/shared/backend-capability"
import { TokenCounterService } from "./token-counter.service"
import { ContextTelemetryService } from "./context-telemetry.service"

/**
 * A single span of model reasoning, captured from one streaming
 * `content_block_stop` (type=thinking) event. One assistant turn typically
 * produces 1-N records depending on how many thinking blocks the model
 * emits between tool batches.
 *
 * The record is bound to the producing turn / model / backend so:
 *   1. cross-model invalidation is precise (a 4.7-thinking record must not
 *      be replayed into a 4.6 turn — different reasoning style),
 *   2. cross-backend invalidation is precise (claude-api signature replay
 *      and kiro text preamble can never share the same record),
 *   3. compaction can attribute token cost back to specific turns.
 */
export interface ReasoningRecord {
  /** Stable id; used as ring-buffer dedup key. */
  id: string
  /** turn-state.turnId — the turn that produced this thinking. */
  turnId: string
  /**
   * SessionAssistantMessage.uuid of the split-sibling that carried the
   * thinking block. Lets the projection layer correlate a record with the
   * structured assistant message at send-time without re-scanning history.
   */
  assistantMessageId: string
  backend: BackendType
  model: string
  text: string
  /** Token cost of `text`, computed at capture time and cached. */
  tokens: number
  /** Tool_use ids emitted in the same content stream, after this thinking. */
  toolUseIds: readonly string[]
  /** Optional signature, if the wire format carried one (Anthropic/Google). */
  signature?: string
  capturedAt: number
}

/** Inputs accepted by ReasoningMemoryService.append. */
export interface ReasoningCapture {
  turnId: string
  assistantMessageId: string
  backend: BackendType
  model: string
  text: string
  toolUseIds?: readonly string[]
  signature?: string
}

/**
 * Hard cap on the absolute character length of a single reasoning text.
 * This is a defense-in-depth bound against pathological model outputs
 * (e.g. a thinking block that runs to 200KB), NOT the budget for what gets
 * sent on the wire. The wire-time budget is computed dynamically from the
 * remaining token budget in `buildPreamble` — see `ReasoningPreambleBudget`.
 */
const RECORD_HARD_CHAR_CAP = 64_000

/** Ring buffer capacity per conversation. Eight covers the practical
 *  long-task lookback (~8 tool batches) without leaking memory. Older
 *  records are evicted FIFO. */
const RETAIN_PER_CONVERSATION = 8

/**
 * Required inputs for projection. The caller (cursor-connect-stream
 * send-time) already owns these from the route + budget pipeline; passing
 * them in keeps ReasoningMemoryService free of any cross-module imports
 * besides BackendCapability + TokenCounter.
 */
export interface ReasoningPreambleBudget {
  /**
   * Remaining tokens available for non-message content on the next request.
   * Computed by ContextRequestPlanner / ContextCompactionService.
   * Preamble will use at most a fraction of this — see PREAMBLE_BUDGET_FRACTION.
   */
  remainingTokens: number
  /**
   * Caller's hard ceiling on preamble token cost regardless of remaining
   * tokens. Used by callers that want to bound the preamble independently
   * (e.g. when other features have first claim on the budget).
   */
  hardCeilingTokens?: number
}

/**
 * The preamble is allowed to consume up to this fraction of remaining
 * tokens. Conservative because the same budget feeds tool definitions,
 * compaction summaries, and the user's current message — preamble is one
 * of several claimants, not the primary one.
 */
const PREAMBLE_BUDGET_FRACTION = 0.15

/**
 * Lower bound: even on a tight budget, allocate at least this much for the
 * preamble or skip it entirely. Anything smaller is too noisy to be useful
 * and not worth the framing overhead.
 */
const PREAMBLE_MIN_USEFUL_TOKENS = 200

/**
 * Shingle width for the in-process recurrence detector. Word-level 5-grams
 * are the standard Broder-shingling default — small enough to catch
 * sentence-level reuse, large enough to ignore stop-word noise.
 */
const SHINGLE_WIDTH = 5

/**
 * Jaccard similarity threshold above which two records are considered
 * near-duplicate reasoning. 0.6 is the upper end of "noticeably similar"
 * by Broder's empirical study — strict enough to avoid collapsing genuine
 * but topically related reasoning, lax enough to catch the
 * "model re-thinks the same thing every turn" failure mode.
 */
const RECURRENCE_JACCARD_THRESHOLD = 0.6

export interface ReasoningPreamble {
  /** The XML-tagged text payload to splice into the next user content. */
  text: string
  /** Records that contributed to the preamble (caller may telemetry these). */
  recordsUsed: readonly ReasoningRecord[]
  /** Token cost of `text`, post-truncation. */
  tokens: number
}

/**
 * Reasoning Memory Service
 *
 * Captures thinking content as a first-class artifact at the
 * `content_block_stop` boundary, persists it per-conversation in a bounded
 * ring buffer, and projects a backend-appropriate preamble at send time.
 *
 * For `native_signature` backends (claude-api, google) this service is a
 * no-op — the structured assistant history already carries thinking
 * blocks with signatures (see
 * claude-code/src/services/api/claude.ts:2200-2300 for the upstream pattern
 * we mirror). For `text_preamble` backends (kiro, codex) where the wire
 * drops thinking, the ring buffer is the bridge-side mirror of what
 * claude-code keeps in `messages[]` — same role, different storage.
 *
 * Lifecycle:
 *   - append():            called from processAssistantTurnStream on each
 *                          content_block_stop where the closing block was
 *                          a thinking block. Single capture point — no
 *                          fallback paths that miss writes.
 *   - buildPreamble():     called from cursor-connect-stream send-time,
 *                          gated only by BackendCapability.continuityStrategy.
 *   - invalidateOnSwitch:  called when route.backend or route.model changes
 *                          mid-conversation. Mirrors the spirit of
 *                          stripSignatureBlocks but at the reasoning layer.
 *   - clear():             explicit reset (e.g. when the user starts a
 *                          fresh conversation in the same session, or when
 *                          applySendTimeSanitize detects a backend/model
 *                          transition that invalidates all prior records).
 */
@Injectable()
export class ReasoningMemoryService {
  private readonly logger = new Logger(ReasoningMemoryService.name)

  /** conversationId -> ring buffer of records (oldest first). */
  private readonly memory = new Map<string, ReasoningRecord[]>()

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly telemetry: ContextTelemetryService
  ) {}

  /** Number of stored records for a conversation (for diagnostics/tests). */
  size(conversationId: string): number {
    return this.memory.get(conversationId)?.length ?? 0
  }

  has(conversationId: string): boolean {
    return this.size(conversationId) > 0
  }

  append(conversationId: string, capture: ReasoningCapture): void {
    const text = (capture.text || "").trim()
    if (!text) return

    const trimmed =
      text.length > RECORD_HARD_CHAR_CAP
        ? text.slice(text.length - RECORD_HARD_CHAR_CAP)
        : text

    const record: ReasoningRecord = {
      id: `${capture.turnId}:${capture.assistantMessageId}`,
      turnId: capture.turnId,
      assistantMessageId: capture.assistantMessageId,
      backend: capture.backend,
      model: capture.model,
      text: trimmed,
      tokens: this.tokenCounter.countText(trimmed),
      toolUseIds: capture.toolUseIds ?? [],
      signature: capture.signature,
      capturedAt: Date.now(),
    }

    const buf = this.memory.get(conversationId) ?? []
    // Dedup by id: the same content_block_stop should never produce two
    // appends, but defensive guards against finalize / split-sibling
    // racing both calling append.
    const existingIdx = buf.findIndex((r) => r.id === record.id)
    if (existingIdx >= 0) {
      buf[existingIdx] = record
    } else {
      buf.push(record)
    }
    while (buf.length > RETAIN_PER_CONVERSATION) {
      buf.shift()
    }
    this.memory.set(conversationId, buf)

    // Recurrence detection: if the new record's reasoning is near-duplicate
    // of an immediate predecessor (same backend/model), drop the older
    // record. This is the "model re-thinks the same thing every turn"
    // mitigation — instead of letting buildPreamble inject N nearly
    // identical preambles, we keep only the newest exemplar. Comparison
    // is bounded to the immediate predecessor by design: a recurrence
    // window > 1 risks dropping legitimately related reasoning that
    // happens to share vocabulary across distant turns.
    this.compactRecurrence(conversationId, record)

    this.telemetry.recordEvent({
      event: "reasoning_memory.append",
      scope: conversationId,
      delta: 1,
      metadata: {
        backend: capture.backend,
        model: capture.model,
        tokens: record.tokens,
        bufferSize: this.memory.get(conversationId)?.length ?? 0,
      },
    })
  }

  dropByAssistantMessageIds(
    conversationId: string,
    assistantMessageIds: readonly string[],
    reason?: string
  ): number {
    const ids = new Set(assistantMessageIds.filter(Boolean))
    if (ids.size === 0) return 0

    const buf = this.memory.get(conversationId)
    if (!buf || buf.length === 0) return 0

    const kept = buf.filter((record) => !ids.has(record.assistantMessageId))
    const dropped = buf.length - kept.length
    if (dropped === 0) return 0

    if (kept.length === 0) {
      this.memory.delete(conversationId)
    } else {
      this.memory.set(conversationId, kept)
    }

    this.telemetry.recordEvent({
      event: "reasoning_memory.dropped",
      scope: conversationId,
      delta: dropped,
      metadata: {
        reason: reason ?? "unspecified",
      },
    })
    return dropped
  }

  /**
   * Drop records that don't match the upcoming send's (backend, model).
   * Called by cursor-connect-stream when route changes mid-conversation,
   * before buildPreamble. Records bound to a different backend are unsafe
   * to replay because their continuity strategy differs.
   */
  invalidateOnSwitch(
    conversationId: string,
    targetBackend: BackendType,
    targetModel: string
  ): void {
    const buf = this.memory.get(conversationId)
    if (!buf || buf.length === 0) return
    const before = buf.length
    const kept = buf.filter(
      (r) => r.backend === targetBackend && r.model === targetModel
    )
    if (kept.length === before) return
    if (kept.length === 0) {
      this.memory.delete(conversationId)
    } else {
      this.memory.set(conversationId, kept)
    }
    this.telemetry.recordEvent({
      event: "reasoning_memory.invalidated",
      scope: conversationId,
      delta: before - kept.length,
      metadata: { targetBackend, targetModel, dropped: before - kept.length },
    })
  }

  clear(conversationId: string): void {
    if (this.memory.delete(conversationId)) {
      this.telemetry.recordEvent({
        event: "reasoning_memory.cleared",
        scope: conversationId,
        delta: 1,
      })
    }
  }

  /**
   * Build the projection for the next outbound request, or return null if:
   *   - the target backend's continuityStrategy is not text_preamble
   *     (native_signature backends replay via the structured history path,
   *     none means no continuity at all),
   *   - no records exist for this conversation,
   *   - the budget is too tight to fit anything useful.
   */
  buildPreamble(
    conversationId: string,
    targetBackend: BackendType,
    targetModel: string,
    budget: ReasoningPreambleBudget
  ): ReasoningPreamble | null {
    const cap = getBackendCapability(targetBackend)
    if (cap.continuityStrategy !== "text_preamble") return null

    const buf = this.memory.get(conversationId)
    if (!buf || buf.length === 0) return null

    // Only records matching the upcoming send's (backend, model) survive.
    // This is the read-side safety net; invalidateOnSwitch is the eager path.
    const eligible = buf.filter(
      (r) => r.backend === targetBackend && r.model === targetModel
    )
    if (eligible.length === 0) return null

    const allowed = this.computeAllowedTokens(budget)
    if (allowed < PREAMBLE_MIN_USEFUL_TOKENS) {
      this.telemetry.recordEvent({
        event: "reasoning_memory.preamble_skipped",
        scope: conversationId,
        delta: 1,
        metadata: { reason: "budget_too_small", allowed },
      })
      return null
    }

    // Pack newest-first up to the allowed token budget. Newest reasoning
    // is most relevant; older records are evicted at the budget boundary,
    // not by character count.
    const packed: ReasoningRecord[] = []
    let used = 0
    for (let i = eligible.length - 1; i >= 0; i--) {
      const r = eligible[i]!
      if (used + r.tokens > allowed) break
      packed.push(r)
      used += r.tokens
    }
    if (packed.length === 0) {
      // Even the newest single record overflows the budget. Truncate it
      // from the tail (preserving the most recent reasoning) to fit.
      const newest = eligible[eligible.length - 1]!
      const truncated = this.truncateToTokens(newest.text, allowed)
      if (!truncated) return null
      const text = this.formatPreamble([
        {
          ...newest,
          text: truncated,
          tokens: this.tokenCounter.countText(truncated),
        },
      ])
      return {
        text,
        recordsUsed: [newest],
        tokens: this.tokenCounter.countText(text),
      }
    }

    // packed is newest-first; flip to chronological for readability.
    packed.reverse()
    const text = this.formatPreamble(packed)
    const tokens = this.tokenCounter.countText(text)
    this.telemetry.recordEvent({
      event: "reasoning_memory.preamble_built",
      scope: conversationId,
      delta: 1,
      metadata: {
        backend: targetBackend,
        records: packed.length,
        tokens,
        budgetAllowed: allowed,
      },
    })
    return { text, recordsUsed: packed, tokens }
  }

  /**
   * Replace a contiguous range of records with a single consolidated entry.
   * Used by reasoning-recurrence-driven compaction: when N recent records
   * carry near-duplicate reasoning (detected upstream via shingle hash),
   * upstream compresses them into one summary and calls this to commit.
   *
   * Out of scope for the initial landing of this service, but stubbed so
   * the compaction layer has an integration point that doesn't reach into
   * private state.
   */
  consolidate(
    conversationId: string,
    replaceIds: readonly string[],
    consolidated: ReasoningCapture
  ): void {
    const buf = this.memory.get(conversationId)
    if (!buf || buf.length === 0) return
    const replaceSet = new Set(replaceIds)
    const filtered = buf.filter((r) => !replaceSet.has(r.id))
    if (filtered.length === buf.length) return
    this.memory.set(conversationId, filtered)
    this.append(conversationId, consolidated)
    this.telemetry.recordEvent({
      event: "reasoning_memory.consolidated",
      scope: conversationId,
      delta: replaceIds.length,
    })
  }

  /** Read-only snapshot for tests / diagnostics. */
  snapshot(conversationId: string): readonly ReasoningRecord[] {
    return this.memory.get(conversationId) ?? []
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Drop the immediate predecessor record if its reasoning is near-duplicate
   * of `incoming` (same backend/model). Keeps the newer record because:
   *   - it carries the latest model state (more relevant to next turn),
   *   - upstream tools may have produced new evidence that subtly shifted
   *     the conclusion even if the surface text is similar.
   *
   * O(window * shingle_count) where window=1, so O(text_len) per call.
   */
  private compactRecurrence(
    conversationId: string,
    incoming: ReasoningRecord
  ): void {
    const buf = this.memory.get(conversationId)
    if (!buf || buf.length < 2) return
    const incomingIdx = buf.findIndex((r) => r.id === incoming.id)
    if (incomingIdx <= 0) return
    const predecessor = buf[incomingIdx - 1]!
    if (predecessor.backend !== incoming.backend) return
    if (predecessor.model !== incoming.model) return

    const sim = this.shingleJaccard(predecessor.text, incoming.text)
    if (sim < RECURRENCE_JACCARD_THRESHOLD) return

    // Drop the predecessor; the buffer order is preserved otherwise.
    buf.splice(incomingIdx - 1, 1)
    this.memory.set(conversationId, buf)
    this.telemetry.recordEvent({
      event: "reasoning_memory.consolidated",
      scope: conversationId,
      delta: 1,
      metadata: {
        droppedRecordId: predecessor.id,
        keptRecordId: incoming.id,
        jaccard: Number(sim.toFixed(3)),
      },
    })
  }

  /**
   * Word-level n-gram Jaccard similarity. Cheap (O(|tokens|)) and good
   * enough to catch the "same reasoning, slightly reworded" case that
   * drives the recurrence problem. Symmetric, range [0, 1].
   */
  private shingleJaccard(a: string, b: string): number {
    const sa = this.shingleSet(a)
    const sb = this.shingleSet(b)
    if (sa.size === 0 || sb.size === 0) return 0
    let intersection = 0
    const smaller = sa.size <= sb.size ? sa : sb
    const larger = smaller === sa ? sb : sa
    for (const s of smaller) {
      if (larger.has(s)) intersection++
    }
    const union = sa.size + sb.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  private shingleSet(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0)
    if (tokens.length < SHINGLE_WIDTH) {
      return new Set(tokens.length ? [tokens.join(" ")] : [])
    }
    const out = new Set<string>()
    for (let i = 0; i <= tokens.length - SHINGLE_WIDTH; i++) {
      out.add(tokens.slice(i, i + SHINGLE_WIDTH).join(" "))
    }
    return out
  }

  private computeAllowedTokens(budget: ReasoningPreambleBudget): number {
    const fraction = Math.floor(
      Math.max(0, budget.remainingTokens) * PREAMBLE_BUDGET_FRACTION
    )
    if (budget.hardCeilingTokens === undefined) return fraction
    return Math.min(fraction, Math.max(0, budget.hardCeilingTokens))
  }

  private truncateToTokens(text: string, allowedTokens: number): string {
    if (allowedTokens <= 0) return ""
    // Binary search by character length until tokens fit. The tokenizer is
    // not strictly char-monotonic but close enough for a tail-keep slice.
    let lo = 0
    let hi = text.length
    let best = ""
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const candidate = text.slice(text.length - mid)
      const t = this.tokenCounter.countText(candidate)
      if (t <= allowedTokens) {
        best = candidate
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return best
  }

  private formatPreamble(records: readonly ReasoningRecord[]): string {
    const lines: string[] = ["<previous_thinking>"]
    for (const r of records) {
      lines.push(r.text.trim())
      lines.push("---")
    }
    // Drop the trailing separator.
    if (lines[lines.length - 1] === "---") lines.pop()
    lines.push("</previous_thinking>")
    return lines.join("\n") + "\n\n"
  }
}
