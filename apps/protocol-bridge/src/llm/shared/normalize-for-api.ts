/**
 * Send-time normalization pipeline for outbound messages.
 *
 * Mirrors `claude-code/src/utils/messages.ts:normalizeMessagesForAPI`
 * (lines 2275-2666), adapted for agent-vibes' multi-backend routing
 * (Anthropic / Kiro / Google CodeAssist / Codex / OpenAI-compat).
 *
 * # Why this lives at send time, not write time
 *
 * The session SQLite mirror retains every block — including thinking —
 * verbatim so the Cursor IDE can replay the model's reasoning. Filtering and
 * merging happen only when projecting `SessionMessage[]` onto an outbound
 * DTO, where backend-specific constraints kick in (Anthropic requires signed
 * thinking; Kiro/Codex/Google have no thinking slot at all).
 *
 * # Pipeline (11 stages, mirroring cc messages.ts)
 *
 *   1. `reorderAttachmentsForAPI`             — bubble attachments up
 *   2. `mergeAssistantMessages` (by id)       — fold split-siblings
 *   3. `mergeAdjacentUserMessages`            — collapse consecutive users
 *   4. `relocateToolReferenceSiblings`        — disabled; placeholder for
 *                                                future tool-search beta
 *   5. `filterOrphanedThinkingOnlyMessages`   — id-aware orphan filter
 *   6. `filterTrailingThinkingFromLastAssistant`
 *   7. `filterWhitespaceOnlyAssistantMessages`
 *   8. `ensureNonEmptyAssistantContent`
 *   9. `sanitizeErrorToolResultContent`
 *  10. `hoistToolResults` (per user message)  — tool_results come first
 *  11. backend-specific thinking handling     — strip / prune-by-signature
 *
 * Stage 11 is the only backend-aware pass; stages 1-10 produce the shape
 * that the Anthropic API expects, and the backend-specific layer below
 * adapts to other vendors.
 *
 * # Output shape
 *
 * The pipeline emits `UnifiedMessage[]` (`{role, content}` flat form,
 * `context/types.ts:121-134`). That matches the contract the per-backend
 * translators (`anthropic-api.service.ts`, `aws/translator.ts`, …) already
 * consume, so wiring this in at `applySendTimeSanitize` is a drop-in change.
 */

import type {
  ContentBlock,
  LooseMessageContent,
  UnifiedMessage,
} from "../../context/types"
import type { SessionMessage } from "../../protocol/cursor/session/session-lifecycle.service"

/** Backends that may need thinking handling on the wire. */
export type SanitizeBackend =
  | "anthropic"
  | "kiro"
  | "google"
  | "codex"
  | "openai-compat"

export interface NormalizeOptions {
  backend: SanitizeBackend
  /**
   * Anthropic-only: when the active credential explicitly opts out of
   * extended-thinking pass-through (e.g. an account with
   * `stripThinking=true`), strip every thinking block regardless of
   * signature. For non-anthropic backends this flag is ignored — those
   * backends always strip.
   */
  stripThinking?: boolean
  /**
   * Run an extra `stripSignatureBlocks` pass even on Anthropic. Used when
   * the caller detects a model / credential switch and needs to invalidate
   * every previously-issued signature (mirrors
   * claude-code/src/query.ts:1167-1172).
   */
  forceStripSignatures?: boolean
  /**
   * Available tool names — currently unused; reserved for future tool
   * normalization (cc messages.ts:2280, 2390-2397). The signature is kept
   * so callers don't need to plumb the option in retroactively.
   */
  tools?: ReadonlyArray<{ name: string }>
}

// ---------------------------------------------------------------------------
// Working types: an internal flat envelope we shuttle through the pipeline.
// ---------------------------------------------------------------------------

interface FlatAssistant {
  type: "assistant"
  uuid: string
  /** Anthropic message id — split-sibling merge key. */
  messageId?: string
  content: LooseMessageContent
}

interface FlatUser {
  type: "user"
  uuid: string
  isMeta?: boolean
  content: LooseMessageContent
}

type FlatMessage = FlatAssistant | FlatUser

