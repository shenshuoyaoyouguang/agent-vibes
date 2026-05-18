/**
 * Resolve which user-facing tool names a given sub-agent should see.
 *
 * Mirrors claude-code/packages/builtin-tools/src/tools/AgentTool/
 * agentToolUtils.ts::resolveAgentTools, with two differences:
 *
 *   1. The "available tools" pool is hard-clamped to the bridge's
 *      sub-agent-safe surface. Read-only file/search tools are handled
 *      by bridge-local executors; shell/edit/delete require the
 *      foreground Exec bridge and are still omitted from background
 *      workers.
 *
 *   2. The output is a list of user-facing tool names (e.g.
 *      "semantic_search", "web_fetch") rather than a list of Tool objects,
 *      because the bridge feeds these names to `buildToolsForApi()` to
 *      produce the actual tool definitions sent to the backend LLM.
 *
 * The resolver is the single point that decides what a sub-agent can do.
 * Both the dynamic `task` tool description (so the parent model knows
 * which sub-agent to pick) and the actual sub-agent worker
 * (`executeSubAgentTask`) MUST consult the same resolver to stay in sync.
 */

import type { SubagentDefinition } from "./types"

/**
 * The complete sub-agent-safe surface, expressed as user-facing tool
 * names. This is the universe a sub-agent's `tools: ["*"]` expands to,
 * and the maximum any sub-agent can ever access regardless of what its
 * frontmatter says.
 *
 * Tool families:
 *   1. Inline tools — handled inside the bridge (web, MCP, repo
 *      semantic search, todo, plan, lints, project metadata, reflect,
 *      knowledge_base, fetch_pull_request).
 *   2. Bridge-local read-only filesystem tools — grep_search,
 *      read_file, list_directory. These do not use the parent
 *      ExecServerMessage path because nested task UI progress and
 *      ExecClientMessage result delivery are separate protocol channels.
 *   3. Foreground ExecServerMessage tools — shell/edit/delete remain
 *      available to foreground sub-agents that explicitly receive them.
 *
 * Anything not in this list is unknown to the bridge and would fall
 * through to "[tool error] not in sub-agent context" at runtime.
 */
export const SUB_AGENT_SAFE_TOOL_NAMES: readonly string[] = [
  // Code / repo search tools (semantic + glob + path)
  "semantic_search",
  "deep_search",
  "read_semsearch_files",
  "file_search",
  "glob_search",
  "search_symbols",
  "go_to_definition",
  // Web tools
  "web_search",
  "web_fetch",
  "fetch",
  "exa_search",
  "exa_fetch",
  // Repo metadata / rules / lints
  "fetch_rules",
  "read_lints",
  "read_project",
  // Todo / plan
  "read_todos",
  "update_todos",
  "create_plan",
  // MCP
  "get_mcp_tools",
  "mcp_tool",
  "list_mcp_resources",
  "read_mcp_resource",
  // Knowledge / PR
  "knowledge_base",
  "fetch_pull_request",
  // Reflection
  "reflect",
  // ExecServerMessage tools — routed through SubagentExecBridgeService.
  // These let the bash / explore / custom sub-agents touch the real
  // filesystem and shell with the same protocol the parent agent uses.
  "run_terminal_command",
  "read_file",
  "list_directory",
  "grep_search",
  "edit_file_v2",
  "delete_file",
]

const SUB_AGENT_SAFE_SET = new Set(SUB_AGENT_SAFE_TOOL_NAMES)

export interface ResolvedSubagentToolSurface {
  /** Final list of user-facing tool names exposed to this sub-agent. */
  toolNames: string[]
  /** Tool names declared in the agent's allowlist that aren't in the
   * sub-agent-safe surface. Surfaced for warnings, not enforced. */
  ignoredAllowlistEntries: string[]
  /** True when the agent's `tools` field was undefined or `["*"]`. */
  hasWildcard: boolean
}

/**
 * Compute the effective tool surface for a sub-agent definition.
 *
 * Algorithm (mirrors claude-code's resolveAgentTools):
 *   1. Start from the sub-agent-safe pool (universe).
 *   2. If `tools` is undefined or `["*"]`, keep the whole pool.
 *      Otherwise take the intersection of `tools` and the pool. Anything
 *      in `tools` that isn't in the pool is reported as an ignored entry
 *      so the bridge can warn the user, but never silently elevated.
 *   3. Subtract `disallowedTools` from whatever survived step 2.
 *   4. Preserve the order of `SUB_AGENT_SAFE_TOOL_NAMES` so the model
 *      sees a stable tool ordering across spawns.
 */
export function resolveSubagentToolSurface(
  agent: SubagentDefinition
): ResolvedSubagentToolSurface {
  const declaredTools = agent.tools
  const hasWildcard =
    !declaredTools ||
    declaredTools.length === 0 ||
    (declaredTools.length === 1 && declaredTools[0] === "*")

  const ignoredAllowlistEntries: string[] = []
  let allowed: Set<string>
  if (hasWildcard) {
    allowed = new Set(SUB_AGENT_SAFE_SET)
  } else {
    allowed = new Set<string>()
    for (const declared of declaredTools) {
      const trimmed = declared.trim()
      if (!trimmed) continue
      if (trimmed === "*") {
        // Mid-list wildcard: union with the full pool, claude-code-style.
        for (const tool of SUB_AGENT_SAFE_SET) allowed.add(tool)
        continue
      }
      if (SUB_AGENT_SAFE_SET.has(trimmed)) {
        allowed.add(trimmed)
      } else {
        ignoredAllowlistEntries.push(trimmed)
      }
    }
  }

  const denySet = new Set(
    (agent.disallowedTools || [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
  for (const denied of denySet) {
    allowed.delete(denied)
  }

  // Preserve canonical ordering for prompt stability.
  const toolNames = SUB_AGENT_SAFE_TOOL_NAMES.filter((name) =>
    allowed.has(name)
  )

  return {
    toolNames,
    ignoredAllowlistEntries,
    hasWildcard,
  }
}

/** Convenience helper: just the tool names. */
export function resolveSubagentToolNames(agent: SubagentDefinition): string[] {
  return resolveSubagentToolSurface(agent).toolNames
}
