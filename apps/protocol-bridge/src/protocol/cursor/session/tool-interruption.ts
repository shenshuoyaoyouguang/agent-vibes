export type ToolInterruptionReason =
  | "process_restart"
  | "parent_turn_superseded"
  | "stream_aborted"
  | "parent_cancelled"

const TOOL_INTERRUPTION_REASONS = new Set<string>([
  "process_restart",
  "parent_turn_superseded",
  "stream_aborted",
  "parent_cancelled",
])

export function normalizeToolInterruptionReason(
  value: unknown,
  fallback: ToolInterruptionReason = "stream_aborted"
): ToolInterruptionReason {
  return typeof value === "string" && TOOL_INTERRUPTION_REASONS.has(value)
    ? (value as ToolInterruptionReason)
    : fallback
}

export function isToolInterruptionReason(
  value: unknown
): value is ToolInterruptionReason {
  return typeof value === "string" && TOOL_INTERRUPTION_REASONS.has(value)
}

export function buildInterruptedToolResultContent(input: {
  toolCallId: string
  toolName: string
  reason: ToolInterruptionReason
  detail?: string
}): string {
  const tool = input.toolName || input.toolCallId
  const detail = input.detail?.trim()
  const lines =
    input.reason === "process_restart"
      ? [
          "Tool execution aborted because the bridge process restarted before the result was received.",
          "reason: process_restart",
        ]
      : input.reason === "parent_turn_superseded"
        ? [
            "Tool execution aborted because a new user turn arrived before this tool call settled. The bridge process did not restart.",
            "reason: parent_turn_superseded",
          ]
        : input.reason === "stream_aborted"
          ? [
              "Tool execution aborted because the BiDi stream ended before the result was received.",
              "reason: stream_aborted",
            ]
          : [
              "Tool execution aborted because the parent turn or owning sub-agent was cancelled.",
              "reason: parent_cancelled",
            ]

  if (detail) {
    lines.push(`detail: ${detail}`)
  }
  lines.push(`tool: ${tool}`)
  return lines.join("\n")
}

export function getInterruptedToolRepairContextLabel(
  conversationId: string,
  reasons: Iterable<ToolInterruptionReason>
): string {
  const uniqueReasons = new Set(reasons)
  if (uniqueReasons.size === 1 && uniqueReasons.has("process_restart")) {
    return `cross-process restart recovery: ${conversationId}`
  }
  if (uniqueReasons.size === 1 && uniqueReasons.has("parent_turn_superseded")) {
    return `in-process turn-boundary repair: ${conversationId}`
  }
  if (uniqueReasons.size === 1 && uniqueReasons.has("parent_cancelled")) {
    return `parent-cancel tool repair: ${conversationId}`
  }
  return `stream-interruption tool repair: ${conversationId}`
}