function lift(messages: ReadonlyArray<SessionMessage>): FlatMessage[] {
  const out: FlatMessage[] = []
  for (const msg of messages) {
    if (msg.type === "assistant") {
      out.push({
        type: "assistant",
        uuid: msg.uuid,
        messageId: msg.message.id,
        content: msg.message.content,
      })
    } else {
      out.push({
        type: "user",
        uuid: msg.uuid,
        isMeta: msg.isMeta,
        content: msg.message.content,
      })
    }
  }
  return out
}

function project(messages: ReadonlyArray<FlatMessage>): UnifiedMessage[] {
  const out: UnifiedMessage[] = []
  for (const msg of messages) {
    out.push({
      role: msg.type === "assistant" ? "assistant" : "user",
      content: msg.content as string | ContentBlock[],
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Block predicates
// ---------------------------------------------------------------------------

interface BlockLike {
  type: string
  [key: string]: unknown
}

function asBlocks(content: LooseMessageContent): BlockLike[] | null {
  if (!Array.isArray(content)) return null
  return content as BlockLike[]
}

/** True for thinking / redacted_thinking blocks. */
export function isThinkingBlock(
  block: unknown
): block is BlockLike & { type: "thinking" | "redacted_thinking" } {
  if (!block || typeof block !== "object") return false
  const type = (block as { type?: unknown }).type
  return type === "thinking" || type === "redacted_thinking"
}

function blocksHaveToolReference(content: LooseMessageContent): boolean {
  const blocks = asBlocks(content)
  if (!blocks) return false
  return blocks.some((b) => {
    if (b.type !== "tool_result") return false
    const inner = (b as { content?: unknown }).content
    if (!Array.isArray(inner)) return false
    return (inner as Array<{ type?: string }>).some(
      (c) => c?.type === "tool_reference"
    )
  })
}

// ---------------------------------------------------------------------------
// 1. reorderAttachmentsForAPI
// ---------------------------------------------------------------------------

/**
 * In claude-code, `reorderAttachmentsForAPI` (messages.ts:1758-1805) bubbles
 * standalone `attachment` messages up so they land just below the next
 * assistant or tool_result-bearing user message. agent-vibes never produces
 * an envelope with `type: "attachment"` — images and other assets are
 * inlined into user content blocks at write time, so the input is already
 * in the right order. We keep the named pass so the pipeline reads as a
 * faithful mirror of cc and any future attachment envelope drops in here.
 */
export function reorderAttachmentsForAPI(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  return [...messages]
}

// ---------------------------------------------------------------------------
// 2. mergeAssistantMessages — split-sibling merge by message.id
// ---------------------------------------------------------------------------

function isToolResultUser(msg: FlatMessage): boolean {
  if (msg.type !== "user") return false
  const blocks = asBlocks(msg.content)
  if (!blocks) return false
  return blocks.some((b) => b.type === "tool_result")
}

function concatContent(
  a: LooseMessageContent,
  b: LooseMessageContent
): LooseMessageContent {
  const aBlocks = asBlocks(a) ?? toTextBlocks(a)
  const bBlocks = asBlocks(b) ?? toTextBlocks(b)
  return [...aBlocks, ...bBlocks]
}

function toTextBlocks(content: LooseMessageContent): BlockLike[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }
  if (Array.isArray(content)) {
    return content as BlockLike[]
  }
  return []
}

/**
 * Merge two assistant messages with the same `message.id`. Mirrors
 * cc messages.ts:2689-2703 — content arrays are concatenated; the surviving
 * envelope keeps `a`'s identity (uuid first seen wins).
 */
export function mergeAssistantMessages(
  a: FlatAssistant,
  b: FlatAssistant
): FlatAssistant {
  return {
    ...a,
    content: concatContent(a.content, b.content),
  }
}

/**
 * Walk the array left-to-right; for each assistant, look back over the most
 * recent run of assistants and tool_result users to find a sibling sharing
 * the same `message.id`, and merge into it. Concurrent agents (in cc, the
 * "teammate" case) can interleave streaming blocks with different message
 * ids, hence the bounded backward walk.
 */
function mergeAssistantMessagesById(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  const result: FlatMessage[] = []
  for (const msg of messages) {
    if (msg.type !== "assistant") {
      result.push(msg)
      continue
    }
    if (!msg.messageId) {
      result.push(msg)
      continue
    }
    let merged = false
    for (let i = result.length - 1; i >= 0; i--) {
      const candidate = result[i]!
      if (candidate.type !== "assistant" && !isToolResultUser(candidate)) {
        break
      }
      if (
        candidate.type === "assistant" &&
        candidate.messageId === msg.messageId
      ) {
        result[i] = mergeAssistantMessages(candidate, msg)
        merged = true
        break
      }
    }
    if (!merged) result.push(msg)
  }
  return result
}

// ---------------------------------------------------------------------------
// 3. mergeUserMessages / mergeAdjacentUserMessages
// ---------------------------------------------------------------------------

function joinTextAtSeam(a: BlockLike[], b: BlockLike[]): BlockLike[] {
  if (a.length === 0) return [...b]
  if (b.length === 0) return [...a]
  const aTail = a[a.length - 1]
  const bHead = b[0]
  // The Anthropic API concatenates adjacent text blocks in a single user
  // message without a separator, so two queued prompts `"2 + 2"` + `"3 + 3"`
  // would otherwise reach the model as `"2 + 23 + 3"`. Insert `\n` at the
  // seam when both sides are text. cc messages.ts:2810ish.
  if (
    aTail &&
    bHead &&
    aTail.type === "text" &&
    bHead.type === "text" &&
    typeof (aTail as { text?: unknown }).text === "string" &&
    typeof (bHead as { text?: unknown }).text === "string"
  ) {
    const joinedHead: BlockLike = {
      ...aTail,
      text:
        (aTail as unknown as { text: string }).text +
        "\n" +
        (bHead as unknown as { text: string }).text,
    }
    return [...a.slice(0, -1), joinedHead, ...b.slice(1)]
  }
  return [...a, ...b]
}

/**
 * Merge two user messages. Mirrors cc messages.ts:2716-2758 minus snip
 * runtime. Tool results in the merged content always sort first via
 * hoistToolResults to keep the API happy.
 */
export function mergeUserMessages(a: FlatUser, b: FlatUser): FlatUser {
  const aBlocks = toTextBlocks(a.content)
  const bBlocks = toTextBlocks(b.content)
  const joined = joinTextAtSeam(aBlocks, bBlocks)
  const merged = hoistToolResults(joined)
  return {
    ...a,
    // If `a` is meta and `b` is not, the merged message represents real
    // user content; surface b's uuid so downstream consumers (e.g. id tags)
    // bind to the visible turn.
    uuid: a.isMeta && !b.isMeta ? b.uuid : a.uuid,
    isMeta: a.isMeta && b.isMeta ? true : undefined,
    content: merged,
  }
}

function mergeAdjacentUserMessages(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  const out: FlatMessage[] = []
  for (const msg of messages) {
    const prev = out.at(-1)
    if (msg.type === "user" && prev?.type === "user") {
      out[out.length - 1] = mergeUserMessages(prev, msg)
    } else {
      out.push(msg)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. hoistToolResults — per-user-message
// ---------------------------------------------------------------------------

/**
 * Within a user message, tool_result blocks must come first; otherwise the
 * Anthropic API rejects the request with "tool result must follow tool
 * use". Mirrors cc messages.ts:2779-2792.
 */
export function hoistToolResults(content: BlockLike[]): BlockLike[] {
  const toolResults: BlockLike[] = []
  const others: BlockLike[] = []
  for (const block of content) {
    if (block.type === "tool_result") toolResults.push(block)
    else others.push(block)
  }
  if (toolResults.length === 0 || others.length === 0) return content
  return [...toolResults, ...others]
}

function hoistInUserMessages(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  let changed = false
  const result = messages.map((msg) => {
    if (msg.type !== "user") return msg
    const blocks = asBlocks(msg.content)
    if (!blocks) return msg
    const hoisted = hoistToolResults(blocks)
    if (hoisted === blocks) return msg
    changed = true
    return { ...msg, content: hoisted }
  })
  return changed ? result : (messages as FlatMessage[])
}

// ---------------------------------------------------------------------------
// 5. relocateToolReferenceSiblings — feature-gated off, kept as no-op
// ---------------------------------------------------------------------------

/**
 * cc messages.ts:2219-2273: when a tool_result contains a tool_reference
 * block, text siblings on the same user message create an anomalous
 * two-consecutive-human-turns pattern. The fix is to move the text siblings
 * to a later non-reference tool_result message. agent-vibes does not enable
 * the tool-search beta, so tool_reference blocks are not produced — this
 * pass is a no-op. Kept named for parity with the cc pipeline.
 */
export function relocateToolReferenceSiblings(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  // Only run if any user message actually carries a tool_reference; the
  // common case is empty so we exit cheaply.
  if (
    !messages.some(
      (m) => m.type === "user" && blocksHaveToolReference(m.content)
    )
  ) {
    return [...messages]
  }
  const result = [...messages]
  for (let i = 0; i < result.length; i++) {
    const msg = result[i]!
    if (msg.type !== "user") continue
    if (!blocksHaveToolReference(msg.content)) continue
    const blocks = asBlocks(msg.content)
    if (!blocks) continue
    const textSiblings = blocks.filter((b) => b.type === "text")
    if (textSiblings.length === 0) continue
    let targetIdx = -1
    for (let j = i + 1; j < result.length; j++) {
      const cand = result[j]!
      if (cand.type !== "user") continue
      const cb = asBlocks(cand.content)
      if (!cb) continue
      if (!cb.some((b) => b.type === "tool_result")) continue
      if (blocksHaveToolReference(cand.content)) continue
      targetIdx = j
      break
    }
    if (targetIdx === -1) continue
    result[i] = {
      ...msg,
      content: blocks.filter((b) => b.type !== "text"),
    }
    const target = result[targetIdx] as FlatUser
    const targetBlocks = asBlocks(target.content) ?? []
    result[targetIdx] = {
      ...target,
      content: [...targetBlocks, ...textSiblings],
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 6. filterOrphanedThinkingOnlyMessages
// ---------------------------------------------------------------------------

/**
 * Drop assistant messages whose content is exclusively thinking blocks AND
 * whose `messageId` has no sibling carrying non-thinking content. Mirrors
 * cc messages.ts:5426-5493.
 *
 * Why we key by id: streaming yields each content block as its own
 * `SessionAssistantMessage` sharing the turn-wide `message.id`
 * (claude.ts:2281-2300). After mergeAssistantMessages folds them, an
 * orphan thinking-only sibling indicates a truly stranded reasoning block —
 * usually from compaction slicing or a cancelled retry — and the API
 * rejects it because the signature is bound to the missing trajectory.
 */
export function filterOrphanedThinkingOnlyMessages(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  const idsWithNonThinking = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== "assistant") continue
    const blocks = asBlocks(msg.content)
    if (!blocks || blocks.length === 0) continue
    const hasNonThinking = blocks.some((b) => !isThinkingBlock(b))
    if (hasNonThinking && msg.messageId) {
      idsWithNonThinking.add(msg.messageId)
    }
  }
  return messages.filter((msg) => {
    if (msg.type !== "assistant") return true
    const blocks = asBlocks(msg.content)
    if (!blocks || blocks.length === 0) return true
    const allThinking = blocks.every((b) => isThinkingBlock(b))
    if (!allThinking) return true
    if (msg.messageId && idsWithNonThinking.has(msg.messageId)) return true
    return false
  })
}

// ---------------------------------------------------------------------------
// 7. filterTrailingThinkingFromLastAssistant
// ---------------------------------------------------------------------------

/**
 * The Anthropic API rejects assistant messages that end with a thinking /
 * redacted_thinking block. Strip trailing thinking from the final assistant
 * message; if every block is thinking, replace with a placeholder so the
 * conversation skeleton still validates. Mirrors cc messages.ts:5209-5261.
 */
export function filterTrailingThinkingFromLastAssistant(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  if (messages.length === 0) return [...messages]
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]!
  if (last.type !== "assistant") return [...messages]
  const blocks = asBlocks(last.content)
  if (!blocks || blocks.length === 0) return [...messages]
  const tail = blocks[blocks.length - 1]
  if (!tail || !isThinkingBlock(tail)) return [...messages]
  let lastValid = blocks.length - 1
  while (lastValid >= 0) {
    const block = blocks[lastValid]
    if (!block || !isThinkingBlock(block)) break
    lastValid--
  }
  const filtered =
    lastValid < 0
      ? [{ type: "text", text: "[No message content]" } as BlockLike]
      : blocks.slice(0, lastValid + 1)
  const result = [...messages]
  result[lastIdx] = { ...last, content: filtered }
  return result
}

// ---------------------------------------------------------------------------
// 8. filterWhitespaceOnlyAssistantMessages
// ---------------------------------------------------------------------------

function isWhitespaceOnlyTextContent(blocks: BlockLike[]): boolean {
  if (blocks.length === 0) return false
  for (const block of blocks) {
    if (block.type !== "text") return false
    const text = (block as { text?: unknown }).text
    if (typeof text === "string" && text.trim() !== "") return false
    if (typeof text !== "string") return false
  }
  return true
}

/**
 * Drop assistant messages whose content is entirely whitespace text. The
 * Anthropic API requires "text content blocks must contain non-whitespace
 * text" — see cc messages.ts:5302-5354. Adjacent users left behind by a
 * dropped assistant are merged in the next pass.
 */
export function filterWhitespaceOnlyAssistantMessages(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  let hasChanges = false
  const filtered = messages.filter((msg) => {
    if (msg.type !== "assistant") return true
    const blocks = asBlocks(msg.content)
    if (!blocks || blocks.length === 0) return true
    if (isWhitespaceOnlyTextContent(blocks)) {
      hasChanges = true
      return false
    }
    return true
  })
  if (!hasChanges) return [...messages]
  // Merge adjacent users left behind.
  return mergeAdjacentUserMessages(filtered)
}

// ---------------------------------------------------------------------------
// 9. ensureNonEmptyAssistantContent
// ---------------------------------------------------------------------------

const NO_CONTENT_PLACEHOLDER = "(no content)"

/**
 * Non-final assistant messages must have non-empty content; the final
 * assistant message may be empty (allowed for prefill). Mirrors
 * cc messages.ts:5368-5412.
 */
export function ensureNonEmptyAssistantContent(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  if (messages.length === 0) return [...messages]
  let hasChanges = false
  const result = messages.map((msg, idx) => {
    if (msg.type !== "assistant") return msg
    if (idx === messages.length - 1) return msg
    const blocks = asBlocks(msg.content)
    if (!Array.isArray(blocks) || blocks.length > 0) return msg
    hasChanges = true
    return {
      ...msg,
      content: [{ type: "text", text: NO_CONTENT_PLACEHOLDER }] as BlockLike[],
    }
  })
  return hasChanges ? result : [...messages]
}

// ---------------------------------------------------------------------------
// 10. sanitizeErrorToolResultContent
// ---------------------------------------------------------------------------

/**
 * `is_error: true` tool_results may only contain text blocks; the API
 * rejects mixed content with "all content must be type text if is_error is
 * true". Strip non-text blocks and merge any text fragments. Mirrors
 * cc messages.ts:2170-2193.
 */
export function sanitizeErrorToolResultContent(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  return messages.map((msg) => {
    if (msg.type !== "user") return msg
    const blocks = asBlocks(msg.content)
    if (!blocks) return msg
    let changed = false
    const newBlocks = blocks.map((b) => {
      if (b.type !== "tool_result") return b
      if (!(b as { is_error?: unknown }).is_error) return b
      const inner = (b as { content?: unknown }).content
      if (!Array.isArray(inner)) return b
      const innerBlocks = inner as BlockLike[]
      if (innerBlocks.every((c) => c.type === "text")) return b
      changed = true
      const texts = innerBlocks
        .filter((c) => c.type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
      const textOnly =
        texts.length > 0
          ? [{ type: "text", text: texts.join("\n\n") } as BlockLike]
          : []
      return { ...b, content: textOnly }
    })
    if (!changed) return msg
    return { ...msg, content: newBlocks }
  })
}

// ---------------------------------------------------------------------------
// 11. backend-specific thinking handling
// ---------------------------------------------------------------------------

/**
 * Strip every thinking / redacted_thinking block from every assistant
 * message. Mirrors cc messages.ts:5501-5534. Used when signatures are no
 * longer valid (credential rotation, model fallback to a different family)
 * or for backends that don't accept thinking on the wire (Kiro, Codex,
 * Google, OpenAI-compat).
 *
 * If stripping leaves an assistant message empty we drop it; the trailing /
 * orphan / non-empty filters above clean up any structural fallout.
 */
export function stripSignatureBlocks(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  let changed = false
  const result: FlatMessage[] = []
  for (const msg of messages) {
    if (msg.type !== "assistant") {
      result.push(msg)
      continue
    }
    const blocks = asBlocks(msg.content)
    if (!blocks) {
      result.push(msg)
      continue
    }
    const filtered = blocks.filter((b) => !isThinkingBlock(b))
    if (filtered.length === blocks.length) {
      result.push(msg)
      continue
    }
    changed = true
    if (filtered.length === 0) continue
    result.push({ ...msg, content: filtered })
  }
  return changed ? result : [...messages]
}

/**
 * Flat-shape signature stripper for callers that have a raw
 * `{role, content}` array and want a defensive thinking-strip without
 * running the full normalize pipeline. Used as the last-line guard in
 * `anthropic-api.service.ts` for `stripThinking` accounts (mirrors cc
 * login.tsx:37 — never let signed reasoning leak when the credential
 * explicitly opts out).
 */
export function stripSignatureBlocksFlat<
  M extends { role: "user" | "assistant"; content: LooseMessageContent },
>(messages: M[]): M[] {
  let changed = false
  const result: M[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      result.push(msg)
      continue
    }
    const blocks = asBlocks(msg.content)
    if (!blocks) {
      result.push(msg)
      continue
    }
    const filtered = blocks.filter((b) => !isThinkingBlock(b))
    if (filtered.length === blocks.length) {
      result.push(msg)
      continue
    }
    changed = true
    if (filtered.length === 0) continue
    result.push({ ...msg, content: filtered as LooseMessageContent })
  }
  return changed ? result : [...messages]
}

/**
 * Anthropic-specific: keep thinking blocks that carry a non-empty
 * signature, drop unsigned thinking. The Anthropic API 400s on thinking
 * without a valid signature
 * (docs.anthropic.com/en/docs/build-with-claude/extended-thinking).
 * `redacted_thinking` is opaque and tolerated without a signature.
 */
function pruneUnsignedThinkingBlocks(
  messages: ReadonlyArray<FlatMessage>
): FlatMessage[] {
  let changed = false
  const result: FlatMessage[] = []
  for (const msg of messages) {
    if (msg.type !== "assistant") {
      result.push(msg)
      continue
    }
    const blocks = asBlocks(msg.content)
    if (!blocks) {
      result.push(msg)
      continue
    }
    const filtered = blocks.filter((b) => {
      if (b.type === "thinking") {
        const sig = (b as { signature?: unknown }).signature
        const sigStr = typeof sig === "string" ? sig.trim() : ""
        return sigStr.length > 0
      }
      return true
    })
    if (filtered.length === blocks.length) {
      result.push(msg)
      continue
    }
    changed = true
    if (filtered.length === 0) continue
    result.push({ ...msg, content: filtered })
  }
  return changed ? result : [...messages]
}

function applyBackendThinkingRules(
  messages: ReadonlyArray<FlatMessage>,
  opts: NormalizeOptions
): FlatMessage[] {
  if (opts.forceStripSignatures) {
    return stripSignatureBlocks(messages)
  }
  if (opts.backend === "anthropic") {
    return opts.stripThinking
      ? stripSignatureBlocks(messages)
      : pruneUnsignedThinkingBlocks(messages)
  }
  return stripSignatureBlocks(messages)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Send-time normalization. Order matches cc messages.ts:normalizeMessagesForAPI:
 *
 *   reorder → mergeAssistant(by id) → mergeAdjacentUser → relocate(no-op) →
 *   filterOrphanThinking → filterTrailingThinking →
 *   filterWhitespaceOnlyAssistant → ensureNonEmptyAssistant →
 *   sanitizeErrorToolResult → hoistToolResults(per user) →
 *   backend thinking rules
 *
 * Returns the flat `UnifiedMessage[]` shape consumed by the per-backend
 * translators.
 */
export function normalizeMessagesForAPI(
  messages: ReadonlyArray<SessionMessage>,
  opts: NormalizeOptions
): UnifiedMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return []

  let pipeline: FlatMessage[] = lift(messages)
  pipeline = reorderAttachmentsForAPI(pipeline)
  pipeline = mergeAssistantMessagesById(pipeline)
  pipeline = mergeAdjacentUserMessages(pipeline)
  pipeline = relocateToolReferenceSiblings(pipeline)
  pipeline = filterOrphanedThinkingOnlyMessages(pipeline)
  pipeline = filterTrailingThinkingFromLastAssistant(pipeline)
  pipeline = filterWhitespaceOnlyAssistantMessages(pipeline)
  pipeline = ensureNonEmptyAssistantContent(pipeline)
  pipeline = sanitizeErrorToolResultContent(pipeline)
  pipeline = hoistInUserMessages(pipeline)
  pipeline = applyBackendThinkingRules(pipeline, opts)
  // Final merge: filterOrphanedThinkingOnlyMessages and the backend-strip
  // pass (stripSignatureBlocks) can both drop assistant messages, leaving
  // adjacent users behind. The Anthropic API requires alternating roles.
  // cc messages.ts:2633 does this gated; we run it unconditionally because
  // we don't have the snip / chair_sermon gates that change the merge
  // semantics there.
  pipeline = mergeAdjacentUserMessages(pipeline)

  return project(pipeline)
}

/**
 * Flat-shape entry point for callers that have already projected their
 * session-side state to `{role, content}` pairs (e.g. via
 * `truncateMessagesForBackend`'s context-compaction projection or the
 * `contextRequestPlanner` sub-agent path). Since the projection layer
 * now carries Anthropic split-sibling `messageId` end-to-end (commit
 * e9fc413), the merge-by-id step actually fires for callers that pass
 * the field through. Callers that don't have a messageId (sub-agent
 * fan-out, attachment / boundary / summary / hook synthetic entries)
 * leave it undefined and the merge step quietly skips them — mirroring
 * cc behaviour for non-streamed historical entries.
 */
export function normalizeFlatMessagesForAPI(
  messages: ReadonlyArray<{
    role: "user" | "assistant"
    content: unknown
    /** Anthropic message id; preserved end-to-end since commit e9fc413. */
    messageId?: string
    /** cc-style isMeta — set on infrastructure user messages
     *  (boundary / summary / attachment / hook). Used by the pipeline's
     *  mergeUserMessages step to prefer the non-meta uuid when fusing
     *  adjacent users. */
    isMeta?: boolean
  }>,
  opts: NormalizeOptions
): UnifiedMessage[] {
  if (messages.length === 0) return []
  let pipeline: FlatMessage[] = messages.map((msg) =>
    msg.role === "assistant"
      ? ({
          type: "assistant",
          uuid: "",
          // Carry the split-sibling key into the pipeline so
          // mergeAssistantMessagesById can fold consecutive siblings
          // produced by the streaming write path
          // (cursor-connect-stream.service.ts:persistSplitSiblingAssistantBlock,
          // commit 4745a63). Mirrors cc claude.ts:2281-2300.
          ...(msg.messageId ? { messageId: msg.messageId } : {}),
          content: msg.content as LooseMessageContent,
        } as FlatAssistant)
      : ({
          type: "user",
          uuid: "",
          // Carry isMeta into the FlatUser shape so mergeUserMessages
          // (line 325-326) can apply the cc uuid-preference rule when
          // fusing adjacent user messages.
          ...(msg.isMeta ? { isMeta: true as const } : {}),
          content: msg.content as LooseMessageContent,
        } as FlatUser)
  )
  pipeline = reorderAttachmentsForAPI(pipeline)
  pipeline = mergeAssistantMessagesById(pipeline)
  pipeline = mergeAdjacentUserMessages(pipeline)
  pipeline = relocateToolReferenceSiblings(pipeline)
  pipeline = filterOrphanedThinkingOnlyMessages(pipeline)
  pipeline = filterTrailingThinkingFromLastAssistant(pipeline)
  pipeline = filterWhitespaceOnlyAssistantMessages(pipeline)
  pipeline = ensureNonEmptyAssistantContent(pipeline)
  pipeline = sanitizeErrorToolResultContent(pipeline)
  pipeline = hoistInUserMessages(pipeline)
  pipeline = applyBackendThinkingRules(pipeline, opts)
  pipeline = mergeAdjacentUserMessages(pipeline)
  return project(pipeline)
}

// Re-export internal types for callers that need to introspect the pipeline
// in tests (and for the spec file in this directory).
export type { FlatMessage, FlatAssistant, FlatUser }
export {
  lift as __liftForTest,
  project as __projectForTest,
  mergeAssistantMessagesById as __mergeAssistantMessagesByIdForTest,
  mergeAdjacentUserMessages as __mergeAdjacentUserMessagesForTest,
  hoistInUserMessages as __hoistInUserMessagesForTest,
}
