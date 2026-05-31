import type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from "../../../context/types"

/**
 * ModelTurnYield — what the model produced this turn, classified at
 * `message_stop` time so finalize / continuation logic does not have
 * to re-derive it from `accumulatedText: string + turnAssistantMessages`.
 *
 * The deleted pre-step-6 path treated finalize as a single string-text
 * branch:
 *   - if `accumulatedText` non-empty → emit text_completed + turn_ended
 *   - else if any tool_use → dispatch batch
 *   - else → silently emit turn_ended
 *
 * That third branch is the source of the "thinking-only finalize"
 * regressions reported in `agent-vibes-bridge.log` turn 865ebefb: the
 * model produced thinking blocks then stopped with `stop_reason=end_turn`
 * but no tools and no user-visible text, and the bridge silently sealed
 * the turn while the IDE showed "complete".
 *
 * The ADT below makes that case a first-class outcome (`thinking_only`),
 * which the recovery layer can handle distinctly from a true empty
 * stream or a tool batch.
 *
 * Discriminator policy for `classifyModelYield`:
 *
 *   1. `transport_failed` — present whenever `streamHealth.cause` is
 *      set, regardless of which blocks landed first. This always wins.
 *
 *   2. `truncated` — `stop_reason ∈ {"max_tokens", "output_limit"}`,
 *      regardless of whether the model produced text or tool_use; the
 *      truncation flag is what the upstream recovery path needs to see.
 *
 *   3. `tool_batch` — at least one tool_use block.
 *
 *   4. `text_response` — at least one text block with non-whitespace
 *      content. Thinking blocks may be present alongside; they are
 *      partitioned out for the consumer.
 *
 *   5. `thinking_only` — at least one thinking block AND no tool_use
 *      AND no non-whitespace text.
 *
 *   6. `empty_stream` — fallthrough.
 */
export type ModelTurnYield =
  | {
      kind: "tool_batch"
      tools: ToolUseBlock[]
      thinking: ThinkingBlock[]
      text: TextBlock[]
    }
  | {
      kind: "text_response"
      text: TextBlock[]
      thinking: ThinkingBlock[]
    }
  | {
      kind: "thinking_only"
      thinking: ThinkingBlock[]
    }
  | { kind: "empty_stream" }
  | {
      kind: "truncated"
      produced: ContentBlock[]
      stopReason: "max_tokens" | "output_limit"
    }
  | { kind: "transport_failed"; cause: Error }

export interface StreamHealth {
  /**
   * Set when the SSE transport failed to deliver `message_stop`. The
   * recovery path treats this as `transport_failed` regardless of how
   * many blocks accumulated before the disconnect.
   */
  cause?: Error
}

/**
 * Pure classification of an end-of-stream snapshot. No I/O, no
 * persistence, no audit-log access. The caller (cursor-connect-stream
 * finalize) is responsible for invoking `lifecycle.appendEvent({
 *   kind: "model-yield", yield })` once the result is computed.
 */
export function classifyModelYield(
  blocks: ContentBlock[],
  stopReason: string | null,
  streamHealth: StreamHealth = {}
): ModelTurnYield {
  if (streamHealth.cause) {
    return { kind: "transport_failed", cause: streamHealth.cause }
  }

  if (stopReason === "max_tokens" || stopReason === "output_limit") {
    return { kind: "truncated", produced: blocks, stopReason }
  }

  const tools: ToolUseBlock[] = []
  const thinking: ThinkingBlock[] = []
  const text: TextBlock[] = []

  for (const block of blocks) {
    switch (block.type) {
      case "tool_use":
        tools.push(block)
        break
      case "thinking":
        thinking.push(block)
        break
      case "text":
        text.push(block)
        break
      // image / tool_result / cache_edits cannot appear in a model
      // assistant yield; ignore for classification.
      default:
        break
    }
  }

  if (tools.length > 0) {
    return { kind: "tool_batch", tools, thinking, text }
  }

  const meaningfulText = text.some((t) => t.text.trim().length > 0)
  if (meaningfulText) {
    return { kind: "text_response", text, thinking }
  }

  if (thinking.length > 0) {
    return { kind: "thinking_only", thinking }
  }

  return { kind: "empty_stream" }
}

/**
 * Cap on how many `thinking_only` recoveries we are willing to perform
 * for a single turn. After hitting the cap the bridge falls through to
 * the normal finalize path with a WARN — finalising-as-text is the
 * least-bad option once nudges have failed.
 */
export const MAX_THINKING_ONLY_RECOVERIES = 1

/**
 * Marker text appended to the recovery user message so operators can
 * grep them out of transcripts and so the model-side prompt can
 * recognise the synthetic origin without scraping intent from the
 * surrounding nudge prose. The N suffix is the 1-based round counter.
 */
export function thinkingOnlyRecoveryMarker(round: number): string {
  return `[agent-vibes:thinking-only-recovery:${round}]`
}

/**
 * The recovery user message body. English-only by request: the model
 * is bilingual and English keeps the marker invariant across locales.
 *
 * The wording deliberately:
 *   - acknowledges the thinking that happened (so the model does not
 *     repeat it)
 *   - states the expected next action in two equally valid forms
 *     (call a tool OR produce a final response) so the model picks
 *     whichever fits the conversation, rather than pushing a single
 *     "must call a tool" lead that would derail when no action is
 *     required
 *   - avoids hedging ("please", "could you") because the model treats
 *     direct instructions as more salient
 */
export function thinkingOnlyRecoveryPrompt(round: number): string {
  const marker = thinkingOnlyRecoveryMarker(round)
  return (
    `${marker}\n\n` +
    `You produced reasoning in your thinking block but did not call any ` +
    `tools or emit a user-visible message. Execute your plan now using ` +
    `the available tools, or produce a final user-visible response.`
  )
}
