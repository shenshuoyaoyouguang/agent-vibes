/**
 * Subagent model override plumbing for the Cursor protocol.
 *
 * Cursor's settings UI exposes per-subagent model selection
 * ("Inherit from parent" / "Disable" / a specific model id) for both
 * the built-in subagents (Explore, Plan, ...) and user-defined subagents.
 * The setting is delivered on every `AgentRunRequest` via two adjacent
 * proto fields:
 *
 *   - `subagent_model_overrides` (field 20): repeated SubagentModelOverride.
 *     Each entry pins a `subagentType` to one of three states:
 *       * `model`    — concrete RequestedModel chosen by the user
 *       * `inherit`  — explicitly inherit the parent (top-level chat) model
 *       * `disabled` — the subagent type is opted out of LLM-backed runs
 *
 *   - `selected_subagent_models` (field 14): repeated RequestedModel.
 *     Legacy / shorthand list of pinned models, used by older Cursor
 *     clients that didn't yet support the override oneof. The proto layer
 *     keeps both for compatibility; this module reads the override list
 *     when present and falls back to legacy list-only handling.
 *
 * Bridge consumers:
 *   - `ToolUseSummaryService` (one-line label per tool batch).
 *     Treats the implicit "tool_use_summary" subagent type as a
 *     small/fast helper. The override map can override that to a
 *     specific model, force inherit-parent, or disable label generation
 *     entirely.
 *   - `executeSubAgentTask` / `spawnBackgroundSubAgent` in
 *     `cursor-connect-stream.service.ts` (real `task` tool spawns).
 *     Each spawn looks up the requested `subagent_type` in the override
 *     map; `inherit` falls back to the agent definition's own model
 *     resolution (which itself may say "inherit"), `disabled` aborts the
 *     spawn with an explicit error so the model retries with another
 *     agentType, and `model` wins outright.
 *
 * Why a dedicated module:
 *   - Keep the proto-shape mapping in one place so adding fields (the
 *     `selected_subagent_model_details` model-details twin, future
 *     `subagent_thinking_level` etc.) does not bleed across the parser
 *     and the consumers.
 *   - Allow consumers to depend on a small, typed surface
 *     (`SubagentModelOverridesMap.lookup(subagentType)`) that is
 *     persistence-friendly (no proto types leak into SessionRecord).
 */

import type {
  AgentRunRequest,
  RequestedModel,
  SubagentModelOverride,
} from "../../../gen/agent/v1_pb"

/**
 * Reserved synthetic subagent_type used by the bridge for helper LLM
 * calls that have no real Cursor-defined subagent counterpart. Today
 * this is just the per-tool-batch summary label, but the slot exists
 * so future helper calls (compaction summary, agent-summary, ...) can
 * be opted out / overridden the same way.
 *
 * The leading underscore mirrors how Cursor reserves built-in
 * subagent type names (`explore`, `plan`, ...): the underscore makes it
 * clear this is not a user-declarable name and avoids any clash with
 * names from `~/.cursor/agents/*.md`.
 */
export const TOOL_USE_SUMMARY_SUBAGENT_TYPE = "_tool_use_summary"

/**
 * Bridge-side projection of `agent.v1.SubagentModelOverride.selection`.
 * Encodes only the fields downstream consumers need so we don't drag
 * proto-generated message identity (and its non-serialisable `$typeName`
 * brand) onto persisted SessionRecord state.
 */
export type ResolvedSubagentOverride =
  | { kind: "inherit" }
  | { kind: "disabled" }
  | {
      kind: "model"
      /** modelId verbatim from RequestedModel.model_id. */
      modelId: string
      /** True when the user toggled max-mode for this subagent's pick. */
      maxMode: boolean
      /** True when Cursor flagged the model as a built-in. */
      builtInModel: boolean
      /** True when modelId is a serialised variant string ("model::variant"). */
      isVariantStringRepresentation: boolean
    }

/**
 * Immutable, persistence-friendly lookup table keyed by `subagentType`.
 * Build via `parseSubagentModelOverrides`; consumers should treat this
 * as opaque and only use the `lookup` accessor.
 */
export interface SubagentModelOverridesMap {
  /**
   * Resolve the override for a given subagent type. Returns `undefined`
   * when the user has not pinned a value — callers should treat that as
   * "use the default behaviour" (typically inherit-from-parent for
   * helper calls, or the agent definition's own `model` field for real
   * subagent spawns).
   */
  lookup(subagentType: string): ResolvedSubagentOverride | undefined

  /** All subagent types that have an explicit pin. Useful for logging. */
  keys(): string[]

  /** True when no overrides were declared. Cheap fast-path for callers. */
  isEmpty(): boolean
}

const EMPTY: SubagentModelOverridesMap = {
  lookup: () => undefined,
  keys: () => [],
  isEmpty: () => true,
}

/**
 * Public empty singleton for callers that need a stable reference
 * (e.g. createFreshSession default value). Marked readonly at the type
 * level so a downstream consumer can't accidentally mutate the shared
 * empty map.
 */
