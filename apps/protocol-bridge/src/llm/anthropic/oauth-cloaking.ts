/**
 * Claude Code CLI cloaking layer for OAuth-secured Anthropic traffic.
 *
 * When `clientMode === "claude-code-cli"` and the active credential is an
 * Anthropic OAuth access token (`sk-ant-oat...`), we rewrite the request
 * body so it carries the same wire shape that Claude Code v2.1.142 emits:
 *
 *   1. system[0] = `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...; cch=00000;`
 *      (suppressed entirely when CLAUDE_CODE_ATTRIBUTION_HEADER is
 *      explicitly disabled, or omitted on Bedrock / anthropicAws / mantle
 *      providers — matching the binary's `Ci_` short-circuit)
 *   2. system[1] = "You are Claude Code, Anthropic's official CLI for Claude."
 *   3. system[2] = canonical static prompt (intro + system + doing-tasks +
 *      tone + output-efficiency)
 *   4. The caller's original `system` content is sanitised and prepended to
 *      the first user message inside a `<system-reminder>` block.
 *   5. `metadata.user_id` is populated with a stable fake UUID so absent or
 *      arbitrary user ids no longer fingerprint the request.
 *   6. Third-party tool names (lowercase forms like `bash`, `glob`, ...) are
 *      remapped to Claude Code's TitleCase equivalents (`Bash`, `Glob`),
 *      with a per-request reverse map so the response stream can be
 *      restored to whatever the client originally sent.
 *
 * The `cch=` field is a literal `00000` placeholder. The v2.1.142 binary's
 * `Ci_` function emits ` cch=00000;` verbatim with no signing step — we
 * mirror that exactly. (Earlier versions of this code computed an
 * xxHash64 over the body and wrote it into `cch`; that produced a value
 * that almost never matched real CC traffic and acted as a stable
 * non-CC fingerprint.)
 *
 * `claude-3-5-haiku` model variants skip the system prompt rewrite and
 * the billing header injection because Anthropic does not cloak Haiku
 * traffic the same way.
 */

import { createHash } from "crypto"

import {
  CLAUDE_CODE_AGENT_IDENTIFIER,
  CLAUDE_CODE_STATIC_PROMPT,
  FORWARDED_SYSTEM_PROMPT_SANITISED,
  getDefaultCcVersion,
  isAttributionHeaderDisabled,
} from "./claude-code-instructions"

const CLAUDE_CCH_FINGERPRINT_SALT = "59cf53e54c78"

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:"
const CCH_LITERAL = "00000"

/**
 * Providers that match the v2.1.142 binary's
 * `kq()==="bedrock"||kq()==="anthropicAws"||kq()==="mantle"` branch:
 * `Ci_` omits the entire ` cch=00000;` segment for these. The default
 * "anthropic" path keeps it.
 */
export type CcCliProvider = "anthropic" | "bedrock" | "anthropicAws" | "mantle"

/**
 * Tool-name remap that aligns third-party clients with Claude Code's
 * TitleCase tool naming. Claude Code emits these names verbatim and
 * Anthropic uses them as a fingerprinting signal — non-CC clients that
 * use lowercase `bash` get classified as third-party traffic.
 */
const OAUTH_TOOL_RENAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  question: "Question",
  skill: "Skill",
  ls: "LS",
  todoread: "TodoRead",
  notebookedit: "NotebookEdit",
}

/**
 * Currently empty — every tool listed here is mapped instead of removed.
 * Kept as a separate set so future deprecations stay surgical.
 */
const OAUTH_TOOLS_TO_REMOVE: ReadonlySet<string> = new Set<string>()

