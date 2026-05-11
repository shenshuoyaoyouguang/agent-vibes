import type { CursorRule } from "../../../gen/agent/v1_pb"

export type CursorSkillActivationReason =
  | "manual"
  | "selected"
  | "previously_loaded"
  | "path_match"

export interface CursorSkillMetadata {
  name: string
  description?: string
  whenToUse?: string
  paths: string[]
  fullPath: string
  content: string
  ruleType?: string
  active: boolean
  activationReason?: CursorSkillActivationReason
}

export interface CursorSkillPolicyInput {
  rules?: CursorRule[]
  selectedRulePaths?: string[]
  selectedRuleNames?: string[]
  activeSkillNames?: string[]
  projectRoot?: string
  contextPaths?: string[]
}

export interface CursorSkillPolicyResult {
  promptRules: CursorRule[]
  availableSkills: CursorSkillMetadata[]
  activeSkills: CursorSkillMetadata[]
  inactiveSkills: CursorSkillMetadata[]
  suppressedSkills: CursorSkillMetadata[]
}

interface ParsedFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  paths: string[]
}

const FRONTMATTER_FIELD_ALIASES = new Map([
  ["when_to_use", "whenToUse"],
  ["when-to-use", "whenToUse"],
  ["whenToUse", "whenToUse"],
])

export function resolveCursorSkillPolicy(
  input: CursorSkillPolicyInput
): CursorSkillPolicyResult {
  const rules = input.rules || []
  const selectedPaths = new Set(
    (input.selectedRulePaths || []).map((item) => normalizePathForMatch(item))
  )
  const selectedNames = new Set(
    (input.selectedRuleNames || []).map((item) => normalizeSkillName(item))
  )
  const activeNames = new Set(
    (input.activeSkillNames || []).map((item) => normalizeSkillName(item))
  )
  const contextPaths = input.contextPaths || []

  const promptRules: CursorRule[] = []
  const availableSkills: CursorSkillMetadata[] = []
  const activeSkills: CursorSkillMetadata[] = []
  const inactiveSkills: CursorSkillMetadata[] = []
  const suppressedSkills: CursorSkillMetadata[] = []

  for (const rule of rules) {
    const metadata = getCursorSkillMetadata(rule)
    if (!metadata) {
      promptRules.push(rule)
      continue
    }

    const activationReason = resolveSkillActivationReason({
      metadata,
      rule,
      selectedPaths,
      selectedNames,
      activeNames,
      projectRoot: input.projectRoot,
      contextPaths,
    })
    const active = Boolean(activationReason)
    const skill = {
      ...metadata,
      active,
      activationReason: activationReason || undefined,
    }

    availableSkills.push(skill)
    if (active) {
      activeSkills.push(skill)
      promptRules.push(rule)
    } else {
      inactiveSkills.push(skill)
      suppressedSkills.push(skill)
    }
  }

  return {
    promptRules,
    availableSkills: dedupeSkillsByName(availableSkills),
    activeSkills: dedupeSkillsByName(activeSkills),
    inactiveSkills: dedupeSkillsByName(inactiveSkills),
    suppressedSkills: dedupeSkillsByName(suppressedSkills),
  }
}

export function getCursorSkillMetadata(
  rule: CursorRule
): Omit<CursorSkillMetadata, "active" | "activationReason"> | null {
  const frontmatter = parseSkillFrontmatter(rule.content || "")
  const pathSkillName = extractSkillNameFromPath(rule.fullPath || "")
  const name = normalizeSkillName(frontmatter.name || pathSkillName || "")
  const typeCase = rule.type?.type.case
  const looksLikeSkill =
    Boolean(name) &&
    (typeCase === "agentFetched" ||
      typeCase === "manuallyAttached" ||
      isSkillFilePath(rule.fullPath || "") ||
      Boolean(frontmatter.name))

  if (!looksLikeSkill || !name) {
    return null
  }

  const agentFetchedDescription =
    typeCase === "agentFetched" ? rule.type?.type.value.description : undefined

  return {
    name,
    description:
      frontmatter.description || agentFetchedDescription || undefined,
    whenToUse: frontmatter.whenToUse,
    paths: frontmatter.paths,
    fullPath: rule.fullPath || "",
    content: rule.content || "",
    ruleType: typeCase,
  }
}