export const EMPTY_SUBAGENT_MODEL_OVERRIDES: SubagentModelOverridesMap = EMPTY

/**
 * Project a single proto `SubagentModelOverride` to the bridge-side
 * union. Returns `undefined` for malformed entries so the caller can
 * skip them without bringing down the whole map build.
 */
function projectOverride(
  override: SubagentModelOverride
): ResolvedSubagentOverride | undefined {
  const selection = override.selection
  if (!selection || !selection.case) return undefined
  switch (selection.case) {
    case "inherit": {
      // Cursor sets the bool to `true` when "Inherit from parent" is
      // selected. If a future client variant flips the bool to `false`
      // to mean "explicitly NOT inherit" we still treat it as inherit:
      // the only sensible neutral default is parent inheritance, and
      // `disabled` exists to opt out.
      return { kind: "inherit" }
    }
    case "disabled": {
      // Same reasoning: if the bool is false here we still treat the
      // override as disabled because the case branch itself encoded
      // intent. Cursor's UI never sends `disabled: false` today.
      return { kind: "disabled" }
    }
    case "model": {
      const requested: RequestedModel | undefined = selection.value
      const modelId = requested?.modelId?.trim()
      if (!modelId) return undefined
      return {
        kind: "model",
        modelId,
        maxMode: requested?.maxMode === true,
        builtInModel: requested?.builtInModel === true,
        isVariantStringRepresentation:
          requested?.isVariantStringRepresentation === true,
      }
    }
    default: {
      // Exhaustiveness: a future proto evolution that adds a new
      // selection case forces a compile error here so we don't silently
      // drop user intent.
      const _exhaustive: never = selection
      void _exhaustive
      return undefined
    }
  }
}

/**
 * Parse the override list straight off an `AgentRunRequest`. The
 * proto layer guarantees the field exists (empty array when absent),
 * so callers never need to null-check before calling.
 *
 * Last-write-wins on duplicate `subagentType` entries: Cursor today
 * emits at most one entry per type, but mirroring lenient behaviour
 * keeps us robust against future client variants that might emit
 * multiple (e.g. layered project + user overrides).
 */
export function parseSubagentModelOverrides(
  req: AgentRunRequest
): SubagentModelOverridesMap {
  const overrides = req.subagentModelOverrides
  if (!overrides || overrides.length === 0) return EMPTY

  const table = new Map<string, ResolvedSubagentOverride>()
  for (const entry of overrides) {
    const subagentType = entry.subagentType?.trim()
    if (!subagentType) continue
    const projected = projectOverride(entry)
    if (!projected) continue
    table.set(subagentType, projected)
  }

  if (table.size === 0) return EMPTY

  return {
    lookup(subagentType: string) {
      return table.get(subagentType)
    },
    keys() {
      return Array.from(table.keys())
    },
    isEmpty() {
      return table.size === 0
    },
  }
}

/**
 * Decision returned by `applySubagentOverride` for helper / fork-style
 * callers (ToolUseSummary, future helper LLM calls).
 *
 *   - `proceed-inherit`  : run the call using the parent model.
 *   - `proceed-with-model`: run the call using `modelId` (which may
 *     route to any backend the bridge supports — Claude, GPT, Gemini —
 *     so callers must go through ModelRouterService rather than
 *     hard-routing to a Claude-only fork helper).
 *   - `skip`              : the user disabled this helper for this
 *     subagent type; caller short-circuits without making a call.
 */
export type HelperOverrideDecision =
  | { kind: "proceed-inherit" }
  | { kind: "proceed-with-model"; modelId: string; maxMode: boolean }
  | { kind: "skip" }

/**
 * Translate an override entry (or its absence) into the helper-call
 * decision shape.  Centralised so ToolUseSummary and any future helper
 * follow the same precedence rules:
 *
 *   1. No override entry          -> caller default (proceed-inherit).
 *   2. Override `inherit`         -> proceed-inherit.
 *   3. Override `disabled`        -> skip.
 *   4. Override `model`           -> proceed-with-model.
 *
 * Returning `proceed-inherit` instead of `proceed-with-model(parentModel)`
 * is intentional: it lets the fork dispatcher reuse cache-safe params
 * verbatim from the parent (cache hit) instead of synthesising a new
 * cache key.
 */
export function applySubagentOverride(
  override: ResolvedSubagentOverride | undefined
): HelperOverrideDecision {
  if (!override) return { kind: "proceed-inherit" }
  switch (override.kind) {
    case "inherit":
      return { kind: "proceed-inherit" }
    case "disabled":
      return { kind: "skip" }
    case "model":
      return {
        kind: "proceed-with-model",
        modelId: override.modelId,
        maxMode: override.maxMode,
      }
    default: {
      const _exhaustive: never = override
      void _exhaustive
      return { kind: "proceed-inherit" }
    }
  }
}
