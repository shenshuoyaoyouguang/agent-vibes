import type { ContextTranscriptRecord, UnifiedMessage } from "./types"

/**
 * Group adjacent messages into "API rounds" so truncation logic can drop
 * whole rounds instead of slicing through the middle of a tool-use chain.
 *
 * A round starts when a new assistant message appears (after we've seen at
 * least one prior message) and includes any user messages that follow up
 * the tool calls in that assistant turn.  Group 0 captures the leading
 * user-only preamble before the first assistant turn.
 *
 * This is a structural variant of claude-code's
 * `groupMessagesByApiRound` adapted to our role-only message shape.  We
 * cannot key on `message.id` because tool messages do not carry a stable
 * upstream id; the role transition is the next-best signal and gives the
 * same well-formed-conversation guarantee that every tool_use is paired
 * with a tool_result inside the same group.
 */
export function groupMessagesByApiRound<T extends { role: string }>(
  messages: readonly T[]
): T[][] {
  if (messages.length === 0) {
    return []
  }
  const groups: T[][] = []
  let current: T[] = []
  let lastRole: string | undefined

  for (const message of messages) {
    if (
      message.role === "assistant" &&
      lastRole !== undefined &&
      lastRole !== "assistant" &&
      current.length > 0
    ) {
      groups.push(current)
      current = [message]
    } else {
      current.push(message)
    }
    lastRole = message.role
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

/**
 * Convenience: group transcript records the same way.
 */
export function groupTranscriptRecordsByApiRound(
  records: readonly ContextTranscriptRecord[]
): ContextTranscriptRecord[][] {
  return groupMessagesByApiRound(records)
}

/**
 * Find the smallest round index whose tail keeps the given message slice
 * inside `targetTokens` (using the supplied token counter).
 *
 * Returns the message index where retention should start, similar to
 * `ToolIntegrityService.findTruncationPointWithIntegrity` but rounded to
 * a round boundary so we never slice through tool_use/tool_result pairs.
 */
export function findRoundAlignedTruncationIndex(
  messages: readonly UnifiedMessage[],
  targetTokens: number,
  countMessages: (slice: readonly UnifiedMessage[]) => number
): number {
  if (messages.length === 0) return 0
  const groups = groupMessagesByApiRound(messages)
  if (groups.length <= 1) {
    return 0
  }

  // Walk from the last round backwards, accumulating tokens until adding
  // another group would push us over the limit.  Translate the surviving
  // group span back into a message index.
  let runningTokens = 0
  let firstKeptGroupIndex = groups.length
  for (let g = groups.length - 1; g >= 0; g--) {
    const groupMessages = groups[g]!
    const groupTokens = countMessages(groupMessages)
    if (g < groups.length - 1 && runningTokens + groupTokens > targetTokens) {
      break
    }
    runningTokens += groupTokens
    firstKeptGroupIndex = g
  }

  if (firstKeptGroupIndex >= groups.length) {
    // Nothing fits — keep the very last group so the caller can decide
    // what to do (e.g. fall back to per-message slicing).
    return messages.length - groups[groups.length - 1]!.length
  }

  let startIndex = 0
  for (let g = 0; g < firstKeptGroupIndex; g++) {
    startIndex += groups[g]!.length
  }
  return startIndex
}
