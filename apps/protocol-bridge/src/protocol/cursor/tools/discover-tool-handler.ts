/**
 * `discover_tool` — bridge-internal tool that lets the model fetch the
 * full description + input_schema of a deferred tool on demand.
 *
 * This is **not** a Cursor protocol tool: it has no `CLIENT_SIDE_TOOL_V2_*`
 * proto identifier, no IDE-side execution path, and no MCP backing.  It
 * exists only so the bridge can ship a slim tool surface upstream while
 * still letting the model reach less common tools when it needs them.
 *
 * Lifecycle:
 *   1. We inject this tool's definition into every outgoing
 *      `tools` array (when defer is enabled).
 *   2. The system prompt advertises a catalog of deferred tools, each
 *      with a one-line summary, and tells the model to call
 *      `discover_tool({ tool_name })` before using any of them.
 *   3. When the model emits a `tool_use` for `discover_tool`, the
 *      cursor-connect-stream dispatch layer recognises the name, calls
 *      `handleDiscoverToolCall()` instead of the IDE / upstream, and
 *      returns the requested tool's full schema as the tool_result.
 *   4. The session's `discoveredTools` set is updated so subsequent
 *      turns include the discovered tool's full schema in the core
 *      surface — no further `discover_tool` round-trips needed for the
 *      same tool in the same session.
 *
 * Why a dedicated handler module (instead of folding it into
 * `runDeferredToolIfNeeded` etc.):
 *   - The other deferred-family tools have a real Cursor protocol
 *     counterpart and are dispatched via `InteractionQuery` or
 *     `ExecServerMessage`. `discover_tool` is unique: it is satisfied
 *     entirely from in-memory state (the tool catalog).  Keeping it in
 *     a separate file makes the "this never leaves the bridge" property
 *     obvious.
 */

import type { ToolDefinition } from "./cursor-tool-mapper"
import { DISCOVER_TOOL_NAME } from "./tool-defer-policy"

/**
 * Anthropic-style tool definition for `discover_tool`.  Shape matches
 * what `buildToolsForApi()` returns, so it can be appended to the result
 * array directly without any coercion.
 */
export const DISCOVER_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: DISCOVER_TOOL_NAME,
  description:
    "Retrieve the full schema of a tool that was advertised in the " +
    "<deferred_tools> section of the system prompt but is not yet loaded " +
    "for direct invocation. Pass the exact tool name as listed in that " +
    "catalog. The result is the tool's full description and input schema; " +
    "after a successful discovery you may call the tool normally on the " +
    "next turn (no need to call discover_tool again for the same tool in " +
    "this session).\n\n" +
    "Use this only when the catalog tells you the tool exists. Do not " +
    "invent tool names — names not in the catalog will return an error " +
    "and waste a turn.",
  input_schema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description:
          "Exact name of the deferred tool to load, copied verbatim from " +
          "the <deferred_tools> catalog (case-sensitive).",
      },
    },
    required: ["tool_name"],
  },
}

/**
 * Result payload returned to the model as the tool_result text.
 *
 * We return JSON rather than a custom format so the model can reliably
 * parse the schema if it wants to. Keeping it boring also makes wire-log
 * inspection trivial.
 */
export interface DiscoverToolSuccess {
  status: "success"
  tool_name: string
  description: string
  input_schema: Record<string, unknown>
  /** When true, the next turn's tools array will include this tool. */
  promoted_to_core: true
}

export interface DiscoverToolError {
  status: "error"
  tool_name: string
  error: string
  /** Names available for discovery, to help the model self-correct. */
  available?: string[]
}

export type DiscoverToolResult = DiscoverToolSuccess | DiscoverToolError

/**
 * The set of tool definitions we know how to discover.  Caller passes
 * the **deferred** subset (i.e. tools that were trimmed out of the
 * upstream payload but are still installed).  We look up by exact name.
 */
