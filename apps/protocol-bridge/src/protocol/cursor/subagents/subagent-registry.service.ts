/**
 * Aggregates built-in and custom sub-agent definitions into a single
 * registry consulted by the `task` tool dispatcher.
 *
 * Mirrors the role of claude-code's `getAgentDefinitionsWithOverrides()`
 * but without the plugin / policy / flag layers — Cursor's official
 * surface only has user-level (`~/.cursor/agents/`) and project-level
 * (`.cursor/agents/`), plus the built-in cohort baked into the bridge.
 *
 * Design notes:
 *   - Built-in agents always win on agentType conflicts. A user shouldn't
 *     accidentally shadow `general-purpose` and break the dynamic prompt
 *     fallback. Same precedence claude-code uses.
 *   - We re-scan disk on every `getAll()` call. Loader is cheap and the
 *     call site (`task` tool dispatch) is human-paced. This avoids stale
 *     cache after the user adds / edits an agent file.
 */

import { Injectable, Logger } from "@nestjs/common"

import { getBuiltInSubagents } from "./built-in-agents"
import { SubagentLoaderService } from "./subagent-loader.service"
import type { SubagentDefinition } from "./types"

@Injectable()
export class SubagentRegistryService {
  private readonly logger = new Logger(SubagentRegistryService.name)

  constructor(private readonly loader: SubagentLoaderService) {}

  /** Return every visible sub-agent for the given workspace cwd. Built-ins
   * always come first; custom agents are appended unless they collide with
   * a built-in name (in which case the built-in wins and we log a warning). */
  getAll(projectCwd?: string): SubagentDefinition[] {
    const builtIns = getBuiltInSubagents()
    const builtInNames = new Set(builtIns.map((agent) => agent.agentType))

    const custom = this.loader.getCustomSubagents(projectCwd)
    const result: SubagentDefinition[] = [...builtIns]

    for (const agent of custom) {
      if (builtInNames.has(agent.agentType)) {
        this.logger.warn(
          `Custom sub-agent '${agent.agentType}' (${agent.filePath}) ` +
            `collides with a built-in name; built-in wins.`
        )
        continue
      }
      result.push(agent)
    }
    return result
  }

  /** Look up a single sub-agent by its `agentType`. Returns undefined when
   * the model passes a `subagent_type` that nobody declared — the caller
   * should fall back to `general-purpose`. */
  findByType(
    agentType: string,
    projectCwd?: string
  ): SubagentDefinition | undefined {
    if (!agentType) return undefined
    const normalized = agentType.trim().toLowerCase()
    if (!normalized) return undefined
    return this.getAll(projectCwd).find(
      (agent) => agent.agentType.trim().toLowerCase() === normalized
    )
  }
}
