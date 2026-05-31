/**
 * `snip_messages` — bridge-internal tool that lets the model proactively
 * drop older session history when it detects that the user has switched
 * topics or that earlier tool outputs are no longer needed.
 *
 * Modeled after Claude Code's `Snip` tool
 * (packages/builtin-tools/src/tools/SnipTool/SnipTool.ts) and its
 * `force-snip` slash-command counterpart. The bridge tracks the "drop
 * list" on the live session via `registerSnipBoundary`; the projection
 * applied at request build time (`getProjectedMessages`) hides the
 * dropped messages from the model-facing view without deleting them
 * from the persisted transcript.
 *
 * Why a dedicated handler module:
 *   - The other Cursor-protocol deferred tools have a real IDE-side
 *     execution path. `snip_messages` is pure bridge state, so we keep
 *     it next to `discover-tool-handler.ts` for symmetry.
 */

import type { ToolDefinition } from "./cursor-tool-mapper"

export const SNIP_MESSAGES_TOOL_NAME = "snip_messages"

/** Soft floor — we always keep at least this many recent messages. */
export const SNIP_MIN_KEEP_RECENT = 4

/**
 * Anthropic-style tool definition. Shape matches what `buildToolsForApi()`
 * returns so it can be appended to the tools array directly.
 */
export const SNIP_MESSAGES_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: SNIP_MESSAGES_TOOL_NAME,
  description:
    "Drop older messages from your conversation history when they are no " +
    "longer needed. Snipped messages are hidden from the model-facing " +
    "context (the user still sees the full transcript). Use this when:\n" +
    "- The user has switched to a new task and the earlier exploration is " +
    "no longer relevant.\n" +
    "- The conversation has accumulated large tool outputs that you have " +
    "already extracted the useful information from.\n" +
    "- You want to free context window space before a long planning or " +
    "implementation phase.\n\n" +
    "Guidelines:\n" +
    "- Provide `keep_recent` to retain the N most recent messages " +
    "(must be at least 4). Pick a value that preserves the current " +
    "task's anchor messages without dragging in unrelated history.\n" +
    "- Set `reason` to a short phrase describing the topic switch — it is " +
    "logged for observability and surfaced to the user.\n" +
    "- You cannot un-snip: the original content is gone from the " +
    "model-facing view for the rest of this conversation.",
  input_schema: {
    type: "object",
    properties: {
      keep_recent: {
        type: "integer",
        minimum: SNIP_MIN_KEEP_RECENT,
        description:
          "Number of most-recent messages to keep visible to the model. " +
          "Anything older becomes hidden from future turns. Minimum: 4.",
      },
      reason: {
        type: "string",
        description:
          "Short human-readable reason for snipping (e.g. " +
          '"switching from auth refactor to docs cleanup"). Logged and ' +
          "shown in the snip boundary marker.",
      },
    },
    required: ["keep_recent"],
  },
}

export interface SnipMessagesSuccess {
  status: "success"
  snipped_count: number
  kept_count: number
  total_records: number
  reason?: string
  boundary_id: string
  next_step: string
}

export interface SnipMessagesError {
  status: "error"
  error: string
}

export type SnipMessagesResult = SnipMessagesSuccess | SnipMessagesError

export function formatSnipMessagesResultText(
  result: SnipMessagesResult
): string {
  if (result.status === "success") {
    const body = {
      snipped_count: result.snipped_count,
      kept_count: result.kept_count,
      total_records: result.total_records,
      reason: result.reason,
      boundary_id: result.boundary_id,
      next_step: result.next_step,
    }
    return `[snip_messages success]\n${JSON.stringify(body, null, 2)}`
  }
  return `[snip_messages error]\n${JSON.stringify({ error: result.error }, null, 2)}`
}

/** Validate and normalize tool input. Pure: no I/O, no mutation. */
export function parseSnipMessagesInput(
  input: Record<string, unknown>
): { keepRecent: number; reason?: string } | { error: string } {
  const rawKeep = input.keep_recent
  const keepRecent =
    typeof rawKeep === "number" && Number.isInteger(rawKeep) ? rawKeep : NaN
  if (!Number.isFinite(keepRecent)) {
    return {
      error:
        "Missing or invalid `keep_recent`. Provide an integer >= " +
        `${SNIP_MIN_KEEP_RECENT} for the number of most-recent messages to keep.`,
    }
  }
  if (keepRecent < SNIP_MIN_KEEP_RECENT) {
    return {
      error: `\`keep_recent\` must be at least ${SNIP_MIN_KEEP_RECENT}; got ${keepRecent}.`,
    }
  }
  const reason =
    typeof input.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim().slice(0, 240)
      : undefined
  return { keepRecent, reason }
}