export interface DiscoverToolCatalogEntry {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * Names of tools that already live in the **core** tool surface (i.e.
 * were not trimmed out by the defer policy and so are callable
 * directly without a `discover_tool` round-trip). When the model
 * mistakenly calls `discover_tool` on one of these, we return a
 * dedicated success-style error explaining that the tool is already
 * loaded — instead of the generic
 * `Unknown deferred tool "..."` reject which would be misleading.
 *
 * Caller is responsible for passing the actual list (it is computed
 * from the session's `coreToolDefinitions` + `discoveredTools` set
 * in cursor-connect-stream.service.ts).
 */
export type CoreToolNameSet = ReadonlySet<string>

/**
 * Tool names that are NOT in Cursor's `agent.v1` protocol but that
 * frequently leak into model outputs because they exist in another
 * surface the model has been trained on (Antigravity / Google Cloud
 * Code). When the model `discover_tool`s one of these names, returning
 * the generic "Unknown deferred tool" reject burns a turn while the
 * model retries variants. Surface a one-line redirect to the actual
 * Cursor protocol equivalent so the model can recover on this turn.
 *
 * Keep this list small and only add entries when we have a confident
 * 1:1 redirect; broad guesses would mask real catalog mismatches.
 */
const NON_CURSOR_TOOL_REDIRECTS: ReadonlyMap<string, string> = new Map([
  [
    "view_content_chunk",
    "`view_content_chunk` belongs to Antigravity / Google Cloud Code, not Cursor `agent.v1`. Cursor's `web_fetch` returns the entire document in one call; if you need to fetch a URL, call `web_fetch` instead. Bridge-internal `[tool_result stored]` archives are also not addressable by chunk — re-invoke the original tool to read again.",
  ],
  [
    "read_url_content",
    "`read_url_content` belongs to Antigravity / Google Cloud Code, not Cursor `agent.v1`. Use `web_fetch` to read a URL on this surface.",
  ],
])

function buildUnknownDeferredToolMessage(requested: string): string {
  const redirect = NON_CURSOR_TOOL_REDIRECTS.get(requested)
  const base = `Unknown deferred tool "${requested}". Names are case-sensitive; check the <deferred_tools> catalog in the system prompt.`
  return redirect ? `${base} ${redirect}` : base
}

/**
 * Resolve a `discover_tool` call.  Pure: no I/O, no session mutation;
 * the caller is responsible for adding `result.tool_name` to the
 * session's `discoveredTools` on success.
 */
export function handleDiscoverToolCall(
  toolInput: Record<string, unknown>,
  catalog: ReadonlyMap<string, DiscoverToolCatalogEntry>,
  coreToolNames?: CoreToolNameSet
): DiscoverToolResult {
  const requested =
    typeof toolInput.tool_name === "string" ? toolInput.tool_name.trim() : ""

  if (!requested) {
    return {
      status: "error",
      tool_name: "",
      error:
        "Missing required parameter `tool_name`. Pass the exact name of " +
        "a deferred tool as listed in the <deferred_tools> catalog.",
      available: Array.from(catalog.keys()).slice(0, 32),
    }
  }
  const entry = catalog.get(requested)
  if (!entry) {
    // P1-3 / smoke-regression #5: when the requested tool is already
    // in the core surface (e.g. `kill_agent`, `task`, `await_task`),
    // returning the generic `Unknown deferred tool` error misleads
    // the model into thinking the tool is unavailable. Hand back a
    // success-shaped result with `promoted_to_core=true` and a
    // `description` that explicitly says no discovery was needed,
    // so the model retries by calling the tool directly.
    if (coreToolNames && coreToolNames.has(requested)) {
      return {
        status: "success",
        tool_name: requested,
        description:
          `"${requested}" is already part of the core tool surface ` +
          `for this session; no discover_tool round-trip is needed. ` +
          `Call it directly with its documented arguments. ` +
          `(This response is synthetic — there is no separate ` +
          `description payload to fetch.)`,
        input_schema: { type: "object", properties: {}, required: [] },
        promoted_to_core: true,
      }
    }
    // Try a case-insensitive lookup as a courtesy; common-failure mode is
    // models lower-casing names that have non-trivial casing (notably
    // some MCP tool prefixes).
    const lowered = requested.toLowerCase()
    let recovered: DiscoverToolCatalogEntry | undefined
    for (const value of catalog.values()) {
      if (value.name.toLowerCase() === lowered) {
        recovered = value
        break
      }
    }
    if (!recovered) {
      return {
        status: "error",
        tool_name: requested,
        error: buildUnknownDeferredToolMessage(requested),
        available: Array.from(catalog.keys()).slice(0, 32),
      }
    }
    return {
      status: "success",
      tool_name: recovered.name,
      description: recovered.description,
      input_schema: recovered.input_schema,
      promoted_to_core: true,
    }
  }

  return {
    status: "success",
    tool_name: entry.name,
    description: entry.description,
    input_schema: entry.input_schema,
    promoted_to_core: true,
  }
}

/**
 * Format a `DiscoverToolResult` as the textual tool_result content the
 * model will see.  We render JSON to keep things model-agnostic — every
 * provider will produce useable JSON parsing for this.
 */
export function formatDiscoverToolResultText(
  result: DiscoverToolResult
): string {
  if (result.status === "success") {
    const body = {
      tool_name: result.tool_name,
      description: result.description,
      input_schema: result.input_schema,
      next_step: `You may now call ${result.tool_name} directly. The full schema will remain loaded for the rest of this session.`,
    }
    return `[discover_tool success]\n${JSON.stringify(body, null, 2)}`
  }
  const body: Record<string, unknown> = {
    tool_name: result.tool_name,
    error: result.error,
  }
  if (result.available && result.available.length > 0) {
    body.available_sample = result.available
  }
  return `[discover_tool error]\n${JSON.stringify(body, null, 2)}`
}
