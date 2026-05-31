/**
 * Loads custom sub-agent definitions from project `.cursor/agents`
 * (each definition a `.md` file under the project root) and user
 * `~/.cursor/agents` (same shape, user scope).
 *
 * Mirrors claude-code/packages/builtin-tools/src/tools/AgentTool/
 * loadAgentsDir.ts, but adapted to the bridge:
 *   - No plugin / policy / flag layers — Cursor's surface only has user
 *     and project, so we keep the loader to those two scopes.
 *   - The frontmatter shape (`name`, `description`, optional `tools`,
 *     `disallowedTools`, `model`, `maxTurns`) is exactly what
 *     `claude-code` parses, so an `agents` markdown file authored for
 *     plain Cursor / claude-code drops in with no rewriting.
 *   - Project-scope wins on name conflicts, matching Cursor's documented
 *     precedence ("Project subagents take precedence when names conflict").
 *
 * The loader is read-on-demand and cheap (one `readdir` + per-file
 * `readFile`); we add a short-TTL fingerprint cache below so tool-result
 * continuation loops in the cursor stream service don't re-tokenize and
 * re-parse the same markdown files dozens of times per turn.
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

/**
 * Cache-key fingerprint for a single `.cursor/agents` directory.
 *
 * Composed of the directory's listed `.md` filenames each annotated
 * with `(mtimeMs, size)`.  Sorted to make the comparison
 * order-insensitive (file-system order is not contractual).
 *
 * If the fingerprint matches a cached one, the directory's contents
 * are guaranteed to be byte-identical to last time — POSIX `mtime`
 * resolution is sub-millisecond on every supported platform, and
 * `size` catches the edge case of a same-millisecond rewrite that
 * preserves length.
 */
type DirectoryFingerprint = string

/**
 * Per-directory cache entry.  We track the fingerprint that produced
 * the cached definitions, plus the wall-clock time of the last
 * fingerprint computation, so warm-path reads can elide the stat
 * sweep entirely within a short TTL.
 */
interface DirectoryCacheEntry {
  fingerprint: DirectoryFingerprint
  fingerprintedAt: number
  definitions: ReadonlyArray<CustomSubagentDefinition>
}

/**
 * Window during which we accept the cached fingerprint without
 * re-stating the directory.  Short enough that a developer editing
 * a `.cursor/agents` markdown file mid-session will see the change on
 * the next turn (turn boundaries are typically ≥ 1 s of network +
 * model latency anyway), long enough that a tool-result
 * continuation burst within a single turn never touches the
 * filesystem more than once.
 */
const DIRECTORY_FINGERPRINT_TTL_MS = 1000

@Injectable()
export class SubagentLoaderService {
  private readonly logger = new Logger(SubagentLoaderService.name)

  /**
   * Per-directory cache, keyed by absolute directory path.
   *
   * Two directories can be active simultaneously (one user, one
   * project), and the same project path can be revisited across
   * sessions, so the cache is keyed on the absolute resolved path
   * rather than the `(scope, cwd)` pair the public API uses.
   */
  private readonly directoryCache: Map<string, DirectoryCacheEntry> = new Map()

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
    const cached = this.directoryCache.get(dir)
    const now = Date.now()
    // Hot path: within the TTL window we trust the cache without
    // touching the filesystem at all.  This is what makes the
    // tool-result continuation loop on cursor-connect-stream IO-free
    // on its warm-path verify.
    if (cached && now - cached.fingerprintedAt < DIRECTORY_FINGERPRINT_TTL_MS) {
      return [...cached.definitions]
    }

    let entries: string[]
    try {
      const stats = statSync(dir)
      if (!stats.isDirectory()) {
        // The directory disappeared (or was never present).  Drop the
        // cache entry rather than serving stale definitions.
        this.directoryCache.delete(dir)
        return []
      }
      entries = readdirSync(dir)
    } catch {
      // Directory does not exist — that's the normal case, not an error.
      this.directoryCache.delete(dir)
      return []
    }

    // Cool path: TTL expired, but the contents may still be unchanged.
    // Build a stat-only fingerprint (cheap — one `statSync` per .md
    // file) and short-circuit if it matches the cached fingerprint.
    const mdEntries = entries.filter((entry) =>
      entry.toLowerCase().endsWith(".md")
    )
    const fingerprint = this.computeDirectoryFingerprint(dir, mdEntries)
    if (cached && cached.fingerprint === fingerprint) {
      // Refresh the TTL so the next warm path gets the cheap path
      // again, but do not re-parse the files.
      cached.fingerprintedAt = now
      return [...cached.definitions]
    }

    // Cold path: re-parse every .md file.  This is what the loader
    // used to do unconditionally on every call.
    const result: CustomSubagentDefinition[] = []
    for (const entry of mdEntries) {
      const filePath = join(dir, entry)
      const definition = this.loadFromFile(filePath, source)
      if (definition) result.push(definition)
    }
    this.directoryCache.set(dir, {
      fingerprint,
      fingerprintedAt: now,
      definitions: result,
    })
    return result
  }

  /**
   * Build a fingerprint from `(filename, mtimeMs, size)` triples.
   * Files that fail to stat are folded into the fingerprint as an
   * `?` placeholder so a transient EACCES still produces a stable
   * key (the next call retries naturally because the cache compares
   * fingerprints, not error states).
   */
  private computeDirectoryFingerprint(
    dir: string,
    mdEntries: string[]
  ): DirectoryFingerprint {
    const parts: string[] = []
    for (const entry of mdEntries) {
      const full = join(dir, entry)
      try {
        const stat = statSync(full)
        parts.push(`${entry}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        parts.push(`${entry}:?`)
      }
    }
    parts.sort()
    return parts.join("|")
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