export interface CcCliCloakingOptions {
  apiKey: string
  /**
   * Override CC version emitted in `cc_version`. Defaults to the
   * dynamically-resolved local CC binary version (see
   * `getDefaultCcVersion`).
   */
  version?: string
  /**
   * Override `cc_entrypoint`. Defaults to "unknown" — matching
   * `process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"` in the v2.1.142
   * binary's `Ci_`. Callers that can recover a real entrypoint from the
   * inbound User-Agent (`claude-cli/<v> (external, <entrypoint>)`)
   * should pass it explicitly.
   */
  entrypoint?: string
  /** Optional `cc_workload` segment forwarded from the caller. */
  workload?: string
  /**
   * Provider classification — determines whether ` cch=00000;` appears
   * in the billing header. Defaults to "anthropic" (cch present).
   */
  provider?: CcCliProvider
  /**
   * Inbound request headers, used by the "is this already real CC?"
   * probe to decide whether to skip the cloaking pipeline. When the
   * client is the real `claude` CLI (routed through cc-cli-integration)
   * its body already carries the canonical billing header / agent
   * prompt / TitleCase tools / metadata.user_id — recomputing them
   * with our approximations would replace correct bytes with
   * fingerprint-able near-misses. See `looksLikeRealCcCliRequest`.
   */
  forwardHeaders?: Record<string, string | undefined>
  /**
   * When false the upstream sees the body as-is (no cloaking applied).
   * Used by the centralized hook in AnthropicApiService to keep the
   * branching localised.
   */
  enabled: boolean
  /**
   * Treat the model as exempt from cloaking. Real Claude Code skips
   * Haiku 3.5 in `applyCloaking`, so we mirror that here.
   */
  modelExempt: boolean
}

export interface CcCliCloakingResult {
  /**
   * Map keyed on the upstream (rewritten) tool name pointing back to the
   * client-supplied original. Callers must apply
   * `restoreOAuthToolNamesFromResponse` / `...FromStreamLine` with this
   * map so the client's response references the names it actually sent.
   *
   * Empty when no rewrites occurred or cloaking was disabled.
   */
  oauthToolReverseMap: Record<string, string>
  /**
   * Whether the cloaking pipeline detected an inbound request that
   * already looks like real Claude Code CLI traffic and passed the body
   * through untouched. Useful for telemetry.
   */
  passThrough: boolean
}

/**
 * Heuristic that recognises requests originating from the real Claude
 * Code CLI binary (routed through cc-cli-integration's sentinel-based
 * `~/.claude/settings.json` setup). When true, the caller's body
 * already carries every artefact the cloaking pipeline would otherwise
 * recreate, and our approximations would only introduce drift.
 *
 * The probe uses three independent signals so a single mimicked field
 * (e.g. a third-party client setting User-Agent: claude-cli/...) is
 * insufficient. Two-of-three matches qualify as real CC.
 *
 * Signals:
 *   1. `User-Agent` starts with `claude-cli/` (Stainless SDK device
 *      profile shape only the official CLI emits unmodified).
 *   2. `system[0]` already looks like the canonical billing header.
 *   3. `metadata.user_id` is present and non-empty (real CC always
 *      persists a UUID).
 */
export function looksLikeRealCcCliRequest(
  body: Record<string, unknown> | undefined,
  forwardHeaders?: Record<string, string | undefined>
): boolean {
  if (!body) return false

  const userAgent = forwardHeaders?.["user-agent"]?.toLowerCase().trim() || ""
  const uaSignal = userAgent.startsWith("claude-cli/")

  const system = body.system
  const firstBlockText =
    Array.isArray(system) &&
    system.length > 0 &&
    system[0] &&
    typeof system[0] === "object" &&
    typeof (system[0] as { text?: unknown }).text === "string"
      ? (system[0] as { text: string }).text
      : ""
  const billingSignal = firstBlockText.startsWith(BILLING_HEADER_PREFIX)

  const metadata = body.metadata
  const userId =
    metadata && typeof metadata === "object"
      ? (metadata as { user_id?: unknown }).user_id
      : undefined
  const userIdSignal = typeof userId === "string" && userId.trim().length > 0

  // Require at least two signals — single-field mimicry shouldn't
  // bypass the pipeline.
  const signalCount =
    (uaSignal ? 1 : 0) + (billingSignal ? 1 : 0) + (userIdSignal ? 1 : 0)
  return signalCount >= 2
}

