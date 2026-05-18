/**
 * Loads custom sub-agent definitions from `.cursor/agents/*.md` (project)
 * and `~/.cursor/agents/*.md` (user).
 *
 * Mirrors claude-code/packages/builtin-tools/src/tools/AgentTool/
 * loadAgentsDir.ts, but adapted to the bridge:
 *   - No plugin / policy / flag layers — Cursor's surface only has user
 *     and project, so we keep the loader to those two scopes.
 *   - The frontmatter shape (`name`, `description`, optional `tools`,
 *     `disallowedTools`, `model`, `maxTurns`) is exactly what
 *     `claude-code` parses, so a `.cursor/agents/*.md` file authored for
 *     plain Cursor / claude-code drops in with no rewriting.
 *   - Project-scope wins on name conflicts, matching Cursor's documented
 *     precedence ("Project subagents take precedence when names conflict").
 *
 * The loader is read-on-demand and cheap (one `readdir` + per-file
 * `readFile`), so we don't aggressively memoise — `getCustomSubagents()`
 * is invoked once per `task` tool dispatch.
 */

import { Injectable, Logger } from "@nestjs/common"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { parse as parseYamlDocument } from "yaml"

import type { CustomSubagentDefinition } from "./types"

const FRONTMATTER_DELIMITER = /^\s*---\s*$/

interface ParsedSubagentFrontmatter {
  name?: string
  description?: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  maxTurns?: number
}

@Injectable()
export class SubagentLoaderService {
  private readonly logger = new Logger(SubagentLoaderService.name)

  /**
   * Load all custom subagent definitions from disk. Project entries
   * (relative to the workspace cwd) override user entries with the same
   * `name`.
   *
   * @param projectCwd Absolute workspace path. When omitted, only the user
   *   directory is scanned. Pass the same `cwd` the bridge is using for the
   *   current session.
   */
  getCustomSubagents(projectCwd?: string): CustomSubagentDefinition[] {
    const userAgents = this.scanDirectory(
      join(homedir(), ".cursor", "agents"),
      "user"
    )
    const projectAgents = projectCwd
      ? this.scanDirectory(join(projectCwd, ".cursor", "agents"), "project")
      : []

    // Project-scope wins on name conflicts, matching Cursor's documented
    // precedence. Iterate user first, then project to overwrite.
    const byName = new Map<string, CustomSubagentDefinition>()
    for (const agent of userAgents) byName.set(agent.agentType, agent)
    for (const agent of projectAgents) byName.set(agent.agentType, agent)
    return Array.from(byName.values())
  }

  private scanDirectory(
    dir: string,
    source: "user" | "project"
  ): CustomSubagentDefinition[] {
    let entries: string[]
    try {
      const stats = statSync(dir)
      if (!stats.isDirectory()) return []
      entries = readdirSync(dir)
    } catch {
      // Directory does not exist — that's the normal case, not an error.
      return []
    }

    const result: CustomSubagentDefinition[] = []
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".md")) continue
      const filePath = join(dir, entry)
      const definition = this.loadFromFile(filePath, source)
      if (definition) result.push(definition)
    }
    return result
  }

  private loadFromFile(
    filePath: string,
    source: "user" | "project"
  ): CustomSubagentDefinition | null {
    let raw: string
    try {
      raw = readFileSync(filePath, "utf8")
    } catch (error) {
      this.logger.warn(
        `Failed to read sub-agent definition ${filePath}: ${String(error)}`
      )
      return null
    }

    const block = extractFrontmatterBlock(raw)
    if (block === null) {
      // Files without frontmatter are silently skipped — claude-code does
      // the same, treating them as co-located reference docs rather than
      // agent definitions.
      return null
    }

    let frontmatter: ParsedSubagentFrontmatter
    try {
      frontmatter = parseFrontmatter(block)
    } catch (error) {
      this.logger.warn(
        `Failed to parse sub-agent frontmatter in ${filePath}: ${String(error)}`
      )
      return null
    }

    if (!frontmatter.name) {
      // Files with frontmatter but no `name` are also skipped silently —
      // these are typically partial drafts, not failures we should block on.
      return null
    }
    if (!frontmatter.description) {
      this.logger.warn(
        `Sub-agent definition ${filePath} is missing required 'description' field; skipping.`
      )
      return null
    }

    const systemPrompt = stripFrontmatter(raw, block).trim()
    if (!systemPrompt) {
      this.logger.warn(
        `Sub-agent definition ${filePath} has empty markdown body (no system prompt); skipping.`
      )
      return null
    }

    return {
      agentType: frontmatter.name.trim(),
      whenToUse: frontmatter.description.trim(),
      tools: frontmatter.tools,
      disallowedTools: frontmatter.disallowedTools,
      model: frontmatter.model,
      maxTurns: frontmatter.maxTurns,
      source,
      filePath,
      systemPrompt,
    }
  }
}