export function findCursorSkillByName(
  rules: CursorRule[] | undefined,
  skillName: string
): CursorSkillMetadata | null {
  const requestedName = normalizeSkillName(skillName)
  if (!requestedName) return null

  for (const rule of rules || []) {
    const metadata = getCursorSkillMetadata(rule)
    if (metadata && metadata.name === requestedName) {
      return { ...metadata, active: false }
    }
  }
  return null
}

export function findCursorSkillForInternalPath(
  rules: CursorRule[] | undefined,
  rawPath: string
): CursorSkillMetadata | null {
  const targetPath = normalizePathForMatch(rawPath).toLowerCase()
  if (!targetPath) return null

  for (const rule of rules || []) {
    const metadata = getCursorSkillMetadata(rule)
    if (!metadata) continue
    const skillRoot = normalizePathForMatch(
      dirname(metadata.fullPath)
    ).toLowerCase()
    if (skillRoot && pathIsInside(targetPath, skillRoot)) {
      return { ...metadata, active: false }
    }
    if (metadata.name === "canvas" && isCursorCanvasProjectPath(targetPath)) {
      return { ...metadata, active: false }
    }
  }

  return null
}

export function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizePathForMatch(value: string): string {
  return value.split("\\").join("/")
}

export function extractCursorRuleFrontmatterName(
  content: string
): string | null {
  return parseSkillFrontmatter(content).name || null
}

function resolveSkillActivationReason(input: {
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
  rule: CursorRule
  selectedPaths: Set<string>
  selectedNames: Set<string>
  activeNames: Set<string>
  projectRoot?: string
  contextPaths: string[]
}): CursorSkillActivationReason | null {
  const { metadata, rule, selectedPaths, selectedNames, activeNames } = input
  if (rule.type?.type.case === "manuallyAttached") {
    return "manual"
  }
  if (selectedPaths.has(normalizePathForMatch(metadata.fullPath))) {
    return "selected"
  }
  if (selectedNames.has(metadata.name)) {
    return "selected"
  }
  if (activeNames.has(metadata.name)) {
    return "previously_loaded"
  }
  if (
    metadata.paths.length > 0 &&
    input.contextPaths.some((contextPath) =>
      skillPathPatternsMatch(metadata.paths, contextPath, input.projectRoot)
    )
  ) {
    return "path_match"
  }
  return null
}

function dedupeSkillsByName(
  skills: CursorSkillMetadata[]
): CursorSkillMetadata[] {
  const seen = new Set<string>()
  const result: CursorSkillMetadata[] = []
  for (const skill of skills) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    result.push(skill)
  }
  return result
}