/**
 * Apply the full cloaking pipeline to `body`. Mutates `body` in place to
 * keep memory pressure low for large payloads.
 *
 * When `looksLikeRealCcCliRequest` returns true the pipeline is a
 * pass-through: the inbound bytes already match what real CC would
 * have sent, and recomputing them with our approximations risks
 * replacing correct values with subtly different ones (the fingerprint
 * algorithm in `computeFingerprint` is known-not-verified, the system
 * prompt blocks are pinned to v2.1.63 wording rather than per-version
 * dynamic, and the tool-name map is a no-op for CC's TitleCase output).
 */
export function applyCcCliCloaking(
  body: Record<string, unknown>,
  options: CcCliCloakingOptions
): CcCliCloakingResult {
  if (!options.enabled) {
    return { oauthToolReverseMap: {}, passThrough: false }
  }

  if (looksLikeRealCcCliRequest(body, options.forwardHeaders)) {
    return { oauthToolReverseMap: {}, passThrough: true }
  }

  const reverseMap = remapOAuthToolNames(body)

  if (!options.modelExempt) {
    rewriteSystemForCcCli(body, {
      version: options.version || getDefaultCcVersion(),
      entrypoint: options.entrypoint || "unknown",
      workload: options.workload || "",
      provider: options.provider ?? "anthropic",
      attributionDisabled: isAttributionHeaderDisabled(),
    })
  }

  injectFakeUserId(body, options.apiKey)

  return { oauthToolReverseMap: reverseMap, passThrough: false }
}

// ── billing header ───────────────────────────────────────────────────

interface BillingContext {
  version: string
  entrypoint: string
  workload: string
  provider: CcCliProvider
  attributionDisabled: boolean
}

function rewriteSystemForCcCli(
  body: Record<string, unknown>,
  ctx: BillingContext
): void {
  const originalSystem = body.system
  const messageText = extractFirstSystemText(originalSystem)
  const billingText = ctx.attributionDisabled
    ? null
    : buildBillingHeader(messageText, ctx)

  const systemArray: TextBlock[] = []
  if (billingText !== null) {
    systemArray.push({ type: "text", text: billingText })
  }
  systemArray.push({ type: "text", text: CLAUDE_CODE_AGENT_IDENTIFIER })
  systemArray.push({ type: "text", text: CLAUDE_CODE_STATIC_PROMPT })

  body.system = systemArray

  const hasUserSystem = collectUserSystemParts(originalSystem).length > 0
  if (hasUserSystem) {
    const reminder = `<system-reminder>
As you answer the user's questions, you can use the following context from the system:
${FORWARDED_SYSTEM_PROMPT_SANITISED}

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
`
    // The OAuth flow always replaces user system content with the
    // sanitised reminder; the actual original text is intentionally
    // dropped (CLIProxyAPI's `sanitizeForwardedSystemPrompt` returns a
    // fixed 3-line neutral string regardless of input).
    prependToFirstUserMessage(body, reminder)
  }
}

interface TextBlock {
  type: "text"
  text: string
  cache_control?: Record<string, unknown>
}

function extractFirstSystemText(system: unknown): string {
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    for (const block of system) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        const text = (block as { text?: unknown }).text
        if (typeof text === "string") return text
      }
    }
  }
  return ""
}

function collectUserSystemParts(system: unknown): string {
  if (typeof system === "string") {
    return system.trim()
  }
  if (!Array.isArray(system)) return ""

  const parts: string[] = []
  for (const block of system) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      const text = (block as { text?: unknown }).text
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim())
      }
    }
  }
  return parts.join("\n\n")
}

function buildBillingHeader(messageText: string, ctx: BillingContext): string {
  const buildHash = computeFingerprint(messageText, ctx.version)
  const cchPart = ctx.provider === "anthropic" ? ` cch=${CCH_LITERAL};` : ""
  const workloadPart = ctx.workload ? ` cc_workload=${ctx.workload};` : ""
  return `${BILLING_HEADER_PREFIX} cc_version=${ctx.version}.${buildHash}; cc_entrypoint=${ctx.entrypoint};${cchPart}${workloadPart}`
}