/* ---------------- internal helpers ---------------- */

function extractFrontmatterBlock(content: string): string | null {
  const normalized = content.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  // Skip leading blank lines but require the first non-blank line to be ---.
  let firstNonBlank = 0
  while (firstNonBlank < lines.length && lines[firstNonBlank]!.trim() === "") {
    firstNonBlank++
  }
  if (
    firstNonBlank >= lines.length ||
    !FRONTMATTER_DELIMITER.test(lines[firstNonBlank]!)
  ) {
    return null
  }
  const closing = lines.findIndex(
    (line, index) => index > firstNonBlank && FRONTMATTER_DELIMITER.test(line)
  )
  if (closing < 0) return null
  return lines.slice(firstNonBlank + 1, closing).join("\n")
}

function stripFrontmatter(content: string, block: string): string {
  // Reconstruct everything past the closing `---` line. We re-find the
  // block boundary instead of trying to do string math, because tabs /
  // CRLF would otherwise drift.
  const normalized = content.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  let firstNonBlank = 0
  while (firstNonBlank < lines.length && lines[firstNonBlank]!.trim() === "") {
    firstNonBlank++
  }
  if (
    firstNonBlank >= lines.length ||
    !FRONTMATTER_DELIMITER.test(lines[firstNonBlank]!)
  ) {
    return content
  }
  const closing = lines.findIndex(
    (line, index) => index > firstNonBlank && FRONTMATTER_DELIMITER.test(line)
  )
  if (closing < 0) return content
  void block
  return lines.slice(closing + 1).join("\n")
}

function parseFrontmatter(block: string): ParsedSubagentFrontmatter {
  const raw: unknown = parseYamlDocument(block)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }
  const obj = raw as Record<string, unknown>

  const result: ParsedSubagentFrontmatter = {}
  if (typeof obj.name === "string" && obj.name.trim()) {
    result.name = obj.name.trim()
  }
  if (typeof obj.description === "string" && obj.description.trim()) {
    // Frontmatter description supports YAML block scalars or escaped
    // newlines — match claude-code's behaviour of converting `\n`.
    result.description = obj.description.trim().replace(/\\n/g, "\n")
  }
  if (typeof obj.model === "string" && obj.model.trim()) {
    result.model = obj.model.trim()
  }
  if (typeof obj.maxTurns === "number" && Number.isFinite(obj.maxTurns)) {
    result.maxTurns = Math.max(1, Math.floor(obj.maxTurns))
  }
  result.tools = coerceToolsField(obj.tools)
  result.disallowedTools = coerceToolsField(obj.disallowedTools)
  return result
}

function coerceToolsField(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) {
    const list = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
    return list.length > 0 ? list : undefined
  }
  if (typeof value === "string") {
    // claude-code accepts a comma-separated string for the `tools` /
    // `disallowedTools` frontmatter — keep parity.
    const list = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    return list.length > 0 ? list : undefined
  }
  return undefined
}
