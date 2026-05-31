import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { LooseMessageContent } from "../../context/types"
import { PersistenceService } from "../../persistence"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse } from "../../shared/anthropic"
import {
  getAccountConfigPathCandidates,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"
import { UsageStatsService } from "../../usage"
import {
  createAbortPromise,
  createAbortSignalWithTimeout,
  toUpstreamRequestAbortedError,
} from "../shared/abort-signal"
import {
  type CooldownableAccount,
  clearAccountDisablement,
  disableAccount,
  isAccountAvailableForModel,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
} from "../shared/account-cooldown"
import {
  BackendAccountStateStore,
  type PersistedBackendAccountState,
} from "../shared/backend-account-state-store"
import {
  BackendAccountPoolUnavailableError,
  BackendApiError,
} from "../shared/backend-errors"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
} from "../shared/backend-pool-status"
import { appendLanguageDirectiveToAnthropicSystem } from "../shared/language-directive"
import {
  type CursorDisplayModel,
  detectModelFamily,
  doesModelIdRequireExplicitThinkingSupport,
} from "../shared/model-registry"
import { stripSignatureBlocksFlat } from "../shared/normalize-for-api"
import { isClaudeOAuthToken } from "./claude-code-instructions"
import { applyClaudeDeviceProfileHeaders } from "./device-profile"
import {
  applyCcCliCloaking,
  restoreOAuthToolNamesFromResponse,
} from "./oauth-cloaking"
import { appendOauthAccount, persistOauthRotation } from "./oauth-persistence"
import {
  AnthropicOAuthError,
  type AnthropicOAuthLoginSession,
  exchangeAuthorizationCode,
  refreshAnthropicTokens,
  startAnthropicLogin,
} from "./oauth-pkce"
import { applyPromptCachingOptimizations } from "./prompt-caching"
import {
  appendClaudeResponseChunk,
  appendClaudeResponseError,
  appendClaudeResponseMetadata,
  startClaudeRequestLog,
} from "./request-log"
import { readJsonWithMagicByteSniff } from "./response-decoder"

export interface AnthropicForwardHeaders {
  [key: string]: string | undefined
}

/**
 * Identifies which downstream client is calling the Anthropic backend so the
 * service can decide whether to apply Claude Code CLI-specific cloaking
 * (system prompt injection, cch billing-header signing, OAuth tool-name
 * remapping, etc.) without leaking those rewrites into the Cursor-native
 * protocol path.
 *
 * - "claude-code-cli": request originates from POST /v1/messages and is
 *   expected to mimic the real Claude Code CLI fingerprint when the
 *   underlying account uses an Anthropic OAuth access token.
 * - "cursor": request originates from the Cursor ConnectRPC stack. The
 *   Cursor protocol carries its own system prompt, tool naming, and
 *   user-agent identity and must NOT be cloaked as Claude Code CLI.
 * - "generic": internal callers (web_search server-tool, count_tokens
 *   probes, health checks) that have no client identity to preserve.
 *
 * The mode is currently propagated end-to-end as a structural seam; the
 * actual mode-specific shaping is layered on top in subsequent steps and
 * defaults to a no-op so existing behaviour is unchanged.
 */
export type ClaudeApiClientMode = "claude-code-cli" | "cursor" | "generic"

export interface ClaudeApiCallOptions {
  clientMode: ClaudeApiClientMode
  forwardHeaders?: AnthropicForwardHeaders
  abortSignal?: AbortSignal
  /**
   * Stable per-conversation key passed down so PromptCacheBreakDetection
   * can compare turn-to-turn cache_read_input_tokens drops. Stateless
   * forwarders (`/v1/messages` without a session) leave this unset and
   * cache-break detection silently skips.
   */
  sessionId?: string
  /** Optional sub-agent id; combined with sessionId to form the tracking key. */
  agentId?: string
  /**
   * Wall-clock timestamp of the previous successful assistant response
   * for the same session. Used to attribute cache breaks to TTL expiry
   * when no client-side change is detected.
   */
  lastAssistantTimestampMs?: number
}

interface ClaudeStreamShape {
  sawMessageStart: boolean
  sawMessageDelta: boolean
  upstreamErrorMessage?: string
  upstreamErrorRaised: boolean
}

/**
 * Merge an Anthropic SSE `usage` object into the running per-stream
 * counters. Used by both `message_start.message.usage` and
 * `message_delta.usage` paths so they share a single implementation.
 *
 * Each field is monotonic-replaced (Anthropic emits cumulative values
 * on each event), guarded by `> 0` for cache fields so a missing-vs-0
 * distinction in the upstream doesn't accidentally zero the counter.
 */
function mergeUsageInto(
  target: {
    inputTokens: number
    cachedInputTokens: number
    cacheCreationInputTokens: number
    outputTokens: number
    webSearchRequests: number
  },
  usage: Record<string, unknown>
): void {
  if (typeof usage.input_tokens === "number") {
    target.inputTokens = Math.max(0, Math.round(usage.input_tokens))
  }
  if (
    typeof usage.cache_read_input_tokens === "number" &&
    usage.cache_read_input_tokens > 0
  ) {
    target.cachedInputTokens = Math.max(
      0,
      Math.round(usage.cache_read_input_tokens)
    )
  }
  if (
    typeof usage.cache_creation_input_tokens === "number" &&
    usage.cache_creation_input_tokens > 0
  ) {
    target.cacheCreationInputTokens = Math.max(
      0,
      Math.round(usage.cache_creation_input_tokens)
    )
  }
  if (typeof usage.output_tokens === "number") {
    target.outputTokens = Math.max(0, Math.round(usage.output_tokens))
  }
  const serverToolUse =
    usage.server_tool_use && typeof usage.server_tool_use === "object"
      ? (usage.server_tool_use as Record<string, unknown>)
      : null
  if (
    typeof serverToolUse?.web_search_requests === "number" &&
    serverToolUse.web_search_requests > 0
  ) {
    target.webSearchRequests = Math.max(
      0,
      Math.round(serverToolUse.web_search_requests)
    )
  }
}

