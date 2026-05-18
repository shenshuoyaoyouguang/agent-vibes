/**
 * Subagent definition types for the Cursor protocol bridge.
 *
 * Mirrors claude-code's `AgentDefinition` model (packages/builtin-tools/src/
 * tools/AgentTool/loadAgentsDir.ts) so the subagent surface mirrors what
 * Cursor / claude-code users already understand: built-in agents declared
 * in code, custom agents declared as `.cursor/agents/*.md` markdown files
 * with YAML frontmatter, plus an explicit tool allowlist / denylist that
 * is resolved at spawn time.
 *
 * Why we mirror claude-code rather than invent our own model:
 *   - The frontmatter shape (`name`, `description`, `tools`,
 *     `disallowedTools`, `model`, `maxTurns`) is what Cursor users already
 *     write today. Re-using the same fields means an `~/.cursor/agents/*.md`
 *     file works whether the user is on plain Cursor or through the bridge.
 *   - Resolving tools per-agent at spawn time (instead of a hard-coded list
 *     applied to every sub-agent) is what enables a `read-only research`
 *     agent and a `code-mod` agent to differ — claude-code's
 *     `resolveAgentTools()` is exactly this mechanism.
 *
 * The bridge's runtime constraint is stricter than claude-code's: a
 * sub-agent does NOT have a private ExecServerMessage channel back to the
 * IDE, so any tool requiring arbitrary filesystem / shell access (read_file,
 * list_directory, run_terminal_command, edit_file, delete_file, ...) is
 * unconditionally excluded from the sub-agent surface regardless of what
 * frontmatter says. See `subagent-tool-resolver.ts` for the hard exclusion
 * list.
 */

export type SubagentSource = "built-in" | "user" | "project"

export interface BaseSubagentDefinition {
  /** Stable identifier the model uses as `subagent_type` in `task` calls. */
  agentType: string

  /** Short human-friendly description shown in the `task` tool prompt to
   * help the model choose the right subagent. Mirrors claude-code's
   * `whenToUse` field. */
  whenToUse: string

  /** Optional allowlist of user-facing tool names (e.g. "semantic_search",
   * "web_fetch"). When omitted or set to ["*"], the sub-agent gets every
   * tool the bridge marks as `subagent-safe` (see
   * `subagent-tool-resolver.ts`). */
  tools?: string[]

  /** Optional denylist applied AFTER the allowlist. Use this to subtract a
   * tool from a wildcard surface ("*" minus "web_fetch" for an offline
   * agent, for example). */
  disallowedTools?: string[]

  /** Optional per-agent max turn override. When omitted the bridge uses the
   * top-level default (currently 20). */
  maxTurns?: number

  /** Optional model override. Special value `"inherit"` means use the
   * parent session's model. Anything else is treated as a model id and
   * routed by ModelRouterService like a top-level chat. */
  model?: string

  /** Where the definition came from — used purely for logging / debug. */
  source: SubagentSource
}

export interface BuiltInSubagentDefinition extends BaseSubagentDefinition {
  source: "built-in"
  /** Built-in agents compute their system prompt at spawn time so they can
   * react to runtime configuration (model selection, embedded search tools,
   * etc.) the same way claude-code's built-ins do. */
  getSystemPrompt: () => string
}

export interface CustomSubagentDefinition extends BaseSubagentDefinition {
  source: "user" | "project"
  /** Absolute path of the markdown file the definition was loaded from. */
  filePath: string
  /** Static system prompt taken verbatim from the markdown body. */
  systemPrompt: string
}

export type SubagentDefinition =
  | BuiltInSubagentDefinition
  | CustomSubagentDefinition

export function isBuiltInSubagent(
  definition: SubagentDefinition
): definition is BuiltInSubagentDefinition {
  return definition.source === "built-in"
}

export function isCustomSubagent(
  definition: SubagentDefinition
): definition is CustomSubagentDefinition {
  return definition.source === "user" || definition.source === "project"
}

/**
 * Resolve a subagent's effective system prompt regardless of whether it is
 * built-in (closure-driven) or custom (markdown body). Centralised here so
 * callers don't need to know the source variant.
 */
export function getSubagentSystemPrompt(
  definition: SubagentDefinition
): string {
  if (isBuiltInSubagent(definition)) {
    return definition.getSystemPrompt()
  }
  return definition.systemPrompt
}