function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content
    .trimStart()
    .split("\r\n")
    .join("\n")
    .split("\r")
    .join("\n")
  const lines = normalized.split("\n")
  if ((lines[0] || "").trim() !== "---") {
    return { paths: [] }
  }

  const fields: Record<string, string | string[]> = {}
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] || ""
    const trimmed = line.trim()
    if (trimmed === "---") break
    if (!trimmed || trimmed.startsWith("#")) continue

    const separator = trimmed.indexOf(":")
    if (separator <= 0) continue

    const rawKey = trimmed.slice(0, separator).trim()
    const key = FRONTMATTER_FIELD_ALIASES.get(rawKey) || rawKey
    const rawValue = trimmed.slice(separator + 1).trim()

    if (
      rawValue === "|-" ||
      rawValue === "|" ||
      rawValue === ">-" ||
      rawValue === ">"
    ) {
      const blockLines: string[] = []
      for (index = index + 1; index < lines.length; index++) {
        const next = lines[index] || ""
        if (next.trim() === "---") {
          index--
          break
        }
        if (
          next.length > 0 &&
          !next.startsWith(" ") &&
          !next.startsWith("\t")
        ) {
          index--
          break
        }
        blockLines.push(next.trim())
      }
      fields[key] = blockLines.join(" ").trim()
      continue
    }

    if (rawValue === "") {
      const values: string[] = []
      for (index = index + 1; index < lines.length; index++) {
        const next = lines[index] || ""
        const nextTrimmed = next.trim()
        if (nextTrimmed === "---") {
          index--
          break
        }
        if (!nextTrimmed) continue
        if (!nextTrimmed.startsWith("- ")) {
          index--
          break
        }
        values.push(stripMatchingQuotes(nextTrimmed.slice(2).trim()))
      }
      fields[key] = values
      continue
    }

    fields[key] = stripMatchingQuotes(rawValue)
  }

  return {
    name: asString(fields.name),
    description: asString(fields.description),
    whenToUse: asString(fields.whenToUse),
    paths: asStringArray(fields.paths),
  }
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asStringArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item) => item.trim())
  if (typeof value !== "string" || !value.trim()) return []
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => stripMatchingQuotes(item.trim()))
      .filter((item) => item.length > 0)
  }
  return [value]
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === "'" || first === '"') && first === last) {
    return value.slice(1, -1)
  }
  return value
}

function extractSkillNameFromPath(rawPath: string): string | null {
  const normalizedPath = normalizePathForMatch(rawPath)
  const segments = normalizedPath.split("/").filter(Boolean)
  const fileName = segments.at(-1) || ""
  if (fileName.toLowerCase() !== "skill.md") return null
  return segments.at(-2) || null
}

function isSkillFilePath(rawPath: string): boolean {
  return Boolean(extractSkillNameFromPath(rawPath))
}

function skillPathPatternsMatch(
  patterns: string[],
  rawPath: string,
  projectRoot?: string
): boolean {
  const normalizedPath = normalizePathForMatch(rawPath)
  const normalizedRoot = projectRoot ? normalizePathForMatch(projectRoot) : ""
  const relativePath =
    normalizedRoot && pathIsInside(normalizedPath, normalizedRoot)
      ? normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "")
      : normalizedPath

  return patterns.some((pattern) =>
    globLikePatternMatches(pattern, relativePath)
  )
}

function globLikePatternMatches(pattern: string, rawPath: string): boolean {
  const normalizedPattern = normalizePathForMatch(pattern).replace(/^\/+/, "")
  const normalizedPath = normalizePathForMatch(rawPath).replace(/^\/+/, "")
  if (!normalizedPattern) return false
  if (normalizedPattern === normalizedPath) return true
  if (!normalizedPattern.includes("*")) {
    return pathIsInside(normalizedPath, normalizedPattern)
  }
  const regexp = globLikePatternToRegExp(normalizedPattern)
  return regexp.test(normalizedPath)
}

function globLikePatternToRegExp(pattern: string): RegExp {
  let source = "^"
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    const next = pattern[index + 1]
    if (char === "*" && next === "*") {
      source += ".*"
      index++
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    source += escapeRegExp(char || "")
  }
  source += "$"
  return new RegExp(source)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function pathIsInside(rawPath: string, rawParent: string): boolean {
  const pathValue = normalizePathForMatch(rawPath).replace(/\/+$/, "")
  const parent = normalizePathForMatch(rawParent).replace(/\/+$/, "")
  return pathValue === parent || pathValue.startsWith(`${parent}/`)
}

function dirname(rawPath: string): string {
  const normalized = normalizePathForMatch(rawPath)
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(0, index) : ""
}

function isCursorCanvasProjectPath(normalizedLowerPath: string): boolean {
  const segments = normalizedLowerPath.split("/").filter(Boolean)
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] !== ".cursor" || segments[index + 1] !== "projects") {
      continue
    }
    const projectSegments = segments.slice(index + 2)
    return (
      projectSegments.includes("canvases") ||
      (projectSegments.at(-1) || "").endsWith(".canvas.tsx")
    )
  }
  return false
}