function computeFingerprint(messageText: string, version: string): string {
  // FIXME: this fingerprint algorithm (SHA256 of salt + 3 indexed chars +
  // version, take first 3 hex) was inherited from CLIProxyAPI and has not
  // been directly verified against the v2.1.142 binary. The binary's
  // `Ci_(H)` accepts an opaque `H` whose construction site is not
  // visible in the strings dump.
  const indices = [4, 7, 20]
  const codepoints = Array.from(messageText)
  const probe = indices
    .map((idx) => (idx < codepoints.length ? codepoints[idx] : "0"))
    .join("")
  const digest = createHash("sha256")
    .update(CLAUDE_CCH_FINGERPRINT_SALT + probe + version)
    .digest("hex")
  return digest.slice(0, 3)
}

function prependToFirstUserMessage(
  body: Record<string, unknown>,
  text: string
): void {
  const messages = body.messages
  if (!Array.isArray(messages)) return

  let firstUserIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const role = (messages[i] as { role?: unknown }).role
    if (role === "user") {
      firstUserIdx = i
      break
    }
  }
  if (firstUserIdx < 0) return

  const target = messages[firstUserIdx] as { content?: unknown }
  const content = target.content
  if (Array.isArray(content)) {
    target.content = [{ type: "text", text }, ...(content as unknown[])]
  } else if (typeof content === "string") {
    target.content = text + content
  } else {
    target.content = [{ type: "text", text }]
  }
}

/**
 * Inject `metadata.user_id` if missing or invalid. Mirrors CLIProxyAPI's
 * `injectFakeUserID`: it produces a deterministic UUID per credential by
 * hashing `apiKey`, so retried/cached requests share the same user id
 * across the bridge process.
 */
function injectFakeUserId(body: Record<string, unknown>, apiKey: string): void {
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : null

  const existing =
    metadata && typeof metadata.user_id === "string"
      ? metadata.user_id.trim()
      : ""

  if (existing && isValidUserId(existing)) {
    return
  }

  const userId = stableUserIdFromKey(apiKey)
  if (metadata) {
    metadata.user_id = userId
    return
  }

  body.metadata = { user_id: userId }
}

function isValidUserId(value: string): boolean {
  // Loose UUIDv4-like validation matches CLIProxyAPI's `IsValidUserID`
  // which only requires the string to be non-empty and free of spaces.
  return value.length > 0 && !/\s/.test(value)
}

function stableUserIdFromKey(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("hex")
  // Format as a UUIDv4-shaped string for clients that validate the shape.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    "4" + digest.slice(13, 16),
    "8" + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-")
}

// ── OAuth tool-name remap ────────────────────────────────────────────

/**
 * Rewrite tool names (in `tools[]`, `tool_choice`, and `messages` content
 * blocks) from third-party lowercase forms to Claude Code's TitleCase
 * canonical names. Returns a per-request reverse map so the response can
 * be restored to whatever name the client originally sent.
 *
 * The reverse map MUST be per-request, not global: clients sometimes mix
 * casing (e.g. Amp CLI sends `Bash` and `glob` together). A global reverse
 * map would corrupt response references.
 */