function stringifyUnknownForLog(value: unknown): string {
  if (value == null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`
  }
  if (typeof value === "symbol") {
    return value.description || value.toString()
  }

  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized === "string") {
      return serialized
    }
  } catch {
    // ignore JSON serialization failures for logging
  }

  return Object.prototype.toString.call(value)
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const details: string[] = [error.message]
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause) {
      if (cause instanceof Error) {
        details.push(`cause=${cause.message}`)
        const nestedCode = (cause as Error & { code?: unknown }).code
        if (nestedCode != null) {
          details.push(`causeCode=${stringifyUnknownForLog(nestedCode)}`)
        }
      } else {
        details.push(`cause=${stringifyUnknownForLog(cause)}`)
      }
    }
    const code = (error as Error & { code?: unknown }).code
    if (code != null) {
      details.push(`code=${stringifyUnknownForLog(code)}`)
    }
    const errno = (error as Error & { errno?: unknown }).errno
    if (errno != null) {
      details.push(`errno=${stringifyUnknownForLog(errno)}`)
    }
    return details.join(", ")
  }

  return stringifyUnknownForLog(error)
}

/**
 * Convert a fetch `Response.headers` instance to a plain string map so it
 * can be passed to the request-log helpers without exposing the iterator
 * surface to callers.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

/**
 * Extract the CC CLI entrypoint name from a client User-Agent header.
 * Real Claude Code emits `claude-cli/<version> (<user_type>, <entrypoint>)`,
 * e.g. `(external, cli)` or `(external, vscode)`. Mirrors
 * `parseEntrypointFromUA` in CLIProxyAPI's claude_executor.go.
 */
function deriveEntrypoint(
  forwardHeaders?: AnthropicForwardHeaders
): string | undefined {
  const ua = forwardHeaders?.["user-agent"]?.trim()
  if (!ua) return undefined
  const start = ua.indexOf("(")
  const end = ua.lastIndexOf(")")
  if (start < 0 || end <= start) return undefined
  const inner = ua.slice(start + 1, end)
  const parts = inner.split(",").map((p) => p.trim())
  if (parts.length < 2) return undefined
  const candidate = parts[1] || ""
  return candidate || undefined
}

/**
 * Map a CC CLI entrypoint to the `anthropic-client-platform` value real
 * Claude Code emits. Mirrors `function w9H()` in the v2.1.142 binary
 * (`switch(process.env.CLAUDE_CODE_ENTRYPOINT)`).
 *
 * Returning `claude_code_cli` for unknown / missing entrypoints matches
 * the upstream default branch (`case "cli": default:`), which keeps the
 * traffic firmly inside Anthropic's first-party CC bucket.
 */
function deriveAnthropicClientPlatform(entrypoint?: string): string {
  switch (entrypoint) {
    case "claude-vscode":
      return "claude_code_vscode"
    case "remote":
    case "remote_baku":
    case "remote_desktop":
    case "remote_mobile":
      return "claude_code_remote"
    case "sdk-cli":
    case "sdk-ts":
    case "sdk-py":
      return "claude_code_sdk"
    case "mcp":
      return "claude_code_mcp"
    case "claude-code-github-action":
      return "claude_code_github_action"
    case "local-agent":
      return "claude_code_local_agent"
    case "claude_in_slack":
      return "claude_in_slack"
    case "cli":
    default:
      return "claude_code_cli"
  }
}

/**
 * Extract the optional `cc_workload` value from a custom forwarded
 * header. Mirrors `getWorkloadFromContext` in CLIProxyAPI.
 */
function deriveWorkload(
  forwardHeaders?: AnthropicForwardHeaders
): string | undefined {
  const value = forwardHeaders?.["x-cpa-claude-workload"]?.trim()
  return value || undefined
}

interface ClaudeApiModelMapping {
  name: string
  alias?: string
}

interface ClaudeApiDiscoveredModel {
  name: string
  displayName?: string
  createdAt?: number
  isThinking: boolean
}

export interface ClaudeApiPublicModel {
  id: string
  displayName?: string
  createdAt?: number
  isThinking: boolean
}

interface ClaudeApiAccount extends CooldownableAccount {
  label?: string
  apiKey: string
  baseUrl: string
  proxyUrl?: string
  maxContextTokens?: number
  stripThinking: boolean
  disablePromptCaching: boolean
  prefix?: string
  headers?: Record<string, string>
  models: ClaudeApiModelMapping[]
  excludedModels: string[]
  priority: number
  source: "env" | "file"
  stateKey: string
  discoveredModels: ClaudeApiDiscoveredModel[]
  discoveredModelsFetchedAt?: number
  discoveryPromise?: Promise<void>
  /**
   * Anthropic OAuth metadata. Present only when the account was created
   * via the PKCE login flow rather than a static API key. The bridge
   * silently rotates `apiKey` (= access token) before expiry using
   * `refreshToken`.
   */
  oauth?: {
    refreshToken: string
    accessTokenExpiresAt: number
    accountUuid?: string
    organizationUuid?: string
  }
  oauthRefreshInFlight?: Promise<void>
}

interface ClaudeApiCandidate {
  account: ClaudeApiAccount
  upstreamModel: string
  publicModelId: string
}

type PersistedClaudeApiAccountState = PersistedBackendAccountState

interface ClaudeApiAccountFileEntry {
  label?: string
  apiKey?: string
  baseUrl?: string
  proxyUrl?: string
  maxContextTokens?: number
  stripThinking?: boolean
  /**
   * Opt-out for `cache_control` injection. Default `false` — bridge will
   * inject cache breakpoints automatically against any Claude-compatible
   * upstream. Set to `true` only for providers that reject the field
   * (very rare; Anthropic itself, all major OAuth proxies, and the
   * mainstream third-party Claude relays accept it silently when the
   * model does not support caching).
   */
  disablePromptCaching?: boolean
  prefix?: string
  priority?: number
  headers?: Record<string, string>
  models?: Array<{ name?: string; alias?: string }>
  excludedModels?: string[]
  /**
   * Optional Anthropic OAuth metadata produced by the PKCE login flow.
   * When present, the bridge treats `apiKey` as the access token and
   * automatically refreshes it using `oauth.refreshToken`.
   */
  oauth?: {
    refreshToken?: string
    accessTokenExpiresAt?: number
    accountUuid?: string
    organizationUuid?: string
  }
}

interface ClaudeApiConfigFile {
  forceModelPrefix?: boolean
  accounts?: ClaudeApiAccountFileEntry[]
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
export const DEFAULT_CLAUDE_API_CONTEXT_LIMIT_TOKENS = 200_000

/**
 * Anthropic-compatible upstreams reject or even crash when Claude models
 * omit `max_tokens`. Mirrors CLIProxyAPI's `defaultModelMaxTokens` (1024).
 */
const DEFAULT_MODEL_MAX_TOKENS = 1024

/**
 * Models that ship Anthropic's server-side `web_search_20250305` tool. We try
 * them in order when the caller does not pin a model — falling back to the
 * first candidate even if it cannot be routed, so the upstream returns a
 * deterministic error rather than an internal "no candidate" surprise.
 */
const ANTHROPIC_WEB_SEARCH_DEFAULT_MODEL_CANDIDATES = [
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-3-7-sonnet-latest",
  "claude-3-5-sonnet-latest",
] as const

const DEFAULT_PUBLIC_CLAUDE_MODEL_IDS = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-thinking",
  "claude-opus-4-6-thinking",
  "claude-opus-4-5-thinking",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
] as const

const DEFAULT_FORWARDED_HEADERS: Record<string, string> = {
  "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
}

/**
 * Required beta features that are unconditionally activated when the
 * CLI talks to api.anthropic.com under OAuth. Tracked against the
 * v2.1.142 binary (`/opt/homebrew/bin/claude`).
 *
 * The full beta surface in the binary's `getAllModelBetas` is much
 * larger (~30+ flags including `interleaved-thinking-2025-05-14`,
 * `context-1m-2025-08-07`, `token-efficient-tools-2025-02-19`, …) but
 * those are activated *conditionally* on model + per-request features.
 * We split the list so the unconditional set stays minimal:
 *
 *   - claude-code-20250219               (sticky: client identity)
 *   - oauth-2025-04-20                   (sticky: OAuth token grant)
 *   - context-management-2025-06-27      (sticky: server-side editing)
 *   - prompt-caching-scope-2026-01-05    (cache scope hints)
 *   - extended-cache-ttl-2025-04-11      (1h cache TTL)
 *   - structured-outputs-2025-12-15      (output schema enforcement)
 *   - fast-mode-2026-02-01               (Opus fast mode)
 *   - redact-thinking-2026-02-12         (thinking redaction)
 *   - mid-conversation-system-2026-04-07 (system-reminder injection)
 *
 * Conditional flags handled separately:
 *   - `interleaved-thinking-2025-05-14`  → only when thinking enabled
 *   - `context-1m-2025-08-07`            → only on 1M-context models
 *   - `token-efficient-tools-2025-02-19` → not unconditionally; v2.1.142
 *     still references it but only emits it on Sonnet 3.5/3.7 series.
 */
const REQUIRED_BETA_FEATURES = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "extended-cache-ttl-2025-04-11",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "mid-conversation-system-2026-04-07",
] as const

/** Beta flag added only when the request opts into extended thinking. */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"

/** Beta flag added only when the request targets a 1M-context model. */
const CONTEXT_1M_BETA = "context-1m-2025-08-07"

/**
 * Model name fragments that activate `context-1m-2025-08-07`. Matched
 * case-insensitively against the resolved upstream model id. Anthropic
 * rejects the flag for models that don't support it, so we keep the
 * list tight rather than always-on.
 */
const CONTEXT_1M_MODEL_FRAGMENTS = ["claude-sonnet-4-5", "1m"] as const

function modelSupports1MContext(model: string): boolean {
  const lower = model.toLowerCase()
  return CONTEXT_1M_MODEL_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

function bodyEnablesThinking(
  body: Record<string, unknown> | undefined
): boolean {
  if (!body) return false
  const thinking = (body as { thinking?: unknown }).thinking
  if (!thinking || typeof thinking !== "object") return false
  return (thinking as { type?: unknown }).type === "enabled"
}

function bodyResolvedModel(
  body: Record<string, unknown> | undefined
): string | undefined {
  if (!body) return undefined
  const model = (body as { model?: unknown }).model
  return typeof model === "string" ? model : undefined
}
const CACHE_EDITING_BETA_HEADER =
  process.env.ANTHROPIC_CACHE_EDITING_BETA_HEADER?.trim() ||
  process.env.CACHE_EDITING_BETA_HEADER?.trim() ||
  ""

const MODEL_DISCOVERY_TIMEOUT_MS = 8_000
const MODEL_DISCOVERY_MAX_PAGES = 5
const MODEL_DISCOVERY_TTL_MS = 15 * 60_000

import type {
  ProviderAdapter,
  ProviderWarmupHint,
} from "../shared/provider-adapter.interface"
import { PromptCacheBreakDetectionService } from "./prompt-cache-break-detection.service"

@Injectable()
export class AnthropicApiService implements OnModuleInit, ProviderAdapter {
  private readonly logger = new Logger(AnthropicApiService.name)

  private accounts: ClaudeApiAccount[] = []
  private accountIndex = 0
  private forceModelPrefix = false
  private accountsConfigPath: string | null = null
  private accountStateStore: BackendAccountStateStore
  private readonly sessionIdCache = new Map<string, string>()
  private readonly oauthLoginSessions = new Map<
    string,
    AnthropicOAuthLoginSession
  >()

  private normalizeMaxContextTokens(value: unknown): number | undefined {
    const parsed =
      typeof value === "string" ? Number.parseInt(value.trim(), 10) : value
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      return undefined
    }

    return Math.floor(parsed)
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly persistence: PersistenceService,
    private readonly usageStats: UsageStatsService,
    private readonly promptCacheBreakDetection: PromptCacheBreakDetectionService
  ) {
    this.accountStateStore = new BackendAccountStateStore(
      this.persistence,
      this.logger
    )
  }

  async onModuleInit(): Promise<void> {
    const fileAccounts = this.loadAllAccountsFromFile()
    if (fileAccounts.length > 0) {
      this.accounts = fileAccounts
    }

    const envApiKey = this.configService
      .get<string>("CLAUDE_API_KEY", "")
      .trim()
    const envBaseUrl = this.normalizeBaseUrl(
      this.configService.get<string>("CLAUDE_BASE_URL", "").trim()
    )
    const envProxyUrl = this.configService
      .get<string>("CLAUDE_PROXY_URL", "")
      .trim()
    const envMaxContextTokens = this.normalizeMaxContextTokens(
      this.configService.get<number>("CLAUDE_MAX_CONTEXT_TOKENS")
    )
    const envForceModelPrefix = this.configService
      .get<string>("CLAUDE_FORCE_MODEL_PREFIX", "")
      .trim()

    if (envForceModelPrefix) {
      this.forceModelPrefix = ["true", "1"].includes(
        envForceModelPrefix.toLowerCase()
      )
    }

    if (envApiKey) {
      const alreadyExists = this.accounts.some(
        (account) =>
          account.apiKey === envApiKey && account.baseUrl === envBaseUrl
      )
      if (!alreadyExists) {
        this.accounts.unshift(
          this.buildAccountRecord({
            label: "env",
            apiKey: envApiKey,
            baseUrl: envBaseUrl,
            proxyUrl: envProxyUrl || undefined,
            maxContextTokens: envMaxContextTokens,
            source: "env",
          })
        )
      }
    }

    this.configureAccountStateStore(this.accountsConfigPath)
    const persistedStates = this.loadPersistedAccountStates()
    for (const account of this.accounts) {
      this.applyPersistedAccountState(
        account,
        persistedStates.get(account.stateKey)
      )
    }
    this.persistAccountStates()
    await Promise.allSettled(
      this.accounts.map((account) =>
        this.refreshDiscoveredModelsForAccount(account, { force: true })
      )
    )

    this.logger.log(
      `Claude API backend initialized: ${this.accounts.length} account(s), forceModelPrefix=${this.forceModelPrefix}`
    )
    for (const account of this.accounts) {
      const stateSummary = isAccountDisabled(account)
        ? `disabled (${account.disabledReason || "permanent"})`
        : account.cooldownUntil > 0 || account.modelStates.size > 0
          ? "cooldown"
          : "ready"
      this.logger.log(
        `  -> ${account.label || "unnamed"} [${account.source}]: ${account.baseUrl} (key: ${account.apiKey.slice(0, 8)}..., priority=${account.priority}, state=${stateSummary})`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.log(
        "No Claude API credentials configured. Add entries to data/claude-api-accounts.json to enable."
      )
    }
  }

  isAvailable(): boolean {
    return this.accounts.some((account) => !isAccountDisabled(account))
  }

  /**
   * Hot-reload accounts from config file — full reconcile.
   *
   * Performs a three-way reconciliation (add / update / delete):
   * - ADD: New accounts not yet in the pool are appended and trigger model discovery.
   * - UPDATE: Existing accounts whose mutable config changed (label, baseUrl,
   *   proxyUrl, stripThinking, priority, headers, models, excludedModels) are
   *   patched in-place.  Runtime state (cooldown, disabled, modelStates) is preserved.
   * - DELETE: File-sourced accounts that no longer appear in the config are removed.
   *   Env-sourced accounts are never deleted.
   *
   * Returns the total number of account changes (add/update/remove).
   */
  async reloadAccounts(): Promise<number> {
    const freshAccounts = this.loadAllAccountsFromFile()
    const freshKeys = new Set(freshAccounts.map((a) => a.stateKey))
    const existingByKey = new Map(this.accounts.map((a) => [a.stateKey, a]))
    const persistedStates = this.loadPersistedAccountStates()

    let added = 0
    let updated = 0
    let removed = 0
    const newAccounts: ClaudeApiAccount[] = []

    // ── ADD + UPDATE ──
    for (const fresh of freshAccounts) {
      const existing = existingByKey.get(fresh.stateKey)

      if (!existing) {
        // New account — add
        this.applyPersistedAccountState(
          fresh,
          persistedStates.get(fresh.stateKey)
        )
        this.accounts.push(fresh)
        newAccounts.push(fresh)
        added++
        this.logger.log(
          `[Hot-reload] Added Claude API account: ${fresh.label || fresh.baseUrl}`
        )
      } else {
        // Existing account — patch mutable fields, preserve runtime state
        let changed = false

        if (existing.label !== fresh.label) {
          existing.label = fresh.label
          changed = true
        }
        if (existing.baseUrl !== fresh.baseUrl) {
          existing.baseUrl = fresh.baseUrl
          changed = true
        }
        if (existing.proxyUrl !== fresh.proxyUrl) {
          existing.proxyUrl = fresh.proxyUrl
          changed = true
        }
        if (existing.maxContextTokens !== fresh.maxContextTokens) {
          existing.maxContextTokens = fresh.maxContextTokens
          changed = true
        }
        if (existing.stripThinking !== fresh.stripThinking) {
          existing.stripThinking = fresh.stripThinking
          changed = true
        }
        if (existing.disablePromptCaching !== fresh.disablePromptCaching) {
          existing.disablePromptCaching = fresh.disablePromptCaching
          changed = true
        }
        if (existing.priority !== fresh.priority) {
          existing.priority = fresh.priority
          changed = true
        }
        if (
          JSON.stringify(existing.headers) !== JSON.stringify(fresh.headers)
        ) {
          existing.headers = fresh.headers
          changed = true
        }
        if (JSON.stringify(existing.models) !== JSON.stringify(fresh.models)) {
          existing.models = fresh.models
          changed = true
        }
        if (
          JSON.stringify(existing.excludedModels) !==
          JSON.stringify(fresh.excludedModels)
        ) {
          existing.excludedModels = fresh.excludedModels
          changed = true
        }

        if (changed) {
          updated++
          this.logger.log(
            `[Hot-reload] Updated Claude API account: ${existing.label || existing.baseUrl}`
          )
        }
      }
    }

    // ── DELETE — only remove file-sourced accounts that are no longer in config ──
    const beforeCount = this.accounts.length
    this.accounts = this.accounts.filter((account) => {
      // Never remove env-sourced accounts
      if (account.source === "env") return true
      // Keep accounts that still exist in the fresh config
      if (freshKeys.has(account.stateKey)) return true
      // Remove stale file-sourced accounts
      removed++
      this.logger.log(
        `[Hot-reload] Removed Claude API account: ${account.label || account.baseUrl}`
      )
      return false
    })

    // ── persist + log ──
    const totalChanges = added + updated + removed
    if (totalChanges > 0) {
      this.persistAccountStates()
      this.logger.log(
        `[Hot-reload] Claude API reconcile: +${added} ~${updated} -${removed}, ` +
          `total=${this.accounts.length} (was ${beforeCount})`
      )
    }

    // Trigger model discovery for newly added accounts
    if (newAccounts.length > 0) {
      await Promise.allSettled(
        newAccounts.map((account) =>
          this.refreshDiscoveredModelsForAccount(account, { force: true })
        )
      )
    }

    // Trigger model re-discovery for updated accounts whose model config changed
    if (updated > 0) {
      await Promise.allSettled(
        this.accounts
          .filter((a) => this.shouldDiscoverModelsForAccount(a))
          .map((a) =>
            this.refreshDiscoveredModelsForAccount(a, { force: true })
          )
      )
    }

    return totalChanges
  }

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.accounts.map((account) => {
      const modelCooldowns = this.getActiveModelCooldowns(account, now)
      const state = this.getPoolEntryState(account, modelCooldowns, now)
      return {
        id: account.stateKey,
        label: account.label || account.prefix || account.baseUrl,
        state,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: account.baseUrl,
        proxyUrl: account.proxyUrl,
        maxContextTokens: account.maxContextTokens,
        prefix: account.prefix,
        priority: account.priority,
        modelCooldowns,
      }
    })

    return {
      backend: "claude-api",
      kind: "account-pool",
      configured: this.accounts.length > 0,
      total: entries.length,
      available: entries.filter(
        (entry) =>
          entry.state === "ready" ||
          entry.state === "degraded" ||
          entry.state === "model_cooldown"
      ).length,
      ready: entries.filter((entry) => entry.state === "ready").length,
      degraded: entries.filter((entry) => entry.state === "degraded").length,
      modelCooldown: entries.filter((entry) => entry.state === "model_cooldown")
        .length,
      cooling: entries.filter((entry) => entry.state === "cooldown").length,
      disabled: entries.filter((entry) => entry.state === "disabled").length,
      unavailable: 0,
      configPath: this.accountsConfigPath,
      statePath: "~/.agent-vibes/pgdata/agent-vibes.db",
      entries,
    }
  }

  supportsModel(model: string): boolean {
    this.refreshDiscoveredModelsInBackgroundIfNeeded()
    return this.resolveCandidates(model).some(
      (candidate) => !isAccountDisabled(candidate.account)
    )
  }

  getPublicModels(): ClaudeApiPublicModel[] {
    this.refreshDiscoveredModelsInBackgroundIfNeeded()

    const models = new Map<string, ClaudeApiPublicModel>()

    for (const account of this.accounts) {
      if (isAccountDisabled(account)) {
        continue
      }

      for (const model of this.getAdvertisedModelsForAccount(account)) {
        for (const publicId of this.buildVisibleModelIdsForAccount(
          account,
          model.id
        )) {
          if (
            this.isModelExcluded(account, publicId) ||
            !this.isPublicModelIdCompatibleWithAccount(account, publicId)
          ) {
            continue
          }

          const normalized = publicId.toLowerCase()
          if (models.has(normalized)) {
            continue
          }

          models.set(normalized, {
            id: publicId,
            displayName: model.displayName,
            createdAt: model.createdAt,
            isThinking: model.isThinking,
          })
        }
      }
    }

    return Array.from(models.values()).sort((left, right) =>
      left.id.localeCompare(right.id)
    )
  }

  getPublicModelIds(): string[] {
    return this.getPublicModels().map((model) => model.id)
  }

  getConfiguredMaxContextTokens(model: string): number | undefined {
    const candidates = this.getAvailableCandidatesInAttemptOrder(
      this.resolveCandidates(model)
    )
    let resolved: number | undefined
    const seenAccounts = new Set<string>()

    for (const candidate of candidates) {
      if (seenAccounts.has(candidate.account.stateKey)) {
        continue
      }
      seenAccounts.add(candidate.account.stateKey)

      const limit = this.normalizeMaxContextTokens(
        candidate.account.maxContextTokens
      )
      if (limit === undefined) {
        continue
      }
      resolved = resolved === undefined ? limit : Math.min(resolved, limit)
    }

    return resolved
  }

  getCursorDisplayModels(): CursorDisplayModel[] {
    return this.getPublicModels().map((model) => ({
      name: model.id,
      displayName: model.displayName || model.id,
      shortName: model.displayName || model.id,
      family: "claude",
      isThinking: model.isThinking,
    }))
  }

  /**
   * Proxy a count_tokens request to the upstream Anthropic API.
   * Returns the upstream response if a suitable Claude API account is available,
   * or null if no account can serve this model (caller should fall back to local estimation).
   */
  async countTokensUpstream(
    dto: Record<string, unknown>,
    options: { clientMode: ClaudeApiClientMode }
  ): Promise<{ input_tokens: number } | null> {
    const model = typeof dto.model === "string" ? dto.model : ""
    if (!model) return null

    const candidates = this.getAvailableCandidatesInAttemptOrder(
      this.resolveCandidates(model).filter((candidate) =>
        this.shouldApplyOfficialAnthropicOptimizations(candidate.account)
      )
    )
    if (candidates.length === 0) return null

    for (const candidate of candidates) {
      const account = candidate.account
      if (!(await this.prepareAccountToken(account))) {
        continue
      }
      const request = this.buildUpstreamRequestPayload(
        dto,
        candidate.upstreamModel,
        account,
        {
          applyPromptCaching: true,
          clientMode: options.clientMode,
        }
      )
      const url = this.buildCountTokensUrl(account.baseUrl)
      const headers = this.buildHeadersForAccount(
        account,
        false,
        {},
        request.betas,
        {
          model: bodyResolvedModel(request.body),
          thinkingEnabled: bodyEnablesThinking(request.body),
        }
      )
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
      }

      const dispatcher = this.buildProxyAgent(account)
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher
      }

      try {
        const response = await this.fetchWithResponseHeadersTimeout(
          url,
          fetchOptions,
          10_000,
          "count_tokens upstream timed out"
        )

        if (!response.ok) {
          const errorBody = await response.text()
          this.buildHttpFailureError(
            account,
            response.status,
            errorBody,
            candidate.upstreamModel,
            response.headers.get("retry-after") || undefined
          )
          this.logger.debug(
            `[Claude API] count_tokens upstream failed: account=${account.label || account.baseUrl}, status=${response.status}`
          )
          continue
        }

        const result = await readJsonWithMagicByteSniff<{
          input_tokens?: number
        }>(response)
        if (typeof result.input_tokens === "number") {
          this.markAccountHealthy(account, candidate.upstreamModel)
          return { input_tokens: result.input_tokens }
        }

        this.markAccountTemporaryFailure(account, 502, candidate.upstreamModel)
        this.logger.debug(
          `[Claude API] count_tokens upstream returned invalid payload for ${account.label || account.baseUrl}`
        )
      } catch (error) {
        this.markAccountTemporaryFailure(account, 504, candidate.upstreamModel)
        this.logger.debug(
          `[Claude API] count_tokens upstream error for ${account.label || account.baseUrl}: ${formatUnknownError(error)}`
        )
      }
    }

    return null
  }

  async sendClaudeMessage(
    dto: CreateMessageDto,
    options: ClaudeApiCallOptions
  ): Promise<AnthropicResponse> {
    return this.executeWithCooldownRetry(
      dto,
      options.forwardHeaders ?? {},
      options.clientMode,
      new Set(),
      undefined,
      {
        sessionId: options.sessionId,
        agentId: options.agentId,
        lastAssistantTimestampMs: options.lastAssistantTimestampMs,
      }
    )
  }

  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    options: ClaudeApiCallOptions
  ): AsyncGenerator<string, void, unknown> {
    yield* this.executeStreamWithCooldownRetry(
      dto,
      options.forwardHeaders ?? {},
      options.clientMode,
      new Set(),
      options.abortSignal,
      undefined,
      {
        sessionId: options.sessionId,
        agentId: options.agentId,
        lastAssistantTimestampMs: options.lastAssistantTimestampMs,
      }
    )
  }

  /**
   * Execute a one-shot web search via the Anthropic API server-side
   * `web_search_20250305` tool. We synthesize a small CreateMessageDto, run it
   * through the standard candidate / cooldown machinery, and then collect any
   * `server_tool_use` / `web_search_tool_result` blocks plus the final
   * assistant text into the same shape the Google backend returns —
   * `{ text, references: [{ title, url, chunk }] }` — so callers can stay
   * backend-agnostic.
   */
  async executeWebSearch(input: {
    query: string
    model?: string
    maxUses?: number
  }): Promise<{
    text: string
    references: Array<{ title: string; url: string; chunk: string }>
  }> {
    const query = input.query.trim()
    if (!query) {
      return { text: "", references: [] }
    }

    if (!this.hasConfiguredAccounts()) {
      throw new Error(
        "Claude API backend not configured: no accounts available for web_search"
      )
    }

    const requestedModel = input.model?.trim() || ""
    const model =
      requestedModel ||
      ANTHROPIC_WEB_SEARCH_DEFAULT_MODEL_CANDIDATES.find((candidate) =>
        this.canRouteModelForWebSearch(candidate)
      ) ||
      ANTHROPIC_WEB_SEARCH_DEFAULT_MODEL_CANDIDATES[0]

    // Anthropic server-side web_search tool descriptor. Cast through unknown
    // because ToolDto only types standard function-tool fields, but the API
    // accepts the broader server-tool schema (extra fields are forwarded
    // verbatim by buildUpstreamRequestPayload).
    const webSearchTool = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses:
        typeof input.maxUses === "number" && input.maxUses > 0
          ? input.maxUses
          : 5,
    } as unknown as NonNullable<CreateMessageDto["tools"]>[number]

    const dto: CreateMessageDto = {
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content:
            "Use the web_search tool to find authoritative, recent results for " +
            "the following query, then summarize the findings in a few " +
            "sentences and list the sources you used.\n\n" +
            `Query: ${query}`,
        },
      ],
      tools: [webSearchTool],
      stream: false,
    }

    const result = await this.sendClaudeMessage(dto, { clientMode: "generic" })
    return this.extractWebSearchResultFromResponse(result)
  }

  private extractWebSearchResultFromResponse(response: AnthropicResponse): {
    text: string
    references: Array<{ title: string; url: string; chunk: string }>
  } {
    const summaryParts: string[] = []
    const references: Array<{ title: string; url: string; chunk: string }> = []
    const seenUrls = new Set<string>()

    const pushReference = (
      url: string,
      title?: string,
      chunk?: string
    ): void => {
      const trimmed = url.trim()
      if (!trimmed || seenUrls.has(trimmed)) return
      seenUrls.add(trimmed)
      references.push({
        title: (title || "").trim() || trimmed,
        url: trimmed,
        chunk: chunk || "",
      })
    }

    const collectFromCitation = (citation: unknown): void => {
      if (!citation || typeof citation !== "object") return
      const c = citation as Record<string, unknown>
      const url = typeof c.url === "string" ? c.url : ""
      const title = typeof c.title === "string" ? c.title : undefined
      const cited =
        typeof c.cited_text === "string"
          ? c.cited_text
          : typeof c.text === "string"
            ? c.text
            : undefined
      if (url) pushReference(url, title, cited)
    }

    const blocks = (response.content as unknown[] | undefined) || []
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue
      const block = raw as Record<string, unknown>
      const blockType = block.type

      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : ""
        if (text.trim()) summaryParts.push(text)
        const annotations = block.citations
        if (Array.isArray(annotations)) {
          for (const ann of annotations) collectFromCitation(ann)
        }
        continue
      }

      // Server tool result block emitted by the Anthropic web_search tool.
      if (
        blockType === "web_search_tool_result" ||
        blockType === "server_tool_use"
      ) {
        const content = block.content
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || typeof item !== "object") continue
            const it = item as Record<string, unknown>
            const url = typeof it.url === "string" ? it.url : ""
            const title = typeof it.title === "string" ? it.title : undefined
            const snippet =
              typeof it.page_content === "string"
                ? it.page_content
                : typeof it.text === "string"
                  ? it.text
                  : ""
            if (url) pushReference(url, title, snippet)
          }
        }
      }
    }

    return { text: summaryParts.join("\n").trim(), references }
  }

  private hasConfiguredAccounts(): boolean {
    return Array.isArray(this.accounts) && this.accounts.length > 0
  }

  private canRouteModelForWebSearch(model: string): boolean {
    try {
      this.nextCandidate(model)
      return true
    } catch {
      return false
    }
  }

  private async executeWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders,
    clientMode: ClaudeApiClientMode,
    attemptedCandidates: Set<string>,
    candidate: ClaudeApiCandidate = this.nextCandidate(dto.model),
    cacheBreakTracking?: {
      sessionId?: string
      agentId?: string
      lastAssistantTimestampMs?: number
    }
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    attemptedCandidates.add(this.buildCandidateKey(candidate))
    if (!(await this.prepareAccountToken(candidate.account))) {
      const nextCandidate = this.nextRetryCandidate(
        dto.model,
        attemptedCandidates
      )
      if (nextCandidate) {
        return this.executeWithCooldownRetry(
          dto,
          forwardHeaders,
          clientMode,
          attemptedCandidates,
          nextCandidate,
          cacheBreakTracking
        )
      }
      throw new BackendApiError(
        "All Claude API accounts failed token refresh",
        { backend: "claude-api", statusCode: 401 }
      )
    }
    const request: {
      body: Record<string, unknown>
      betas: string[]
      oauthToolReverseMap: Record<string, string>
    } = this.buildRequestBody(dto, candidate, clientMode, forwardHeaders)
    const url = this.buildMessagesUrl(candidate.account.baseUrl)
    const headers = this.buildHeadersForAccount(
      candidate.account,
      false,
      forwardHeaders,
      request.betas,
      {
        model: bodyResolvedModel(request.body),
        thinkingEnabled: bodyEnablesThinking(request.body),
      }
    )

    // Phase 1 of cache-break detection (see streaming counterpart for rationale).
    this.recordCacheBreakPromptState(request.body, dto, cacheBreakTracking)

    this.logger.log(
      `[Claude API] Non-stream request: model=${dto.model} -> ${candidate.upstreamModel}, url=${url}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(300_000),
    }

    const dispatcher = this.buildProxyAgent(candidate.account)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const requestLog = await startClaudeRequestLog({
      url,
      method: "POST",
      headers,
      body: request.body,
      accountLabel: candidate.account.label || candidate.account.baseUrl,
      upstreamModel: candidate.upstreamModel,
    })

    try {
      let response: Response
      try {
        response = await fetch(url, fetchOptions)
      } catch (error) {
        this.logger.error(
          `[Claude API] Non-stream fetch failed: account=${candidate.account.label || candidate.account.baseUrl}, model=${candidate.upstreamModel}, url=${url}, detail=${formatUnknownError(error)}`
        )
        await appendClaudeResponseError(requestLog, error)
        throw this.buildTransientFailureError(
          candidate.account,
          504,
          formatUnknownError(error),
          candidate.upstreamModel
        )
      }

      const responseHeaders = headersToRecord(response.headers)
      await appendClaudeResponseMetadata(
        requestLog,
        response.status,
        responseHeaders
      )

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Claude API] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )
        await appendClaudeResponseChunk(requestLog, errorBody)
        throw this.buildHttpFailureError(
          candidate.account,
          response.status,
          errorBody,
          candidate.upstreamModel,
          response.headers.get("retry-after") || undefined
        )
      }

      const result =
        await readJsonWithMagicByteSniff<AnthropicResponse>(response)
      await appendClaudeResponseChunk(
        requestLog,
        JSON.stringify(result, null, 2)
      )
      // Restore client-side tool naming for OAuth-cloaked requests so the
      // caller never sees the upstream-canonical TitleCase variants we
      // sent on the wire.
      const reverseMap: Record<string, string> = request.oauthToolReverseMap
      if (Object.keys(reverseMap).length > 0) {
        restoreOAuthToolNamesFromResponse(
          result as unknown as Record<string, unknown>,
          reverseMap
        )
      }
      this.markAccountHealthy(candidate.account, candidate.upstreamModel)
      this.recordClaudeApiUsage(
        candidate,
        "messages",
        result.usage as Record<string, unknown> | null | undefined,
        requestStartedAt
      )
      // Phase 2 of cache-break detection. See streaming counterpart for rationale.
      const usageRec = result.usage as
        | {
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        | null
        | undefined
      this.promptCacheBreakDetection.checkResponseForCacheBreak({
        sessionId: cacheBreakTracking?.sessionId,
        agentId: cacheBreakTracking?.agentId,
        cacheReadTokens: usageRec?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usageRec?.cache_creation_input_tokens ?? 0,
        lastAssistantTimestampMs: cacheBreakTracking?.lastAssistantTimestampMs,
      })
      return result
    } catch (error) {
      const nextCandidate = this.shouldRetryWithNextCandidate(
        error,
        candidate,
        candidate.upstreamModel
      )
        ? this.nextRetryCandidate(dto.model, attemptedCandidates)
        : null
      if (nextCandidate) {
        this.logger.warn(
          `[Claude API] Request failed on ${candidate.account.label || "account"} (${candidate.upstreamModel}), retrying with ${nextCandidate.account.label || "account"} (${nextCandidate.upstreamModel})`
        )
        return this.executeWithCooldownRetry(
          dto,
          forwardHeaders,
          clientMode,
          attemptedCandidates,
          nextCandidate,
          cacheBreakTracking
        )
      }
      throw error
    }
  }

  private async *executeStreamWithCooldownRetry(
    dto: CreateMessageDto,
    forwardHeaders: AnthropicForwardHeaders,
    clientMode: ClaudeApiClientMode,
    attemptedCandidates: Set<string>,
    abortSignal?: AbortSignal,
    candidate: ClaudeApiCandidate = this.nextCandidate(dto.model),
    cacheBreakTracking?: {
      sessionId?: string
      agentId?: string
      lastAssistantTimestampMs?: number
    }
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    attemptedCandidates.add(this.buildCandidateKey(candidate))
    if (!(await this.prepareAccountToken(candidate.account))) {
      const nextCandidate = this.nextRetryCandidate(
        dto.model,
        attemptedCandidates
      )
      if (nextCandidate) {
        yield* this.executeStreamWithCooldownRetry(
          dto,
          forwardHeaders,
          clientMode,
          attemptedCandidates,
          abortSignal,
          nextCandidate,
          cacheBreakTracking
        )
        return
      }
      throw new BackendApiError(
        "All Claude API accounts failed token refresh",
        { backend: "claude-api", statusCode: 401 }
      )
    }
    const request: {
      body: Record<string, unknown>
      betas: string[]
      oauthToolReverseMap: Record<string, string>
    } = this.buildRequestBody(dto, candidate, clientMode, forwardHeaders)
    const oauthToolReverseMap: Record<string, string> =
      request.oauthToolReverseMap
    const url = this.buildMessagesUrl(candidate.account.baseUrl)
    const headers = this.buildHeadersForAccount(
      candidate.account,
      true,
      forwardHeaders,
      request.betas,
      {
        model: bodyResolvedModel(request.body),
        thinkingEnabled: bodyEnablesThinking(request.body),
      }
    )

    // Phase 1 of cache-break detection: snapshot the outbound prompt
    // shape so the post-call check can attribute any drop in
    // cache_read_input_tokens to a concrete client-side change. No-op
    // when sessionId is absent (stateless /v1/messages forwarding).
    this.recordCacheBreakPromptState(request.body, dto, cacheBreakTracking)

    this.logger.log(
      `[Claude API] Stream request: model=${dto.model} -> ${candidate.upstreamModel}, url=${url}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
    }

    const dispatcher = this.buildProxyAgent(candidate.account)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const requestLog = await startClaudeRequestLog({
      url,
      method: "POST",
      headers,
      body: request.body,
      accountLabel: candidate.account.label || candidate.account.baseUrl,
      upstreamModel: candidate.upstreamModel,
    })

    let emittedEvents = false
    try {
      let response: Response
      try {
        response = await this.fetchWithResponseHeadersTimeout(
          url,
          fetchOptions,
          180_000,
          "Claude API stream timed out waiting for upstream response headers after 180000ms",
          abortSignal
        )
      } catch (error) {
        const abortedError = toUpstreamRequestAbortedError(
          error,
          abortSignal,
          "Claude API stream aborted"
        )
        if (abortedError) {
          throw abortedError
        }
        this.logger.error(
          `[Claude API] Stream fetch failed before headers: account=${candidate.account.label || candidate.account.baseUrl}, model=${candidate.upstreamModel}, url=${url}, detail=${formatUnknownError(error)}`
        )
        await appendClaudeResponseError(requestLog, error)
        throw this.buildTransientFailureError(
          candidate.account,
          504,
          formatUnknownError(error),
          candidate.upstreamModel
        )
      }

      const responseHeaders = headersToRecord(response.headers)
      await appendClaudeResponseMetadata(
        requestLog,
        response.status,
        responseHeaders
      )

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Claude API] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )
        await appendClaudeResponseChunk(requestLog, errorBody)
        throw this.buildHttpFailureError(
          candidate.account,
          response.status,
          errorBody,
          candidate.upstreamModel,
          response.headers.get("retry-after") || undefined
        )
      }

      if (!response.body) {
        throw this.buildTransientFailureError(
          candidate.account,
          502,
          "Claude API response has no body",
          candidate.upstreamModel
        )
      }

      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("text/html")) {
        const errorBodyText = await response.text()
        throw this.buildTransientFailureError(
          candidate.account,
          503,
          `Claude API returned HTML page: ${errorBodyText.slice(0, 200)}`,
          candidate.upstreamModel
        )
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const streamUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        webSearchRequests: 0,
      }
      // Track wire-shape invariants Anthropic CC CLI relies on. We use the
      // tracker to bail out (with a fall-back-eligible 502) BEFORE any
      // bytes are emitted to the client when the upstream returns an
      // explicit `event: error` or an obviously empty body. Once the
      // client has seen bytes we only log violations.
      const streamShape: ClaudeStreamShape = {
        sawMessageStart: false,
        sawMessageDelta: false,
        upstreamErrorMessage: undefined,
        upstreamErrorRaised: false,
      }

      try {
        while (true) {
          const { done, value } = await this.readStreamChunkWithTimeout(
            reader,
            180_000,
            "Claude API stream timed out while waiting for the next SSE chunk",
            abortSignal
          )

          if (done) {
            break
          }

          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n")

          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const chunk = buffer.slice(0, boundary + 2)
            buffer = buffer.slice(boundary + 2)
            // Single-pass: parse the SSE event once, then update
            // stream-shape invariants, merge usage counters, and (when
            // applicable) restore OAuth tool names. Returns the
            // possibly-rewritten chunk.
            const restored = this.processClaudeStreamChunk(
              chunk,
              streamShape,
              streamUsage,
              oauthToolReverseMap
            )
            // If a malformed `event: error` arrived before any client-visible
            // bytes were emitted, surface it as a BackendApiError so the
            // fallback chain can take over instead of leaking a partial SSE
            // stream that the client has no way to interpret.
            if (
              !emittedEvents &&
              streamShape.upstreamErrorMessage &&
              !streamShape.upstreamErrorRaised
            ) {
              streamShape.upstreamErrorRaised = true
              throw new BackendApiError(
                `Claude API stream returned upstream error: ${streamShape.upstreamErrorMessage}`,
                {
                  backend: "claude-api",
                  statusCode: 502,
                }
              )
            }
            emittedEvents = true
            await appendClaudeResponseChunk(requestLog, restored)
            yield restored.endsWith("\n\n") ? restored : `${restored}\n\n`
            boundary = buffer.indexOf("\n\n")
          }
        }

        const trailing = buffer.trim()
        if (trailing) {
          const restored = this.processClaudeStreamChunk(
            trailing,
            streamShape,
            streamUsage,
            oauthToolReverseMap
          )
          if (
            !emittedEvents &&
            streamShape.upstreamErrorMessage &&
            !streamShape.upstreamErrorRaised
          ) {
            streamShape.upstreamErrorRaised = true
            throw new BackendApiError(
              `Claude API stream returned upstream error: ${streamShape.upstreamErrorMessage}`,
              {
                backend: "claude-api",
                statusCode: 502,
              }
            )
          }
          emittedEvents = true
          await appendClaudeResponseChunk(requestLog, restored)
          yield restored.endsWith("\n\n") ? restored : `${restored}\n\n`
        }

        if (!emittedEvents) {
          throw new BackendApiError(
            "Claude API stream returned an empty body",
            {
              backend: "claude-api",
              statusCode: 502,
            }
          )
        }

        // Once the client has seen bytes we cannot take them back, but we
        // still flag protocol violations to the request log so the next
        // bug report has a hint that the upstream short-circuited.
        if (!streamShape.sawMessageStart) {
          this.logger.warn(
            "[Claude API] stream completed without message_start — upstream may be malformed"
          )
        }
        if (!streamShape.sawMessageDelta) {
          this.logger.warn(
            "[Claude API] stream completed without message_delta — upstream may be malformed"
          )
        }

        this.markAccountHealthy(candidate.account, candidate.upstreamModel)
        this.recordClaudeApiUsage(
          candidate,
          "messages",
          {
            input_tokens: streamUsage.inputTokens,
            cache_read_input_tokens: streamUsage.cachedInputTokens,
            cache_creation_input_tokens: streamUsage.cacheCreationInputTokens,
            output_tokens: streamUsage.outputTokens,
            server_tool_use: {
              web_search_requests: streamUsage.webSearchRequests,
            },
          },
          requestStartedAt
        )
        // Phase 2 of cache-break detection: compare cache_read tokens
        // against the baseline captured by recordPromptState above and
        // emit a `prompt_cache.break` telemetry event when both the
        // ratio and absolute drop thresholds are crossed.
        this.promptCacheBreakDetection.checkResponseForCacheBreak({
          sessionId: cacheBreakTracking?.sessionId,
          agentId: cacheBreakTracking?.agentId,
          cacheReadTokens: streamUsage.cachedInputTokens,
          cacheCreationTokens: streamUsage.cacheCreationInputTokens,
          lastAssistantTimestampMs:
            cacheBreakTracking?.lastAssistantTimestampMs,
        })
        return
      } catch (error) {
        const abortedError = toUpstreamRequestAbortedError(
          error,
          abortSignal,
          "Claude API stream aborted"
        )
        if (abortedError) {
          throw abortedError
        }
        await appendClaudeResponseError(requestLog, error)
        this.markAccountTemporaryFailure(
          candidate.account,
          504,
          candidate.upstreamModel
        )

        const nextCandidate =
          !emittedEvents &&
          this.shouldRetryWithNextCandidate(
            error,
            candidate,
            candidate.upstreamModel
          )
            ? this.nextRetryCandidate(dto.model, attemptedCandidates)
            : null
        if (nextCandidate) {
          this.logger.warn(
            `[Claude API] Stream failed on ${candidate.account.label || "account"} (${candidate.upstreamModel}), retrying with ${nextCandidate.account.label || "account"} (${nextCandidate.upstreamModel})`
          )
          yield* this.executeStreamWithCooldownRetry(
            dto,
            forwardHeaders,
            clientMode,
            attemptedCandidates,
            abortSignal,
            nextCandidate,
            cacheBreakTracking
          )
          return
        }

        throw error
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // ignore reader release failures
        }
      }
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Claude API stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      await appendClaudeResponseError(requestLog, error)

      const nextCandidate =
        !emittedEvents &&
        this.shouldRetryWithNextCandidate(
          error,
          candidate,
          candidate.upstreamModel
        )
          ? this.nextRetryCandidate(dto.model, attemptedCandidates)
          : null
      if (nextCandidate) {
        this.logger.warn(
          `[Claude API] Stream request failed on ${candidate.account.label || "account"} (${candidate.upstreamModel}), retrying with ${nextCandidate.account.label || "account"} (${nextCandidate.upstreamModel})`
        )
        yield* this.executeStreamWithCooldownRetry(
          dto,
          forwardHeaders,
          clientMode,
          attemptedCandidates,
          abortSignal,
          nextCandidate,
          cacheBreakTracking
        )
        return
      }
      throw error
    }
  }

  private buildCandidateKey(candidate: ClaudeApiCandidate): string {
    return [
      candidate.account.stateKey,
      candidate.upstreamModel.trim().toLowerCase(),
      candidate.publicModelId.trim().toLowerCase(),
    ].join("\0")
  }

  private shouldRetryWithNextCandidate(
    error: unknown,
    candidate: ClaudeApiCandidate,
    model: string
  ): boolean {
    if (!isAccountAvailableForModel(candidate.account, model)) {
      return true
    }

    if (!(error instanceof BackendApiError)) {
      return false
    }

    const statusCode = error.statusCode
    if (typeof statusCode !== "number") {
      return false
    }

    return (
      statusCode === 401 ||
      statusCode === 402 ||
      statusCode === 403 ||
      statusCode === 404 ||
      statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 429 ||
      statusCode >= 500
    )
  }

  /**
   * Bridges the Claude API request body shape into the input shape
   * `PromptCacheBreakDetectionService.recordPromptState` expects. The
   * upstream wire body has already been compiled at this point (system
   * is an array of text blocks with cache_control applied; tools are
   * the final schema array; betas live on the `betas` body field).
   *
   * Stateless callers (no sessionId) are filtered upstream — this
   * helper still safely no-ops because the underlying service drops
   * any input without a tracking key.
   */
  private recordCacheBreakPromptState(
    body: Record<string, unknown>,
    dto: CreateMessageDto,
    tracking?: { sessionId?: string; agentId?: string }
  ): void {
    if (!tracking?.sessionId) return
    const systemRaw = body.system
    const system = Array.isArray(systemRaw)
      ? (systemRaw as ReadonlyArray<Record<string, unknown>>)
      : typeof systemRaw === "string"
        ? [{ type: "text", text: systemRaw }]
        : []
    const toolsRaw = body.tools
    const toolSchemas = Array.isArray(toolsRaw)
      ? (toolsRaw as ReadonlyArray<Record<string, unknown>>)
      : []
    const betasRaw = body.betas
    const betas = Array.isArray(betasRaw)
      ? (betasRaw as unknown[]).filter(
          (v): v is string => typeof v === "string"
        )
      : []
    const model = typeof body.model === "string" ? body.model : dto.model

    this.promptCacheBreakDetection.recordPromptState({
      sessionId: tracking.sessionId,
      agentId: tracking.agentId,
      system,
      toolSchemas,
      model,
      betas,
      // extra body params: any field outside the standard set. Kept as
      // an opaque hash dimension so toggles (thinking, max_tokens, etc.)
      // get attributed correctly without leaking values.
      extraBodyParams: {
        max_tokens: body.max_tokens,
        thinking: body.thinking,
        metadata: body.metadata,
        stop_sequences: body.stop_sequences,
        top_k: body.top_k,
        top_p: body.top_p,
        temperature: body.temperature,
      },
    })
  }

  private recordClaudeApiUsage(
    candidate: ClaudeApiCandidate,
    transport: string,
    usage:
      | {
          input_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
          output_tokens?: number
          server_tool_use?: {
            web_search_requests?: number
          }
        }
      | Record<string, unknown>
      | null
      | undefined,
    requestStartedAt?: number
  ): void {
    const usageRecord =
      usage && typeof usage === "object"
        ? (usage as Record<string, unknown>)
        : null
    const serverToolUse =
      usageRecord?.server_tool_use &&
      typeof usageRecord.server_tool_use === "object"
        ? (usageRecord.server_tool_use as Record<string, unknown>)
        : null
    this.usageStats.recordClaudeApiUsage({
      transport,
      modelName: candidate.upstreamModel,
      accountKey: candidate.account.stateKey,
      accountLabel: candidate.account.label || candidate.account.baseUrl,
      inputTokens:
        typeof usageRecord?.input_tokens === "number"
          ? usageRecord.input_tokens
          : 0,
      cachedInputTokens:
        typeof usageRecord?.cache_read_input_tokens === "number"
          ? usageRecord.cache_read_input_tokens
          : 0,
      cacheCreationInputTokens:
        typeof usageRecord?.cache_creation_input_tokens === "number"
          ? usageRecord.cache_creation_input_tokens
          : 0,
      outputTokens:
        typeof usageRecord?.output_tokens === "number"
          ? usageRecord.output_tokens
          : 0,
      webSearchRequests:
        typeof serverToolUse?.web_search_requests === "number"
          ? serverToolUse.web_search_requests
          : 0,
      durationMs:
        typeof requestStartedAt === "number"
          ? Math.max(0, Date.now() - requestStartedAt)
          : 0,
    })
  }

  /**
   * Inspect a single SSE event chunk and update the wire-shape tracker so
   * the caller can decide whether a stream is malformed before it commits
   * bytes to the client.
   *
   * Tracks two structural invariants Claude Code CLI depends on:
   *   - `message_start` event appears at least once
   *   - `message_delta` event appears at least once
   *
   * Plus the explicit-error short circuit:
   *   - `event: error` payloads are extracted into
   *     `upstreamErrorMessage` so the caller can convert them into a
   *     fall-back-eligible BackendApiError.
   */
  /**
   * Single-pass per-chunk SSE handler for Anthropic streams.
   *
   * Replaces the historical three-pass pipeline
   * (`observeClaudeStreamEvent` → `mergeClaudeStreamUsage` →
   * `restoreOAuthToolNamesFromStreamChunk`) which each split the chunk
   * by newline and ran `JSON.parse` independently. On a long stream
   * those three parses were the dominant per-token CPU cost; merging
   * them into a single parse roughly halves the per-chunk overhead.
   *
   * Side-effects (in order):
   *   1. `state.sawMessageStart` / `state.sawMessageDelta` /
   *      `state.upstreamErrorMessage` set when the matching event arrives.
   *   2. `usage` token counters merged from `message_start.message.usage`
   *      and `message_delta.usage`.
   *   3. When `reverseMap` is non-empty and the event is a
   *      `content_block_start` with a `tool_use` / `tool_reference`
   *      block whose name is in the map, the block is renamed back to
   *      the client-side spelling and the chunk is re-stringified.
   *
   * Returns the (possibly rewritten) chunk verbatim. Malformed JSON or
   * missing data lines fall through with no mutation.
   */
  private processClaudeStreamChunk(
    chunk: string,
    state: ClaudeStreamShape,
    usage: {
      inputTokens: number
      cachedInputTokens: number
      cacheCreationInputTokens: number
      outputTokens: number
      webSearchRequests: number
    },
    reverseMap: Record<string, string>
  ): string {
    const lines = chunk.split("\n")
    let eventType = ""
    let dataLineIdx = -1
    let dataLine = ""

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLineIdx = i
        dataLine = line.slice(5).trim()
      }
    }

    if (!dataLine || dataLine === "[DONE]") return chunk

    let payload: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(dataLine)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      return chunk
    }
    if (!payload) return chunk

    const payloadType =
      typeof payload.type === "string" ? payload.type : eventType

    // ── 1. Stream-shape invariants ────────────────────────────────
    if (payloadType === "message_start") {
      state.sawMessageStart = true
    } else if (payloadType === "message_delta") {
      state.sawMessageDelta = true
    } else if (payloadType === "error") {
      const errorObj =
        payload.error && typeof payload.error === "object"
          ? (payload.error as Record<string, unknown>)
          : null
      if (errorObj) {
        const message =
          typeof errorObj.message === "string" ? errorObj.message.trim() : ""
        const errType =
          typeof errorObj.type === "string" ? errorObj.type.trim() : ""
        state.upstreamErrorMessage = message || errType || "unknown error"
      } else {
        state.upstreamErrorMessage = "unknown error"
      }
    }

    // ── 2. Token-usage merge ──────────────────────────────────────
    if (payloadType === "message_start") {
      const message =
        payload.message && typeof payload.message === "object"
          ? (payload.message as Record<string, unknown>)
          : null
      const u =
        message?.usage && typeof message.usage === "object"
          ? (message.usage as Record<string, unknown>)
          : null
      if (u) mergeUsageInto(usage, u)
    } else if (payloadType === "message_delta") {
      const u =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as Record<string, unknown>)
          : null
      if (u) mergeUsageInto(usage, u)
    }

    // ── 3. OAuth tool-name restore (only when there's anything to
    //     restore — keeps real-CC pass-through path zero-cost). ────
    if (
      Object.keys(reverseMap).length > 0 &&
      payloadType === "content_block_start"
    ) {
      const block =
        payload.content_block && typeof payload.content_block === "object"
          ? (payload.content_block as Record<string, unknown>)
          : null
      if (block) {
        let mutated = false
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : ""
          const restored = reverseMap[name]
          if (restored != null && restored !== name) {
            block.name = restored
            mutated = true
          }
        } else if (block.type === "tool_reference") {
          const toolName =
            typeof block.tool_name === "string" ? block.tool_name : ""
          const restored = reverseMap[toolName]
          if (restored != null && restored !== toolName) {
            block.tool_name = restored
            mutated = true
          }
        }
        if (mutated && dataLineIdx >= 0) {
          lines[dataLineIdx] = `data: ${JSON.stringify(payload)}`
          return lines.join("\n")
        }
      }
    }

    return chunk
  }

  private nextRetryCandidate(
    model: string,
    attemptedCandidates: Set<string>
  ): ClaudeApiCandidate | null {
    const remainingCandidates = this.resolveCandidates(model).filter(
      (candidate) => !attemptedCandidates.has(this.buildCandidateKey(candidate))
    )
    if (remainingCandidates.length === 0) {
      return null
    }

    return this.selectCandidate(model, remainingCandidates)
  }

  private getActiveModelCooldowns(
    account: ClaudeApiAccount,
    now: number
  ): BackendPoolStatus["entries"][number]["modelCooldowns"] {
    return Array.from(account.modelStates.entries())
      .filter(([, state]) => state.cooldownUntil > now)
      .map(([model, state]) => ({
        model,
        cooldownUntil: state.cooldownUntil,
        quotaExhausted: state.quotaExhausted,
        backoffLevel: state.backoffLevel,
      }))
      .sort((left, right) => left.cooldownUntil - right.cooldownUntil)
  }

  private getPoolEntryState(
    account: ClaudeApiAccount,
    modelCooldowns: BackendPoolStatus["entries"][number]["modelCooldowns"],
    now: number
  ): BackendPoolEntryState {
    if (isAccountDisabled(account)) {
      return "disabled"
    }
    if (account.cooldownUntil > now) {
      return "cooldown"
    }
    if (modelCooldowns.length > 0) {
      return "model_cooldown"
    }
    return "ready"
  }

  private buildAccountStateKey(
    apiKey: string,
    baseUrl: string,
    prefix?: string
  ): string {
    return crypto
      .createHash("sha256")
      .update(baseUrl)
      .update("\0")
      .update(prefix || "")
      .update("\0")
      .update(apiKey)
      .digest("hex")
  }

  /**
   * Return a stable session id for an account. Real Claude Code CLI uses a
   * single per-credential session id across requests within one process,
   * so we lazily generate one and cache it in-memory keyed on the
   * account's deterministic state key.
   */
  private getCachedSessionId(stateKey: string): string {
    const cached = this.sessionIdCache.get(stateKey)
    if (cached) return cached
    const fresh = crypto.randomUUID()
    this.sessionIdCache.set(stateKey, fresh)
    return fresh
  }

  private normalizeBaseUrl(baseUrl?: string): string {
    const normalized = (baseUrl || "").trim()
    return normalized || DEFAULT_ANTHROPIC_BASE_URL
  }

  private configureAccountStateStore(_configPath?: string | null): void {
    // No-op: PersistenceService handles the unified DB path.
    // Kept for interface compatibility.
  }

  private normalizeModels(
    models?: Array<{ name?: string; alias?: string }>
  ): ClaudeApiModelMapping[] {
    if (!Array.isArray(models)) {
      return []
    }

    const out: ClaudeApiModelMapping[] = []
    for (const model of models) {
      const name = (model?.name || "").trim()
      if (!name) {
        continue
      }
      const alias = (model?.alias || "").trim()
      out.push(alias ? { name, alias } : { name })
    }
    return out
  }

  private normalizeHeaders(
    headers?: Record<string, string>
  ): Record<string, string> | undefined {
    if (!headers || typeof headers !== "object") {
      return undefined
    }

    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      const normalizedKey = key.trim()
      const normalizedValue = `${value}`.trim()
      if (!normalizedKey || !normalizedValue) {
        continue
      }
      out[normalizedKey] = normalizedValue
    }

    return Object.keys(out).length > 0 ? out : undefined
  }

  private normalizeExcludedModels(models?: string[]): string[] {
    if (!Array.isArray(models) || models.length === 0) {
      return []
    }

    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of models) {
      const normalized = `${raw}`.trim().toLowerCase()
      if (!normalized || seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      out.push(normalized)
    }
    return out
  }

  private buildAccountRecord(params: {
    label?: string
    apiKey: string
    baseUrl?: string
    proxyUrl?: string
    maxContextTokens?: number
    stripThinking?: boolean
    disablePromptCaching?: boolean
    prefix?: string
    priority?: number
    headers?: Record<string, string>
    models?: Array<{ name?: string; alias?: string }>
    excludedModels?: string[]
    source: "env" | "file"
    oauth?: {
      refreshToken?: string
      accessTokenExpiresAt?: number
      accountUuid?: string
      organizationUuid?: string
    }
  }): ClaudeApiAccount {
    const baseUrl = this.normalizeBaseUrl(params.baseUrl)
    const prefix = params.prefix?.trim() || undefined
    return {
      label: params.label?.trim() || undefined,
      apiKey: params.apiKey.trim(),
      baseUrl,
      proxyUrl: params.proxyUrl?.trim() || undefined,
      maxContextTokens: this.normalizeMaxContextTokens(params.maxContextTokens),
      stripThinking: params.stripThinking === true,
      disablePromptCaching: params.disablePromptCaching === true,
      prefix,
      priority:
        typeof params.priority === "number" && Number.isFinite(params.priority)
          ? params.priority
          : 0,
      headers: this.normalizeHeaders(params.headers),
      models: this.normalizeModels(params.models),
      excludedModels: this.normalizeExcludedModels(params.excludedModels),
      source: params.source,
      stateKey: this.buildAccountStateKey(
        params.apiKey.trim(),
        baseUrl,
        prefix
      ),
      discoveredModels: [],
      cooldownUntil: 0,
      modelStates: new Map(),
      oauth: this.normalizeOauthMetadata(params.oauth),
    }
  }

  private normalizeOauthMetadata(oauth?: {
    refreshToken?: string
    accessTokenExpiresAt?: number
    accountUuid?: string
    organizationUuid?: string
  }): ClaudeApiAccount["oauth"] {
    if (!oauth) return undefined
    const refreshToken = (oauth.refreshToken || "").trim()
    if (!refreshToken) return undefined
    const expiresAt =
      typeof oauth.accessTokenExpiresAt === "number" &&
      Number.isFinite(oauth.accessTokenExpiresAt)
        ? oauth.accessTokenExpiresAt
        : 0
    return {
      refreshToken,
      accessTokenExpiresAt: expiresAt,
      accountUuid: oauth.accountUuid?.trim() || undefined,
      organizationUuid: oauth.organizationUuid?.trim() || undefined,
    }
  }

  private getDiscoveredModelMappings(
    account: ClaudeApiAccount
  ): ClaudeApiModelMapping[] {
    return account.discoveredModels.map((model) => ({ name: model.name }))
  }

  private getResolvedModelMappings(
    account: ClaudeApiAccount
  ): ClaudeApiModelMapping[] {
    if (account.models.length > 0) {
      return account.models
    }

    return this.getDiscoveredModelMappings(account)
  }

  private getAdvertisedModelsForAccount(
    account: ClaudeApiAccount
  ): ClaudeApiPublicModel[] {
    if (account.models.length > 0) {
      return account.models.map((mapping) => ({
        id: mapping.alias || mapping.name,
        displayName: mapping.alias || mapping.name,
        isThinking: doesModelIdRequireExplicitThinkingSupport(
          mapping.alias || mapping.name
        ),
      }))
    }

    if (account.discoveredModels.length > 0) {
      return account.discoveredModels.map((model) => ({
        id: model.name,
        displayName: model.displayName || model.name,
        createdAt: model.createdAt,
        isThinking:
          model.isThinking ||
          doesModelIdRequireExplicitThinkingSupport(model.name),
      }))
    }

    return DEFAULT_PUBLIC_CLAUDE_MODEL_IDS.map((modelId) => ({
      id: modelId,
      displayName: modelId,
      isThinking: doesModelIdRequireExplicitThinkingSupport(modelId),
    }))
  }

  private shouldDiscoverModelsForAccount(account: ClaudeApiAccount): boolean {
    return account.models.length === 0
  }

  private shouldRefreshDiscovery(account: ClaudeApiAccount): boolean {
    return (
      this.shouldDiscoverModelsForAccount(account) &&
      (!account.discoveredModelsFetchedAt ||
        Date.now() - account.discoveredModelsFetchedAt >=
          MODEL_DISCOVERY_TTL_MS)
    )
  }

  private refreshDiscoveredModelsInBackgroundIfNeeded(): void {
    for (const account of this.accounts) {
      if (!this.shouldRefreshDiscovery(account)) {
        continue
      }

      void this.refreshDiscoveredModelsForAccount(account).catch((error) => {
        this.logger.debug(
          `[Claude API] Background model discovery failed for ${account.label || account.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
        )
      })
    }
  }

  private async refreshDiscoveredModelsForAccount(
    account: ClaudeApiAccount,
    options: { force?: boolean } = {}
  ): Promise<void> {
    if (!this.shouldDiscoverModelsForAccount(account)) {
      account.discoveredModels = []
      account.discoveredModelsFetchedAt = Date.now()
      return
    }

    if (!options.force && !this.shouldRefreshDiscovery(account)) {
      return
    }

    if (account.discoveryPromise) {
      return account.discoveryPromise
    }

    account.discoveryPromise = (async () => {
      try {
        account.discoveredModels = await this.fetchModelsForAccount(account)
      } catch (error) {
        this.logger.debug(
          `[Claude API] Model discovery unavailable for ${account.label || account.baseUrl}: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        account.discoveredModelsFetchedAt = Date.now()
        account.discoveryPromise = undefined
      }
    })()

    return account.discoveryPromise
  }

  private async fetchModelsForAccount(
    account: ClaudeApiAccount
  ): Promise<ClaudeApiDiscoveredModel[]> {
    const discovered = new Map<string, ClaudeApiDiscoveredModel>()
    let afterId: string | undefined

    for (let page = 0; page < MODEL_DISCOVERY_MAX_PAGES; page++) {
      const response = await this.fetchModelPage(account, afterId)

      for (const model of response.models) {
        const normalized = model.name.toLowerCase()
        if (!normalized || discovered.has(normalized)) {
          continue
        }
        discovered.set(normalized, model)
      }

      if (
        !response.hasMore ||
        !response.lastId ||
        response.lastId === afterId
      ) {
        break
      }
      afterId = response.lastId
    }

    return Array.from(discovered.values()).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  private async fetchModelPage(
    account: ClaudeApiAccount,
    afterId?: string
  ): Promise<{
    models: ClaudeApiDiscoveredModel[]
    hasMore: boolean
    lastId?: string
  }> {
    const url = this.buildModelsUrl(account.baseUrl, afterId)
    const headers = this.buildHeadersForAccount(account, false, {}, [])
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers,
    }

    const dispatcher = this.buildProxyAgent(account)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await this.fetchWithResponseHeadersTimeout(
      url,
      fetchOptions,
      MODEL_DISCOVERY_TIMEOUT_MS,
      `Claude API model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms`
    )

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(
        `status=${response.status} body=${this.buildErrorPreview(detail)}`
      )
    }

    const payload = await readJsonWithMagicByteSniff<{
      data?: unknown[]
      has_more?: boolean
      last_id?: string
    }>(response)

    return {
      models: this.parseDiscoveredModels(payload.data),
      hasMore: payload?.has_more === true,
      lastId:
        typeof payload?.last_id === "string" && payload.last_id.trim()
          ? payload.last_id.trim()
          : undefined,
    }
  }

  private parseDiscoveredModels(data: unknown): ClaudeApiDiscoveredModel[] {
    if (!Array.isArray(data)) {
      return []
    }

    const models: ClaudeApiDiscoveredModel[] = []
    const seen = new Set<string>()

    for (const entry of data) {
      const model = this.parseDiscoveredModelEntry(entry)
      if (!model) {
        continue
      }

      const normalized = model.name.toLowerCase()
      if (seen.has(normalized)) {
        continue
      }
      seen.add(normalized)
      models.push(model)
    }

    return models
  }

  private parseDiscoveredModelEntry(
    entry: unknown
  ): ClaudeApiDiscoveredModel | null {
    if (!entry || typeof entry !== "object") {
      return null
    }

    const rawEntry = entry as {
      id?: unknown
      name?: unknown
      display_name?: unknown
      displayName?: unknown
      created_at?: unknown
      createdAt?: unknown
      capabilities?: {
        thinking?: {
          supported?: unknown
        }
      }
      thinking?: unknown
    }

    const name =
      typeof rawEntry.id === "string" && rawEntry.id.trim()
        ? rawEntry.id.trim()
        : typeof rawEntry.name === "string" && rawEntry.name.trim()
          ? rawEntry.name.trim()
          : ""
    if (!name) {
      return null
    }

    const displayName =
      typeof rawEntry.display_name === "string" && rawEntry.display_name.trim()
        ? rawEntry.display_name.trim()
        : typeof rawEntry.displayName === "string" &&
            rawEntry.displayName.trim()
          ? rawEntry.displayName.trim()
          : undefined

    const createdAtRaw =
      typeof rawEntry.created_at === "string"
        ? rawEntry.created_at
        : typeof rawEntry.createdAt === "string"
          ? rawEntry.createdAt
          : ""
    const createdAt = createdAtRaw ? Date.parse(createdAtRaw) : NaN

    return {
      name,
      displayName,
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      isThinking:
        rawEntry.capabilities?.thinking?.supported === true ||
        rawEntry.thinking === true ||
        doesModelIdRequireExplicitThinkingSupport(name),
    }
  }

  private loadAllAccountsFromFile(): ClaudeApiAccount[] {
    const configPaths = getAccountConfigPathCandidates(
      "claude-api-accounts.json"
    )

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(
          fs.readFileSync(configPath, "utf8")
        ) as ClaudeApiConfigFile
        if (typeof data.forceModelPrefix === "boolean") {
          this.forceModelPrefix = data.forceModelPrefix
        }
        if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
          continue
        }

        this.accountsConfigPath = configPath
        this.configureAccountStateStore(configPath)
        this.logger.log(
          `Loaded ${data.accounts.length} Claude API account(s) from ${configPath}`
        )

        return data.accounts
          .filter(
            (entry): entry is ClaudeApiAccountFileEntry & { apiKey: string } =>
              typeof entry?.apiKey === "string" && entry.apiKey.trim() !== ""
          )
          .map((entry) =>
            this.buildAccountRecord({
              label: entry.label,
              apiKey: entry.apiKey,
              baseUrl: entry.baseUrl,
              proxyUrl: entry.proxyUrl,
              maxContextTokens: entry.maxContextTokens,
              stripThinking: entry.stripThinking,
              disablePromptCaching: entry.disablePromptCaching,
              prefix: entry.prefix,
              priority: entry.priority,
              headers: entry.headers,
              models: entry.models,
              excludedModels: entry.excludedModels,
              oauth: entry.oauth,
              source: "file",
            })
          )
      } catch (error) {
        this.logger.warn(
          `Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    return []
  }

  private loadPersistedAccountStates(): Map<
    string,
    PersistedClaudeApiAccountState
  > {
    return this.accountStateStore.loadStates("claude-api")
  }

  private applyPersistedAccountState(
    account: ClaudeApiAccount,
    state?: PersistedClaudeApiAccountState
  ): void {
    if (!state) {
      return
    }

    const now = Date.now()

    if (typeof state.disabledAt === "number" && state.disabledAt > 0) {
      account.disabledAt = state.disabledAt
      account.disabledReason = state.disabledReason
      account.disabledStatusCode = state.disabledStatusCode
      account.disabledMessage = state.disabledMessage
      account.cooldownUntil = 0
      account.modelStates.clear()
      return
    }

    if (typeof state.cooldownUntil === "number" && state.cooldownUntil > now) {
      account.cooldownUntil = state.cooldownUntil
    }

    if (Array.isArray(state.modelStates)) {
      for (const modelState of state.modelStates) {
        if (
          !modelState ||
          typeof modelState.model !== "string" ||
          !modelState.model ||
          typeof modelState.cooldownUntil !== "number" ||
          modelState.cooldownUntil <= now
        ) {
          continue
        }

        account.modelStates.set(modelState.model, {
          cooldownUntil: modelState.cooldownUntil,
          quotaExhausted: !!modelState.quotaExhausted,
          backoffLevel:
            typeof modelState.backoffLevel === "number"
              ? modelState.backoffLevel
              : 0,
        })
      }
    }
  }

  private serializeAccountState(
    account: ClaudeApiAccount
  ): PersistedClaudeApiAccountState | null {
    if (
      !isAccountDisabled(account) &&
      account.cooldownUntil <= 0 &&
      account.modelStates.size === 0
    ) {
      return null
    }

    const record: PersistedClaudeApiAccountState = {
      stateKey: account.stateKey,
      label: account.label,
      updatedAt: Date.now(),
    }

    if (isAccountDisabled(account)) {
      record.disabledAt = account.disabledAt
      record.disabledReason = account.disabledReason
      record.disabledStatusCode = account.disabledStatusCode
      record.disabledMessage = account.disabledMessage
      return record
    }

    if (account.cooldownUntil > 0) {
      record.cooldownUntil = account.cooldownUntil
    }

    if (account.modelStates.size > 0) {
      record.modelStates = Array.from(account.modelStates.entries()).map(
        ([model, modelState]) => ({
          model,
          cooldownUntil: modelState.cooldownUntil,
          quotaExhausted: modelState.quotaExhausted,
          backoffLevel: modelState.backoffLevel,
        })
      )
    }

    return record
  }

  private persistAccountStates(): void {
    this.accountStateStore.replaceStates(
      "claude-api",
      this.accounts
        .map((account) => this.serializeAccountState(account))
        .filter(
          (account): account is PersistedClaudeApiAccountState =>
            account != null
        )
    )
  }

  private normalizeRequestedModel(model: string): {
    prefix?: string
    model: string
  } {
    const normalized = model.trim()
    const slashIndex = normalized.indexOf("/")
    if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
      return { model: normalized.toLowerCase() }
    }

    return {
      prefix: normalized.slice(0, slashIndex).trim().toLowerCase(),
      model: normalized
        .slice(slashIndex + 1)
        .trim()
        .toLowerCase(),
    }
  }

  private applyPrefix(prefix: string | undefined, modelId: string): string {
    const normalizedModel = modelId.trim()
    if (!normalizedModel) {
      return normalizedModel
    }
    return prefix ? `${prefix}/${normalizedModel}` : normalizedModel
  }

  private buildVisibleModelIdsForAccount(
    account: ClaudeApiAccount,
    modelId: string
  ): string[] {
    const baseId = modelId.trim()
    if (!baseId) {
      return []
    }

    const out: string[] = []
    const seen = new Set<string>()
    const add = (value: string) => {
      const normalized = value.trim()
      if (!normalized || seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      out.push(normalized)
    }

    const prefix = account.prefix?.trim()
    if (!prefix) {
      add(baseId)
      return out
    }

    if (!this.forceModelPrefix || prefix === baseId) {
      add(baseId)
    }
    add(`${prefix}/${baseId}`)
    return out
  }

  private matchWildcard(pattern: string, value: string): boolean {
    if (!pattern) {
      return false
    }
    if (!pattern.includes("*")) {
      return pattern === value
    }

    const parts = pattern.split("*")
    let remaining = value

    const prefix = parts[0]
    if (prefix) {
      if (!remaining.startsWith(prefix)) {
        return false
      }
      remaining = remaining.slice(prefix.length)
    }

    const suffix = parts[parts.length - 1]
    if (suffix) {
      if (!remaining.endsWith(suffix)) {
        return false
      }
      remaining = remaining.slice(0, remaining.length - suffix.length)
    }

    for (let index = 1; index < parts.length - 1; index++) {
      const segment = parts[index]
      if (!segment) {
        continue
      }
      const matchIndex = remaining.indexOf(segment)
      if (matchIndex < 0) {
        return false
      }
      remaining = remaining.slice(matchIndex + segment.length)
    }

    return true
  }

  private isModelExcluded(
    account: ClaudeApiAccount,
    publicModelId: string
  ): boolean {
    const normalized = publicModelId.trim().toLowerCase()
    if (!normalized || account.excludedModels.length === 0) {
      return false
    }
    return account.excludedModels.some((pattern) =>
      this.matchWildcard(pattern, normalized)
    )
  }

  private isPublicModelIdCompatibleWithAccount(
    account: ClaudeApiAccount,
    publicModelId: string
  ): boolean {
    if (!account.stripThinking) {
      return true
    }

    return !doesModelIdRequireExplicitThinkingSupport(publicModelId)
  }

  private shouldIncludeUnprefixedRequestForAccount(
    account: ClaudeApiAccount
  ): boolean {
    const prefix = account.prefix?.trim()
    if (!prefix) {
      return true
    }
    return !this.forceModelPrefix
  }

  private resolveCandidates(model: string): ClaudeApiCandidate[] {
    this.refreshDiscoveredModelsInBackgroundIfNeeded()
    const requested = this.normalizeRequestedModel(model)
    const candidates: ClaudeApiCandidate[] = []

    for (const account of this.accounts) {
      const accountPrefix = account.prefix?.toLowerCase()
      if (requested.prefix) {
        if (!accountPrefix || accountPrefix !== requested.prefix) {
          continue
        }
      } else if (!this.shouldIncludeUnprefixedRequestForAccount(account)) {
        continue
      }

      const modelMappings = this.getResolvedModelMappings(account)
      let matchedResolvedMapping = false
      if (modelMappings.length > 0) {
        for (const mapping of modelMappings) {
          const alias = mapping.alias?.trim().toLowerCase()
          const name = mapping.name.trim().toLowerCase()
          if (
            requested.model !== name &&
            (!alias || requested.model !== alias)
          ) {
            continue
          }

          const publicModelBase = mapping.alias || mapping.name
          const publicModelId = requested.prefix
            ? this.applyPrefix(account.prefix, publicModelBase)
            : publicModelBase.trim()
          if (
            this.isModelExcluded(account, publicModelId) ||
            !this.isPublicModelIdCompatibleWithAccount(account, publicModelId)
          ) {
            continue
          }

          matchedResolvedMapping = true
          candidates.push({
            account,
            upstreamModel: mapping.name.trim(),
            publicModelId,
          })
        }
        if (matchedResolvedMapping || account.models.length > 0) {
          continue
        }
      }

      if (detectModelFamily(requested.model) !== "claude") {
        continue
      }

      const publicModelId = requested.prefix
        ? this.applyPrefix(account.prefix, requested.model)
        : requested.model
      if (
        this.isModelExcluded(account, publicModelId) ||
        !this.isPublicModelIdCompatibleWithAccount(account, publicModelId)
      ) {
        continue
      }

      candidates.push({
        account,
        upstreamModel: requested.model,
        publicModelId,
      })
    }

    return candidates
  }

  // ── Anthropic OAuth login (PKCE redirect flow) ─────────────────────────

  /**
   * Start an Anthropic OAuth + PKCE login session. The bridge spins up a
   * one-shot HTTP listener on `127.0.0.1` with an OS-allocated ephemeral
   * port (matching real CC's `server.listen(0)`) and returns the auth
   * URL plus a `sessionId` the caller polls until the user finishes the
   * redirect. Mirrors the Kiro Builder ID flow used by the dashboard.
   */
  startOAuthLogin(): {
    sessionId: string
    authUrl: string
    expiresAt: number
  } {
    this.evictExpiredOAuthLoginSessions()
    const session = startAnthropicLogin()
    const sessionId = crypto.randomUUID()
    this.oauthLoginSessions.set(sessionId, session)
    this.logger.log(
      `[Claude API] Anthropic OAuth login started (session=${sessionId.slice(
        0,
        8
      )})`
    )
    return {
      sessionId,
      authUrl: session.authUrl,
      expiresAt: session.expiresAt,
    }
  }

  /**
   * Poll an in-flight OAuth login session. While the user has not yet
   * completed the browser redirect this returns `pending`. Once the
   * local listener captures the callback we exchange the code, persist
   * the token bundle to `claude-api-accounts.json`, reload the account
   * pool, and return `completed` with the account count.
   */
  async pollOAuthLogin(sessionId: string): Promise<
    | { status: "pending" }
    | {
        status: "completed"
        accountCount: number
        path: string
        email?: string
        replaced: boolean
      }
    | { status: "expired"; message?: string }
    | { status: "error"; message: string }
  > {
    this.evictExpiredOAuthLoginSessions()
    const session = this.oauthLoginSessions.get(sessionId)
    if (!session) {
      return { status: "expired", message: "session not found" }
    }

    const snapshot = session.peek()
    if (snapshot.status === "pending") {
      if (Date.now() > session.expiresAt) {
        session.cancel()
        this.oauthLoginSessions.delete(sessionId)
        return { status: "expired", message: "callback timed out" }
      }
      return { status: "pending" }
    }

    if (snapshot.status === "failed") {
      this.oauthLoginSessions.delete(sessionId)
      return { status: "error", message: snapshot.message }
    }

    // Successful callback → exchange + persist + reload.
    this.oauthLoginSessions.delete(sessionId)
    try {
      const bundle = await exchangeAuthorizationCode({
        code: snapshot.code,
        state: snapshot.state,
        expectedState: session.state,
        verifier: session.pkce.codeVerifier,
        redirectUri: session.redirectUri,
      })

      const filePath =
        this.accountsConfigPath ||
        resolveDefaultAccountConfigPath("claude-api-accounts.json")

      const append = await appendOauthAccount({
        configFilePath: filePath,
        label: bundle.account?.email,
        baseUrl: "https://api.anthropic.com",
        apiKey: bundle.accessToken,
        refreshToken: bundle.refreshToken,
        accessTokenExpiresAt: bundle.expiresAt,
        accountUuid: bundle.account?.uuid,
        accountEmail: bundle.account?.email,
        organizationUuid: bundle.organization?.uuid,
        organizationName: bundle.organization?.name,
      })

      this.accountsConfigPath = filePath
      await this.reloadAccounts()

      this.logger.log(
        `[Claude API] OAuth login complete — wrote account to ${filePath} (replaced=${append.replaced}, total=${append.accountCount})`
      )

      return {
        status: "completed",
        accountCount: append.accountCount,
        path: filePath,
        email: bundle.account?.email,
        replaced: append.replaced,
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "OAuth exchange failed"
      this.logger.error(`[Claude API] OAuth exchange failed: ${message}`)
      return { status: "error", message }
    }
  }

  /**
   * Cancel an in-flight OAuth login session. Idempotent.
   */
  cancelOAuthLogin(sessionId: string): boolean {
    const session = this.oauthLoginSessions.get(sessionId)
    if (!session) return false
    session.cancel()
    this.oauthLoginSessions.delete(sessionId)
    return true
  }

  private evictExpiredOAuthLoginSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.oauthLoginSessions) {
      const typed: AnthropicOAuthLoginSession = session
      if (typed.expiresAt <= now) {
        typed.cancel()
        this.oauthLoginSessions.delete(id)
      }
    }
  }

  private nextCandidate(model: string): ClaudeApiCandidate {
    return this.selectCandidate(model, this.resolveCandidates(model))
  }

  /**
   * Refresh an account's token and translate any failure into the
   * account-state machine instead of letting it escape the request flow.
   *
   * `ensureFreshAccessToken` re-throws on a failed OAuth refresh. At the
   * call sites this runs before the candidate-rotation try/catch, so an
   * un-translated throw both aborts the request and — because the bridge
   * is a detached daemon — risks surfacing as a process-level crash when
   * the rejection reaches a non-awaited path. Marking the account and
   * returning `false` lets the caller cool the account down and rotate to
   * the next healthy candidate, matching how upstream HTTP failures are
   * already handled.
   *
   * Returns `true` when the account is ready to use, `false` when it was
   * just marked failed and the caller should move on.
   */
  private async prepareAccountToken(
    account: ClaudeApiAccount
  ): Promise<boolean> {
    try {
      await this.ensureFreshAccessToken(account)
      return true
    } catch (err) {
      const status =
        err instanceof AnthropicOAuthError && typeof err.status === "number"
          ? err.status
          : 401
      const message = err instanceof Error ? err.message : String(err)
      // refreshAccessTokenInternal already disables the account on a
      // permanent (non-retryable) failure; for retryable failures put it
      // on a normal cooldown so it can recover on a later request.
      if (!isAccountDisabled(account)) {
        this.markAccountTemporaryFailure(account, status)
      }
      this.logger.warn(
        `[Claude API] Token refresh failed for ${account.label || account.baseUrl}; skipping account: ${message}`
      )
      return false
    }
  }

  /**
   * Refresh an OAuth account's access token if it is within 60 seconds
   * of expiry, mutating `account.apiKey` so subsequent header builders
   * pick up the new token. Concurrent callers share a single in-flight
   * refresh so we never burn `refresh_token` rotations.
   *
   * Static API-key accounts (`account.oauth` is undefined) short-circuit
   * to a no-op.
   */
  private async ensureFreshAccessToken(
    account: ClaudeApiAccount
  ): Promise<void> {
    const oauth = account.oauth
    if (!oauth || !oauth.refreshToken) return

    const expiresAt = oauth.accessTokenExpiresAt
    if (expiresAt > Date.now() + 60_000) {
      return
    }

    if (account.oauthRefreshInFlight) {
      await account.oauthRefreshInFlight
      return
    }

    const inflight = this.refreshAccessTokenInternal(account).finally(() => {
      account.oauthRefreshInFlight = undefined
    })
    account.oauthRefreshInFlight = inflight
    await inflight
  }

  private async refreshAccessTokenInternal(
    account: ClaudeApiAccount
  ): Promise<void> {
    const oauth = account.oauth
    if (!oauth) return
    const previousApiKey = account.apiKey
    try {
      const bundle = await refreshAnthropicTokens({
        refreshToken: oauth.refreshToken,
      })
      account.apiKey = bundle.accessToken
      oauth.refreshToken = bundle.refreshToken
      oauth.accessTokenExpiresAt = bundle.expiresAt
      this.persistAccountStates()
      // Persist the rotated bundle back to claude-api-accounts.json so a
      // bridge restart does not invalidate the single-rotated refresh
      // token. Only file-sourced accounts are persisted; env-sourced
      // accounts have no on-disk record to update.
      if (
        account.source === "file" &&
        this.accountsConfigPath &&
        previousApiKey
      ) {
        try {
          await persistOauthRotation({
            configFilePath: this.accountsConfigPath,
            baseUrl: account.baseUrl,
            prefix: account.prefix,
            previousApiKey,
            rotatedApiKey: bundle.accessToken,
            rotatedRefreshToken: bundle.refreshToken,
            rotatedAccessTokenExpiresAt: bundle.expiresAt,
          })
        } catch (persistErr) {
          // Persistence failure does NOT roll back the in-memory
          // rotation: subsequent requests still succeed using the new
          // token. Surface it so operators notice that restarts will
          // require re-running the OAuth login flow.
          this.logger.error(
            `[Claude API] Persisting rotated OAuth bundle failed for ${account.label || account.baseUrl}: ${
              persistErr instanceof Error
                ? persistErr.message
                : String(persistErr)
            }`
          )
        }
      }
      this.logger.log(
        `[Claude API] Refreshed OAuth access token for ${account.label || account.baseUrl}`
      )
    } catch (err) {
      const message =
        err instanceof AnthropicOAuthError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      this.logger.error(
        `[Claude API] OAuth refresh failed for ${account.label || account.baseUrl}: ${message}`
      )
      const permanent =
        err instanceof AnthropicOAuthError && err.retryable === false
      if (permanent) {
        this.disableAccountPermanently(
          account,
          err instanceof AnthropicOAuthError && err.status ? err.status : 401,
          message
        )
      }
      throw err
    }
  }

  private selectCandidate(
    model: string,
    candidates: ClaudeApiCandidate[]
  ): ClaudeApiCandidate {
    if (candidates.length === 0) {
      throw new Error(
        `Claude API backend has no configured account for model ${model}`
      )
    }

    const now = Date.now()
    const availableByPriority = new Map<number, ClaudeApiCandidate[]>()
    const seenDisabled = new Set<string>()
    const seenCooling = new Set<string>()

    for (const candidate of candidates) {
      if (isAccountDisabled(candidate.account)) {
        seenDisabled.add(candidate.account.stateKey)
        continue
      }
      if (
        !isAccountAvailableForModel(
          candidate.account,
          candidate.upstreamModel,
          now
        )
      ) {
        seenCooling.add(candidate.account.stateKey)
        continue
      }

      const list = availableByPriority.get(candidate.account.priority) || []
      list.push(candidate)
      availableByPriority.set(candidate.account.priority, list)
    }

    if (availableByPriority.size === 0) {
      let earliestRecovery = Number.POSITIVE_INFINITY
      const nowForRecovery = Date.now()
      for (const candidate of candidates) {
        const account = candidate.account
        if (isAccountDisabled(account)) {
          continue
        }

        if (account.cooldownUntil > nowForRecovery) {
          earliestRecovery = Math.min(earliestRecovery, account.cooldownUntil)
        }

        const modelState = account.modelStates.get(candidate.upstreamModel)
        if (
          modelState?.cooldownUntil &&
          modelState.cooldownUntil > nowForRecovery
        ) {
          const effectiveRecovery =
            account.cooldownUntil > nowForRecovery
              ? Math.max(account.cooldownUntil, modelState.cooldownUntil)
              : modelState.cooldownUntil
          earliestRecovery = Math.min(earliestRecovery, effectiveRecovery)
        }
      }

      if (Number.isFinite(earliestRecovery)) {
        const retryAfterSeconds = Math.ceil(
          Math.max(0, earliestRecovery - nowForRecovery) / 1000
        )
        throw new BackendAccountPoolUnavailableError(
          `All Claude API accounts are unavailable for model ${model}. Retry after ${retryAfterSeconds} seconds.`,
          {
            backend: "claude-api",
            retryAfterSeconds,
            disabledCount: seenDisabled.size,
            coolingCount: seenCooling.size,
          }
        )
      }

      throw new BackendAccountPoolUnavailableError(
        `All Claude API accounts are permanently disabled for model ${model}.`,
        {
          backend: "claude-api",
          disabledCount: seenDisabled.size,
          coolingCount: 0,
          permanent: true,
        }
      )
    }

    const priorities = Array.from(availableByPriority.keys()).sort(
      (left, right) => right - left
    )
    const selectedPool = availableByPriority.get(priorities[0]!) || []
    const selected =
      selectedPool[this.accountIndex % selectedPool.length] || selectedPool[0]
    this.accountIndex = (this.accountIndex + 1) % Number.MAX_SAFE_INTEGER
    return selected!
  }

  private buildRequestBody(
    dto: CreateMessageDto,
    candidate: ClaudeApiCandidate,
    clientMode: ClaudeApiClientMode,
    forwardHeaders: AnthropicForwardHeaders
  ): {
    body: Record<string, unknown>
    betas: string[]
    oauthToolReverseMap: Record<string, string>
  } {
    return this.buildUpstreamRequestPayload(
      dto as unknown as Record<string, unknown>,
      candidate.upstreamModel,
      candidate.account,
      {
        applyPromptCaching: true,
        clientMode,
        forwardHeaders,
      }
    )
  }

  private normalizeBetas(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw
        .map((value) => `${value}`.trim())
        .filter((value) => value.length > 0)
    }

    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    }

    return []
  }

  private buildHeadersForAccount(
    account: ClaudeApiAccount,
    stream: boolean,
    forwardHeaders: AnthropicForwardHeaders,
    betas: string[],
    requestContext?: {
      /** Resolved upstream model id (lower-cased ok). */
      model?: string
      /** True iff the request opts into extended thinking. */
      thinkingEnabled?: boolean
    }
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      ...DEFAULT_FORWARDED_HEADERS,
    }

    // Pin the Stainless device-profile headers (User-Agent, Stainless-Os,
    // Stainless-Arch, Stainless-Package-Version, Stainless-Runtime-Version,
    // etc.) to the canonical CC CLI baseline. Real Claude Code emits this
    // full set on every request; missing or non-canonical values are a
    // fingerprinting signal Anthropic uses to bucket third-party traffic.
    applyClaudeDeviceProfileHeaders(headers)

    if (stream) {
      headers["accept-encoding"] = "identity"
    }

    for (const [key, value] of Object.entries(forwardHeaders)) {
      if (typeof value !== "string" || value.trim() === "") {
        continue
      }
      headers[key.toLowerCase()] = value.trim()
    }

    if (account.headers) {
      for (const [key, value] of Object.entries(account.headers)) {
        headers[key.toLowerCase()] = value
      }
    }

    // Build the beta header after all header sources are merged so custom
    // account headers cannot accidentally erase required official betas.
    const baseBetaStr =
      headers["anthropic-beta"] ||
      (this.shouldApplyOfficialAnthropicOptimizations(account)
        ? REQUIRED_BETA_FEATURES.join(",")
        : "")
    const existingBetas = baseBetaStr
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
    const betaSet = new Set(existingBetas)

    if (this.shouldApplyOfficialAnthropicOptimizations(account)) {
      for (const required of REQUIRED_BETA_FEATURES) {
        betaSet.add(required)
      }
      // Conditional flags — match the v2.1.142 binary's per-request
      // gating in `getAllModelBetas`. Adding them unconditionally is a
      // mild fingerprint (and in some cases a 400 from the upstream).
      if (requestContext?.thinkingEnabled) {
        betaSet.add(INTERLEAVED_THINKING_BETA)
      }
      if (
        requestContext?.model &&
        modelSupports1MContext(requestContext.model)
      ) {
        betaSet.add(CONTEXT_1M_BETA)
      }
      if (CACHE_EDITING_BETA_HEADER) {
        betaSet.add(CACHE_EDITING_BETA_HEADER)
      }
    }

    // Merge betas extracted from the request body
    for (const beta of betas) {
      betaSet.add(beta)
    }

    if (betaSet.size > 0) {
      headers["anthropic-beta"] = Array.from(betaSet).join(",")
    } else {
      delete headers["anthropic-beta"]
    }

    if (this.isOfficialAnthropicBase(account.baseUrl)) {
      // v2.1.142's `BaseAnthropic.authHeaders()` switches on credential
      // shape, not endpoint: OAuth access tokens (`sk-ant-oat...`) ride
      // `Authorization: Bearer`, while Console API keys (`sk-ant-api03...`)
      // ride `X-Api-Key`. Sending an OAuth token under `x-api-key` is a
      // direct fingerprinting mismatch — Anthropic's ingress classifies
      // by header name, then re-validates against the token prefix.
      if (isClaudeOAuthToken(account.apiKey)) {
        delete headers["x-api-key"]
        headers.authorization = `Bearer ${account.apiKey}`
      } else {
        delete headers.authorization
        headers["x-api-key"] = account.apiKey
      }
    } else {
      delete headers["x-api-key"]
      headers.authorization = `Bearer ${account.apiKey}`
    }

    // Real Claude Code CLI emits a stable per-credential session id and a
    // per-request UUID against api.anthropic.com. Forwarding our own values
    // makes the request shape match CC CLI's; for third-party Claude
    // endpoints we leave them off because not every provider tolerates
    // unknown headers.
    if (this.isOfficialAnthropicBase(account.baseUrl)) {
      if (!headers["x-claude-code-session-id"]) {
        headers["x-claude-code-session-id"] = this.getCachedSessionId(
          account.stateKey
        )
      }
      if (!headers["x-client-request-id"]) {
        headers["x-client-request-id"] = crypto.randomUUID()
      }
      // `anthropic-client-platform` is set by every CC-internal call in
      // v2.1.142 (`bY()` for /v1/code/* endpoints, the messages.create
      // path via `defaultHeaders`). Value derives from the CLI entrypoint
      // and is the canonical signal Anthropic's ingress uses to route
      // first-party CC traffic. Mirror the v2.1.142 `w9H()` mapping.
      if (!headers["anthropic-client-platform"]) {
        headers["anthropic-client-platform"] = deriveAnthropicClientPlatform(
          deriveEntrypoint(forwardHeaders)
        )
      }
    }

    // The Stainless SDK injects `X-Stainless-Helper-Method: stream` for
    // every `messages.stream(...)` call (and the matching `beta.messages`
    // helper). Non-stream requests do NOT carry this header. Real CC
    // hits this code path on every interactive turn, so the header is a
    // strong fingerprinting signal — its absence on a streamed request
    // is detectable.
    if (stream) {
      headers["x-stainless-helper-method"] = "stream"
    }

    // Re-enforce identity encoding for streams after custom headers.
    // Compressed SSE breaks the line scanner regardless of user preference.
    if (stream) {
      headers["accept-encoding"] = "identity"
    }

    return headers
  }

  private isOfficialAnthropicBase(baseUrl: string): boolean {
    try {
      const parsed = new URL(baseUrl)
      return (
        parsed.protocol === "https:" &&
        parsed.hostname.toLowerCase() === "api.anthropic.com"
      )
    } catch {
      return false
    }
  }

  private buildMessagesUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "")
    const path = /\/v1$/i.test(normalized)
      ? `${normalized}/messages`
      : `${normalized}/v1/messages`
    // Real Claude Code CLI hits `/v1/messages?beta=true` on api.anthropic.com.
    // Third-party Claude-compatible providers may not understand the query
    // and could 400, so it is gated on the official endpoint.
    return this.isOfficialAnthropicBase(baseUrl) ? `${path}?beta=true` : path
  }

  private buildCountTokensUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "")
    const path = /\/v1$/i.test(normalized)
      ? `${normalized}/messages/count_tokens`
      : `${normalized}/v1/messages/count_tokens`
    return this.isOfficialAnthropicBase(baseUrl) ? `${path}?beta=true` : path
  }

  private buildModelsUrl(baseUrl: string, afterId?: string): string {
    const normalized = baseUrl.replace(/\/+$/, "")
    const url = new URL(
      /\/v1$/i.test(normalized)
        ? `${normalized}/models`
        : `${normalized}/v1/models`
    )
    url.searchParams.set("limit", "1000")
    if (afterId) {
      url.searchParams.set("after_id", afterId)
    }
    return url.toString()
  }

  private shouldApplyOfficialAnthropicOptimizations(
    account: ClaudeApiAccount
  ): boolean {
    return this.isOfficialAnthropicBase(account.baseUrl)
  }

  private buildUpstreamRequestPayload(
    dto: Record<string, unknown>,
    upstreamModel: string,
    account: ClaudeApiAccount,
    options: {
      applyPromptCaching?: boolean
      clientMode: ClaudeApiClientMode
      forwardHeaders?: AnthropicForwardHeaders
    }
  ): {
    body: Record<string, unknown>
    betas: string[]
    oauthToolReverseMap: Record<string, string>
  } {
    // `structuredClone` is V8-native and ~3-5× faster than the
    // historical `JSON.parse(JSON.stringify(...))` round-trip. The body
    // we receive is plain JSON-shaped (no functions / Dates / DOM
    // refs), so the structured clone algorithm is a strict superset of
    // what JSON does. Repo pins Node ≥24, well above the 17.0 minimum.
    const raw = structuredClone(dto)
    const betas = this.normalizeBetas(raw.betas)

    delete raw.betas
    delete raw._conversationId
    delete raw._contextTokenBudget
    delete raw._pendingToolUseIds

    raw.model = upstreamModel
    raw.tools = this.normalizeClaudeTools(raw.tools)
    raw.tool_choice = this.normalizeClaudeToolChoice(raw.tool_choice)
    if (account.stripThinking) {
      delete raw.thinking
      delete raw.output_config
      // Defensive: even though the cursor send-time pipeline should have
      // already pruned thinking blocks for stripThinking accounts, run
      // stripSignatureBlocks here to guarantee the wire payload never
      // contains residual signed reasoning. Mirrors claude-code's
      // login.tsx:37 behaviour for credential rotation.
      const messages = raw.messages
      if (Array.isArray(messages)) {
        raw.messages = stripSignatureBlocksFlat(
          messages as Array<{
            role: "user" | "assistant"
            content: LooseMessageContent
          }>
        )
      }
    }
    // Anthropic-compatible upstreams may reject or even crash when Claude
    // models omit `max_tokens`. Force a conservative default if the caller
    // did not supply one.
    if (
      raw.max_tokens == null ||
      typeof raw.max_tokens !== "number" ||
      !Number.isFinite(raw.max_tokens) ||
      raw.max_tokens <= 0
    ) {
      raw.max_tokens = DEFAULT_MODEL_MAX_TOKENS
    }
    if (!this.shouldApplyOfficialAnthropicOptimizations(account)) {
      // Provider-native context edits are part of the official Anthropic
      // messages surface.  Claude-compatible third-party providers commonly
      // reject unknown request fields, so keep this optimization scoped to the
      // official endpoint.
      delete raw.context_management
    }

    if (options.applyPromptCaching && !account.disablePromptCaching) {
      // Apply Anthropic-style cache_control breakpoints to every Claude
      // upstream by default. CLIProxyAPI gates this on the assumption that
      // virtually every Claude-compatible provider tolerates the field
      // (they either honour it or silently ignore). Accounts that point at
      // a relay known to reject the field can set
      // `disablePromptCaching: true` to opt out.
      applyPromptCachingOptimizations(raw)
    }

    // Forced language directive for non-CLI traffic (Cursor / generic
    // callers). We deliberately skip `claude-code-cli`: that mode is
    // cloaked by applyClientModeShaping below to match real Claude Code's
    // wire shape, and mutating its system prompt would break the
    // cloaking fingerprint. For cursor/generic the system prompt reaches
    // the upstream verbatim, so this is the correct exactly-once chokepoint.
    if (options.clientMode !== "claude-code-cli") {
      raw.system = appendLanguageDirectiveToAnthropicSystem(
        raw.system,
        raw.messages
      )
    }

    // Apply client-mode-specific cloaking. For Claude Code CLI traffic on
    // an OAuth-secured Anthropic credential this rewrites system / tool /
    // metadata blocks so the request matches real Claude Code's wire
    // shape, and returns a per-request reverse tool-name map that the
    // response path uses to restore client-side naming.
    const oauthToolReverseMap = this.applyClientModeShaping(
      raw,
      account,
      options.clientMode,
      options.forwardHeaders
    )

    return {
      body: raw,
      betas,
      oauthToolReverseMap,
    }
  }

  /**
   * Apply mode-specific request shaping.
   *
   * Returns the per-request OAuth tool-name reverse map so the streaming
   * and non-streaming response paths can restore client-side naming. The
   * map is empty when cloaking does not apply (Cursor caller, generic
   * caller, non-OAuth credential, or model-exempt path).
   *
   * The branch keeps Cursor traffic untouched: Cursor callers always pass
   * `clientMode: "cursor"`, which short-circuits cloaking entirely so
   * Cursor's protocol-native system prompt and tool naming reach the
   * upstream verbatim.
   */
  private applyClientModeShaping(
    body: Record<string, unknown>,
    account: ClaudeApiAccount,
    clientMode: ClaudeApiClientMode,
    forwardHeaders?: AnthropicForwardHeaders
  ): Record<string, string> {
    if (clientMode !== "claude-code-cli") {
      return {}
    }

    if (!isClaudeOAuthToken(account.apiKey)) {
      return {}
    }

    const model = typeof body.model === "string" ? body.model.toLowerCase() : ""
    const modelExempt = model.startsWith("claude-3-5-haiku")

    const result = applyCcCliCloaking(body, {
      apiKey: account.apiKey,
      enabled: true,
      modelExempt,
      entrypoint: deriveEntrypoint(forwardHeaders),
      workload: deriveWorkload(forwardHeaders),
      forwardHeaders,
    })
    if (result.passThrough) {
      this.logger.debug(
        "CC CLI cloaking: pass-through (request already looks like real Claude Code)"
      )
    }
    return result.oauthToolReverseMap
  }

  private normalizeClaudeTools(tools: unknown): unknown {
    if (!Array.isArray(tools)) {
      return tools
    }

    return tools.map((tool): unknown => {
      if (!tool || typeof tool !== "object") {
        return tool
      }

      const normalized = {
        ...(tool as Record<string, unknown>),
      }

      if (normalized.type === "function") {
        delete normalized.type
      }

      return normalized
    })
  }

  private normalizeClaudeToolChoice(toolChoice: unknown): unknown {
    if (!toolChoice || typeof toolChoice !== "object") {
      return toolChoice
    }

    const normalized = {
      ...(toolChoice as Record<string, unknown>),
    }

    if (normalized.type === "function") {
      normalized.type = "tool"
    }

    return normalized
  }

  private getAvailableCandidatesInAttemptOrder(
    candidates: ClaudeApiCandidate[]
  ): ClaudeApiCandidate[] {
    const now = Date.now()
    const availableByPriority = new Map<number, ClaudeApiCandidate[]>()

    for (const candidate of candidates) {
      if (
        isAccountDisabled(candidate.account) ||
        !isAccountAvailableForModel(
          candidate.account,
          candidate.upstreamModel,
          now
        )
      ) {
        continue
      }

      const list = availableByPriority.get(candidate.account.priority) || []
      list.push(candidate)
      availableByPriority.set(candidate.account.priority, list)
    }

    const priorities = Array.from(availableByPriority.keys()).sort(
      (left, right) => right - left
    )

    return priorities.flatMap((priority, index) => {
      const pool = availableByPriority.get(priority) || []
      if (pool.length <= 1) {
        return pool
      }

      const startIndex = index === 0 ? this.accountIndex % pool.length : 0
      return pool.slice(startIndex).concat(pool.slice(0, startIndex))
    })
  }

  private buildProxyAgent(
    account: ClaudeApiAccount
  ):
    | HttpProxyAgent<string>
    | HttpsProxyAgent<string>
    | SocksProxyAgent
    | undefined {
    const proxyUrl = account.proxyUrl
    if (!proxyUrl) return undefined

    try {
      const url = new URL(proxyUrl)
      switch (url.protocol) {
        case "http:":
          return new HttpProxyAgent(proxyUrl)
        case "https:":
          return new HttpsProxyAgent(proxyUrl)
        case "socks5:":
        case "socks5h:":
        case "socks4:":
          return new SocksProxyAgent(proxyUrl)
        default:
          this.logger.error(`Unsupported proxy scheme: ${url.protocol}`)
          return undefined
      }
    } catch (error) {
      this.logger.error(
        `Failed to parse proxy URL ${proxyUrl}: ${formatUnknownError(error)}`
      )
      return undefined
    }
  }

  private shouldDisableAccountPermanently(
    statusCode: number,
    detail: string
  ): boolean {
    if (statusCode === 401) {
      return true
    }

    if (statusCode !== 403) {
      return false
    }

    const normalized = detail.toLowerCase()
    return /invalid[_ -]?api[_ -]?key|provided api key|authentication|unauthorized|invalid[_ -]?x-api-key|credential/.test(
      normalized
    )
  }

  private buildErrorPreview(detail: string, maxLength: number = 200): string {
    return detail.length > maxLength ? detail.slice(0, maxLength) : detail
  }

  private disableAccountPermanently(
    account: ClaudeApiAccount,
    statusCode: number,
    detail: string
  ): void {
    disableAccount(account, "invalid_credentials", {
      statusCode,
      message: this.buildErrorPreview(detail, 500),
      accountLabel: account.label,
    })
    this.persistAccountStates()
  }

  private markAccountTemporaryFailure(
    account: ClaudeApiAccount,
    statusCode: number,
    model?: string,
    retryAfterHeader?: string
  ): void {
    if (isAccountDisabled(account)) {
      return
    }

    markAccountCooldown(
      account,
      statusCode,
      model,
      retryAfterHeader,
      account.label
    )
    this.persistAccountStates()
  }

  private markAccountHealthy(account: ClaudeApiAccount, model?: string): void {
    if (
      !isAccountDisabled(account) &&
      account.cooldownUntil <= 0 &&
      account.modelStates.size === 0
    ) {
      return
    }

    clearAccountDisablement(account)
    markAccountSuccess(account, model)
    this.persistAccountStates()
  }

  private buildHttpFailureError(
    account: ClaudeApiAccount,
    statusCode: number,
    detail: string,
    model?: string,
    retryAfterHeader?: string
  ): BackendApiError {
    const permanent = this.shouldDisableAccountPermanently(statusCode, detail)
    if (permanent) {
      this.disableAccountPermanently(account, statusCode, detail)
    } else {
      this.markAccountTemporaryFailure(
        account,
        statusCode,
        model,
        retryAfterHeader
      )
    }

    return new BackendApiError(
      `Claude API error ${statusCode}: ${this.buildErrorPreview(detail)}`,
      {
        backend: "claude-api",
        statusCode,
        permanent,
      }
    )
  }

  private buildTransientFailureError(
    account: ClaudeApiAccount,
    statusCode: number,
    message: string,
    model?: string
  ): BackendApiError {
    this.markAccountTemporaryFailure(account, statusCode, model)
    return new BackendApiError(message, {
      backend: "claude-api",
      statusCode,
    })
  }

  private async fetchWithResponseHeadersTimeout(
    url: string,
    options: RequestInit & { dispatcher?: unknown },
    timeoutMs: number,
    timeoutMessage: string,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    const requestSignal = createAbortSignalWithTimeout(timeoutMs, abortSignal)

    try {
      return await fetch(url, { ...options, signal: requestSignal.signal })
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new Error(timeoutMessage)
      }
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Claude API request aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      requestSignal.cleanup()
    }
  }

  private async readStreamChunkWithTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    timeoutMessage: string,
    abortSignal?: AbortSignal
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: NodeJS.Timeout | undefined
    const externalAbort = createAbortPromise(
      abortSignal,
      "Claude API stream aborted"
    )

    try {
      return await Promise.race([
        reader.read(),
        ...(externalAbort.promise ? [externalAbort.promise] : []),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
        }),
      ])
    } catch (error) {
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Claude API stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      externalAbort.cleanup()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  // ── ProviderAdapter Interface ────────────────────────────────────────

  /** No-op — HTTP-based Claude API doesn't need connection prewarming. */
  warmup(_hint: ProviderWarmupHint): void {
    // Intentionally empty — HTTP connections are established per-request.
  }

  /** No-op — Claude API is stateless per-request, no session resources to release. */
  dispose(_conversationId: string): void {
    // Intentionally empty.
  }
}
