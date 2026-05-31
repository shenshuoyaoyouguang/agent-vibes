export interface ContextAutoCompactInput {
  backend: string
  maxTokens: number
  maxOutputTokens?: number
  requestedServiceTier?: string
}

const COMPACT_SUMMARY_OUTPUT_RESERVE_TOKENS = 20_000
const DEFAULT_TURN_OUTPUT_RESERVE_TOKENS = 8_192
// Lowered from 13_000. The original 13K headroom was sized so a fully
// synchronous compact (Opus 4.7 thinking, 30–110s) had room to land before
// the next request would otherwise overflow. With predictive pre-warm doing
// compaction in the background while the previous tool result settles, the
// reactive trigger is rarely on the request critical path; we can
// confidently shave a few thousand tokens off the buffer to give Opus turns
// 1–2 extra read-only batches before the next compaction kicks. The ratio
// for the medium / large tiers is unchanged because those models have
// proportionally larger working sets and don't benefit as much.
const BASE_AUTOCOMPACT_BUFFER_TOKENS = 8_000
const MEDIUM_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS = 30_000
const LARGE_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS = 50_000
const TOOL_RESULT_TURN_GROWTH_ESTIMATE_TOKENS = 15_000

function normalizeServiceTier(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized || undefined
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/**
 * Returns an automatic compaction trigger, not a smaller context window.
 *
 * Codex core derives the default auto-compaction limit from context_window at
 * 90%. Claude Code reserves room for compact output plus turn growth before
 * the next model call. The bridge mirrors those trigger shapes while still
 * keeping the hard request budget unchanged.
 */
export function resolveAutoCompactTokenLimit(
  input: ContextAutoCompactInput
): number | undefined {
  const maxTokens = normalizePositiveInteger(input.maxTokens)
  if (!maxTokens) {
    return undefined
  }

  if (input.backend === "codex") {
    if (normalizeServiceTier(input.requestedServiceTier) !== "priority") {
      return undefined
    }
    return Math.floor(maxTokens * 0.9)
  }

  const outputReserve = Math.min(
    normalizePositiveInteger(input.maxOutputTokens) ??
      DEFAULT_TURN_OUTPUT_RESERVE_TOKENS,
    COMPACT_SUMMARY_OUTPUT_RESERVE_TOKENS
  )
  const buffer =
    maxTokens >= 800_000
      ? LARGE_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS
      : maxTokens >= 400_000
        ? MEDIUM_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS
        : BASE_AUTOCOMPACT_BUFFER_TOKENS
  const limit = maxTokens - outputReserve - buffer

  if (limit <= 0 || limit >= maxTokens) {
    return undefined
  }

  return limit
}

/**
 * Predictive threshold used before the request is sent.
 *
 * Claude Code runs the normal auto-compact check first, then a predictive
 * pass that asks: "will one more model output plus typical tool results push
 * this turn over the context window?"  This trigger is deliberately separate
 * from the hard window. It only starts compaction earlier; it never reduces
 * the actual backend request budget.
 */
export function resolvePredictiveCompactTokenLimit(
  input: ContextAutoCompactInput
): number | undefined {
  const maxTokens = normalizePositiveInteger(input.maxTokens)
  if (!maxTokens) {
    return undefined
  }

  const outputReserve = Math.min(
    normalizePositiveInteger(input.maxOutputTokens) ??
      DEFAULT_TURN_OUTPUT_RESERVE_TOKENS,
    COMPACT_SUMMARY_OUTPUT_RESERVE_TOKENS
  )
  const estimatedTurnGrowth =
    outputReserve + TOOL_RESULT_TURN_GROWTH_ESTIMATE_TOKENS
  const limit = maxTokens - outputReserve - estimatedTurnGrowth

  if (limit <= 0 || limit >= maxTokens) {
    return undefined
  }

  return limit
}