function remapOAuthToolNames(
  body: Record<string, unknown>
): Record<string, string> {
  const reverseMap: Record<string, string> = {}
  const recordRename = (original: string, renamed: string) => {
    if (!(renamed in reverseMap)) {
      reverseMap[renamed] = original
    }
  }

  // tools[]
  if (Array.isArray(body.tools)) {
    const filtered: unknown[] = []
    for (const rawTool of body.tools) {
      if (!rawTool || typeof rawTool !== "object") {
        filtered.push(rawTool)
        continue
      }
      const tool = rawTool as Record<string, unknown>
      const builtinType = typeof tool.type === "string" ? tool.type : ""
      if (builtinType) {
        // Anthropic built-in tools (web_search_20250305, etc.) keep their
        // type marker and are passed through unchanged.
        filtered.push(tool)
        continue
      }
      const name = typeof tool.name === "string" ? tool.name : ""
      if (OAUTH_TOOLS_TO_REMOVE.has(name)) {
        continue
      }
      const renamed = OAUTH_TOOL_RENAME_MAP[name]
      if (renamed && renamed !== name) {
        tool.name = renamed
        recordRename(name, renamed)
      }
      filtered.push(tool)
    }
    body.tools = filtered
  }

  // tool_choice
  const toolChoice = body.tool_choice
  if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as { type?: unknown }).type === "tool"
  ) {
    const tc = toolChoice as Record<string, unknown>
    const name = typeof tc.name === "string" ? tc.name : ""
    if (OAUTH_TOOLS_TO_REMOVE.has(name)) {
      delete body.tool_choice
    } else {
      const renamed = OAUTH_TOOL_RENAME_MAP[name]
      if (renamed && renamed !== name) {
        tc.name = renamed
        recordRename(name, renamed)
      }
    }
  }

  // messages[].content[]
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== "object") continue
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (!part || typeof part !== "object") continue
        const partObj = part as Record<string, unknown>
        const partType = typeof partObj.type === "string" ? partObj.type : ""
        if (partType === "tool_use") {
          const name = typeof partObj.name === "string" ? partObj.name : ""
          const renamed = OAUTH_TOOL_RENAME_MAP[name]
          if (renamed && renamed !== name) {
            partObj.name = renamed
            recordRename(name, renamed)
          }
        } else if (partType === "tool_reference") {
          const toolName =
            typeof partObj.tool_name === "string" ? partObj.tool_name : ""
          const renamed = OAUTH_TOOL_RENAME_MAP[toolName]
          if (renamed && renamed !== toolName) {
            partObj.tool_name = renamed
            recordRename(toolName, renamed)
          }
        } else if (partType === "tool_result") {
          const nested = partObj.content
          if (Array.isArray(nested)) {
            for (const nestedPart of nested) {
              if (!nestedPart || typeof nestedPart !== "object") continue
              const np = nestedPart as Record<string, unknown>
              if (np.type !== "tool_reference") continue
              const nestedName =
                typeof np.tool_name === "string" ? np.tool_name : ""
              const renamed = OAUTH_TOOL_RENAME_MAP[nestedName]
              if (renamed && renamed !== nestedName) {
                np.tool_name = renamed
                recordRename(nestedName, renamed)
              }
            }
          }
        }
      }
    }
  }

  return reverseMap
}

// ── response restoration ─────────────────────────────────────────────

/**
 * Reverse the OAuth tool-name remap on a non-streaming Anthropic response
 * body. Walks `content[]` looking for `tool_use` and `tool_reference`
 * blocks emitted by the upstream and restores client-side naming.
 *
 * Mutates `body` in place. Names that the client did not originally rename
 * are passed through unchanged because they are absent from `reverseMap`.
 */
export function restoreOAuthToolNamesFromResponse(
  body: Record<string, unknown>,
  reverseMap: Record<string, string>
): void {
  if (!reverseMap || Object.keys(reverseMap).length === 0) return
  const content = body.content
  if (!Array.isArray(content)) return

  for (const part of content) {
    if (!part || typeof part !== "object") continue
    const partObj = part as Record<string, unknown>
    if (partObj.type === "tool_use") {
      const name = typeof partObj.name === "string" ? partObj.name : ""
      const restored = reverseMap[name]
      if (restored != null) {
        partObj.name = restored
      }
    } else if (partObj.type === "tool_reference") {
      const toolName =
        typeof partObj.tool_name === "string" ? partObj.tool_name : ""
      const restored = reverseMap[toolName]
      if (restored != null) {
        partObj.tool_name = restored
      }
    }
  }
}

// ── re-exports kept local so the service file does not import internals ──

export { OAUTH_TOOL_RENAME_MAP }
