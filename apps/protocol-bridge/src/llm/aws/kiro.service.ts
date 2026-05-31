/**
 * Kiro / AWS CodeWhisperer backend service.
 *
 * Implements the Claude-compatible streaming and non-streaming entry points
 * by translating the Anthropic Messages DTO into Kiro's
 * `generateAssistantResponse` payload, parsing the AWS binary Event Stream
 * response, and re-emitting Anthropic-compatible SSE events.
 *
 * Reference: https://github.com/Quorinex/Kiro-Go (proxy/kiro.go,
 * proxy/kiro_api.go, auth/oidc.go, pool/account.go).
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import { randomUUID } from "crypto"
import * as fs from "fs"
import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import * as os from "os"
import * as path from "path"
import { SocksProxyAgent } from "socks-proxy-agent"
import { PersistenceService } from "../../persistence"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"
import {
  detectCurrentKiroVersion,
  getAccountConfigPathCandidates,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"
import { UsageStatsService } from "../../usage"
import {
  clearAccountDisablement,
  isAccountAvailableForModel,
  isAccountDisabled,
  markAccountCooldown,
  markAccountSuccess,
  type CooldownableAccount,
} from "../shared/account-cooldown"
import {
  BackendAccountStateStore,
  type PersistedBackendAccountState,
} from "../shared/backend-account-state-store"
import {
  RETRY_POLICY,
  type BackendErrorClass,
} from "../shared/backend-error-class"
import {
  BackendAccountPoolUnavailableError,
  BackendApiError,
} from "../shared/backend-errors"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
} from "../shared/backend-pool-status"
import { canPublicClaudeModelUseKiro } from "../shared/model-registry"
import { resolveThinkingIntentFromDto } from "../shared/thinking-intent"
import type {
  ThinkingIntent,
  ThinkingIntentEffort,
} from "../shared/thinking-types"
import {
  pollKiroBuilderIdDeviceFlow,
  startKiroBuilderIdDeviceFlow,
  type KiroDeviceAuthSession,
  type KiroDevicePollResult,
} from "./builderid-device-flow"
import {
  KiroPromptCacheTracker,
  billedKiroInputTokens,
  type KiroPromptCacheUsage,
} from "./cache-tracker"
import { parseKiroEventStream } from "./event-stream"
import {
  buildKiroBaseHeaders,
  buildStreamingHeaderValues,
  type KiroClientConfig,
} from "./headers"
import {
  writeKiroCliLogin,
  writeKiroIdeLogin,
  type KiroIdeExportInput,
} from "./local-export"
import {
  discoverLocalKiroTokens,
  type DiscoveredKiroToken,
} from "./local-import"
import { refreshKiroToken, type KiroAuthMethod } from "./oidc"
import type { KiroAdditionalModelRequestFields } from "./protocol-types"
import {
  KIRO_ENDPOINTS,
  type KiroEndpoint,
  type KiroPayload,
  type KiroStreamCallback,
  type KiroToolUse,
} from "./protocol-types"
import {
  getKiroUsageLimits,
  listAvailableProfileArn,
  listKiroAvailableModels,
  type KiroModelInfo,
} from "./rest-api"
import { claudeToKiro, mapKiroModel } from "./translator"

interface KiroAccount extends CooldownableAccount {
  label?: string
  source: "env" | "file"
  stateKey: string
  authMethod: KiroAuthMethod
  provider?: string
  region: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId?: string
  clientSecret?: string
  registrationExpiresAt?: number
  machineId: string
  profileArn?: string
  proxyUrl?: string
  maxContextTokens?: number
  priority: number
  preferredEndpoint: "auto" | "kiro" | "codewhisperer"
  endpointFallback: boolean
  client?: Partial<KiroClientConfig>
  /** Kiro API Key (headless mode) — when set, used directly as Bearer token. */
  kiroApiKey?: string
  /** Promise guard so concurrent refreshes share one HTTP call. */
  refreshPromise?: Promise<void>
  /** Runtime-only endpoint cooldowns, keyed by model + endpoint. */
  endpointStates: Map<string, KiroEndpointCooldownState>
}

interface KiroEndpointCooldownState {
  cooldownUntil: number
  quotaExhausted: boolean
  backoffLevel: number
}

function mergeKiroClientConfig(
  entry: KiroAccountFileEntry
): Partial<KiroClientConfig> {
  return {
    kiroVersion: entry.kiroVersion || detectCurrentKiroVersion() || undefined,
    systemVersion: entry.systemVersion,
    nodeVersion: entry.nodeVersion,
  }
}

interface KiroAccountFileEntry {
  label?: string
  authMethod?: string
  region?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  clientId?: string
  clientSecret?: string
  registrationExpiresAt?: number
  machineId?: string
  profileArn?: string
  provider?: string
  proxyUrl?: string
  maxContextTokens?: number
  priority?: number
  preferredEndpoint?: string
  endpointFallback?: boolean
  kiroVersion?: string
  systemVersion?: string
  nodeVersion?: string
  /** Kiro API Key (headless mode, format: ksk_xxxxxxxx) */
  kiroApiKey?: string
}

interface KiroAccountConfigFile {
  accounts?: KiroAccountFileEntry[]
}

type KiroLocalLoginKind = "ide" | "cli"

interface KiroLocalLoginTarget {
  authMethod: KiroAuthMethod
  region: string
  stateKey?: string
  clientId?: string
  label?: string
  updatedAt?: string
}

interface KiroLocalLoginTargetsFile {
  ide?: KiroLocalLoginTarget
  cli?: KiroLocalLoginTarget
}

type PersistedKiroAccountState = PersistedBackendAccountState

export interface KiroQuotaSnapshot {
  label: string
  state: "ready" | "disabled" | "error"
  email: string | null
  subscriptionType: string | null
  usageCurrent: number | null
  usageLimit: number | null
  usagePercent: number | null
  nextResetDate: string | null
  currentOverages: number | null
  overageCharges: number | null
  overageRate: number | null
  overageCap: number | null
  error: string | null
}

const TOKEN_REFRESH_SKEW_SECONDS = 120
const STREAM_REQUEST_TIMEOUT_MS = 5 * 60_000
const ENDPOINT_QUOTA_BACKOFF_BASE_MS = 30_000
const ENDPOINT_QUOTA_BACKOFF_MAX_MS = 15 * 60_000

/** Fallback model IDs used when dynamic discovery has not yet completed. */
const FALLBACK_KIRO_MODEL_IDS: string[] = [
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-haiku-4-5",
]

@Injectable()
export class KiroService implements OnModuleInit {
  private readonly logger = new Logger(KiroService.name)
  private accounts: KiroAccount[] = []
  private accountIndex = 0
  private accountsConfigPath: string | null = null
  private accountStateStore: BackendAccountStateStore
  private readonly cacheTracker = new KiroPromptCacheTracker()
  /**
   * Active Builder ID device-auth sessions, keyed by sessionId.  Sessions are
   * created by `startBuilderIdLogin()` and consumed by `pollBuilderIdLogin()`.
   * They are evicted automatically once their device code expires.
   */
  private readonly deviceAuthSessions = new Map<string, KiroDeviceAuthSession>()
  /** Dynamically discovered models from the Kiro API. */
  private discoveredModels: KiroModelInfo[] = []
  private discoveredModelsFetchedAt = 0

  constructor(
    private readonly configService: ConfigService,
    private readonly persistence: PersistenceService,
    private readonly usageStats: UsageStatsService
  ) {
    this.accountStateStore = new BackendAccountStateStore(
      this.persistence,
      this.logger
    )
  }

  async onModuleInit(): Promise<void> {
    this.accounts = this.loadAllAccountsFromFile()

    const persistedStates = this.accountStateStore.loadStates("kiro")
    for (const account of this.accounts) {
      this.applyPersistedAccountState(
        account,
        persistedStates.get(account.stateKey)
      )
    }
    this.persistAccountStates()
    // Yield once so OnModuleInit is genuinely async; this lets concurrent
    // bootstrap tasks (DB warmup, account discovery in other backends) run.
    await Promise.resolve()

    this.logger.log(
      `Kiro backend initialized: ${this.accounts.length} account(s)`
    )
    // Deduplicate labels so logs and dashboard can distinguish accounts.
    this.deduplicateAccountLabels()
    for (const account of this.accounts) {
      const stateSummary = isAccountDisabled(account)
        ? `disabled (${account.disabledReason || "permanent"})`
        : account.cooldownUntil > 0 || account.modelStates.size > 0
          ? "cooldown"
          : "ready"
      this.logger.log(
        `  -> ${account.label || "unnamed"} [${account.source}]: authMethod=${account.authMethod}, region=${account.region}, state=${stateSummary}`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.log(
        "No Kiro credentials configured. Add entries to data/kiro-accounts.json to enable."
      )
    }

    // Startup probe: verify token freshness + profileArn for each account.
    for (const account of this.accounts) {
      if (isAccountDisabled(account)) continue
      try {
        await this.ensureFreshToken(account)
        await this.ensureProfileArn(account)
        this.mirrorLocalLoginsIfSelected(account)
        this.logger.log(
          `  [Kiro] Startup probe OK: ${account.label || account.stateKey.slice(0, 12)} ` +
            `(token expires=${account.expiresAt ? new Date(account.expiresAt * 1000).toISOString() : "unknown"}, ` +
            `profileArn=${account.profileArn ? "resolved" : "pending"})`
        )
        // Discover available models from the first healthy account.
        if (this.discoveredModels.length === 0) {
          await this.refreshDiscoveredModels(account)
        }
      } catch (error) {
        this.logger.warn(
          `  [Kiro] Startup probe FAILED for ${account.label || account.stateKey.slice(0, 12)}: ${(error as Error).message}`
        )
      }
    }

    // Start background token refresh loop (every 15 minutes).
    this.startBackgroundRefresh()

    // Startup warmup: prime the upstream Bedrock model instance with a tiny
    // generateAssistantResponse so the first user request does not pay the
    // cold-start tax (observed ~20s first_semantic_event_ms vs ~5s warm).
    // On by default — set KIRO_WARMUP_ON_START=0 to opt out (e.g. for tight
    // quota environments where the startup probe is already enough).
    void this.maybeRunStartupWarmup()
  }

  /**
   * Best-effort startup warmup. Sends a minimal `generateAssistantResponse`
   * request per ready account so Bedrock can warm the model instance + KV
   * cache before the first real user turn arrives.
   *
   * On by default; set `KIRO_WARMUP_ON_START` to a falsy value
   * (0/false/no/off) to opt out. Failures are swallowed — warmup is purely
   * an optimization and must never block module init.
   */
  private async maybeRunStartupWarmup(): Promise<void> {
    const flag = (process.env.KIRO_WARMUP_ON_START || "").trim().toLowerCase()
    if (flag === "0" || flag === "false" || flag === "no" || flag === "off") {
      return
    }
    if (this.accounts.length === 0) return

    // Pick the warmup model: prefer the first discovered model, otherwise the
    // first fallback. Using a single dominant model keeps quota impact bounded
    // while still priming the most common path.
    const warmupModel =
      this.discoveredModels[0]?.modelId ||
      FALLBACK_KIRO_MODEL_IDS[0] ||
      "claude-opus-4.7"

    // Limit warmup parallelism to one account at a time so a configuration
    // mistake (e.g. all 5 accounts down) cannot stampede.
    for (const account of this.accounts) {
      if (isAccountDisabled(account)) continue
      try {
        await this.warmupAccount(account, warmupModel)
      } catch (error) {
        this.logger.debug?.(
          `[Kiro][Warmup] account=${this.accountTag(account)} model=${warmupModel} skipped: ${(error as Error).message}`
        )
      }
    }
  }

  private async warmupAccount(
    account: KiroAccount,
    model: string
  ): Promise<void> {
    if (!this.supportsModel(model)) return
    if (!this.hasAvailableEndpointForModel(account, model, Date.now())) return

    const startedAt = Date.now()
    // Minimal DTO: no system, no tools, no thinking. The goal is purely to
    // make the upstream allocate / warm the model instance. We cap output to
    // a tiny number of tokens; Bedrock will still complete quickly.
    const dto: CreateMessageDto = {
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 8,
      stream: true,
    } as unknown as CreateMessageDto

    let firstEventAt = 0
    const callback: KiroStreamCallback = {
      onText: () => {
        if (firstEventAt === 0) firstEventAt = Date.now()
      },
      onComplete: () => {
        if (firstEventAt === 0) firstEventAt = Date.now()
      },
      onError: () => {
        if (firstEventAt === 0) firstEventAt = Date.now()
      },
    }

    // Hard cap warmup to 20s so a slow upstream cannot stall the queue.
    const abort = AbortSignal.timeout(20_000)
    await this.callKiro(dto, account, callback, abort)
    const totalMs = Date.now() - startedAt
    const ttfbMs = firstEventAt > 0 ? firstEventAt - startedAt : -1
    this.logger.log(
      `[Kiro][Warmup] account=${this.accountTag(account)} model=${model} ` +
        `total=${totalMs}ms ttfb=${ttfbMs >= 0 ? `${ttfbMs}ms` : "n/a"}`
    )
  }

  isAvailable(): boolean {
    return this.accounts.some((account) => !isAccountDisabled(account))
  }

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  supportsModel(model: string): boolean {
    if (!this.isAvailable()) return false
    // Check dynamic model list first. Cursor-facing Claude aliases use
    // hyphenated / thinking model IDs, while Kiro discovery reports dotted
    // backend IDs such as "claude-opus-4.7".
    if (this.discoveredModels.length > 0) {
      if (this.findDiscoveredModel(model)) {
        return true
      }
    }
    // Fallback to static Claude model check.
    return canPublicClaudeModelUseKiro(model)
  }

  /**
   * Estimate the JSON request-body size (in UTF-8 bytes) that this DTO
   * will occupy on the wire AFTER translation into Kiro's
   * `conversationState` shape.
   *
   * This must be measured on the *translated* payload, not the raw
   * Anthropic DTO: the Anthropic shape carries the full tool-definition
   * array (71 CC CLI tools × full JSON schema), structured content
   * blocks, and a system-prompt array — all of which `claudeToKiro`
   * either collapses (content blocks → plain strings), drops, or moves.
   * Measured in production: a request whose Anthropic DTO serializes to
   * ~4.14 MB translates to a ~1.54 MB Kiro payload. Gating on the raw
   * DTO size (the previous behaviour) false-rejected requests that the
   * Kiro gateway would have accepted.
   *
   * profileArn is irrelevant to size (a short ARN string), so we pass a
   * representative account or omit it — the byte count is dominated by
   * message/tool content either way.
   */
  estimateWireBytes(dto: CreateMessageDto): number {
    const account = this.accounts.find((a) => !isAccountDisabled(a))
    try {
      const payload = this.buildKiroPayload(
        dto,
        account ?? ({ profileArn: undefined } as unknown as KiroAccount)
      )
      return Buffer.byteLength(JSON.stringify(payload), "utf-8")
    } catch {
      // Translation failed (malformed DTO). Fall back to the raw DTO
      // size so the gate still has a non-zero signal rather than
      // silently waving an unbounded request through.
      try {
        return Buffer.byteLength(JSON.stringify(dto), "utf-8")
      } catch {
        return 0
      }
    }
  }

  getConfiguredMaxContextTokens(model: string): number | undefined {
    if (!this.supportsModel(model)) return undefined
    // Check discovered model token limits first. This must use the same alias
    // mapping as supportsModel(); otherwise Cursor IDs like
    // "claude-opus-4-7-thinking" miss Kiro's "claude-opus-4.7" metadata and
    // incorrectly fall back to the generic Claude cap.
    const discovered = this.findDiscoveredModel(model)
    if (discovered?.tokenLimits?.maxInputTokens) {
      return discovered.tokenLimits.maxInputTokens
    }
    let resolved: number | undefined
    for (const account of this.accounts) {
      if (isAccountDisabled(account)) continue
      const limit = account.maxContextTokens
      if (typeof limit !== "number" || limit <= 0) continue
      resolved = resolved === undefined ? limit : Math.min(resolved, limit)
    }
    return resolved
  }

  private findDiscoveredModel(model: string): KiroModelInfo | undefined {
    const normalizedModel = model.toLowerCase().trim()
    const mappedModel = mapKiroModel(normalizedModel).toLowerCase()
    return this.discoveredModels.find((m) => {
      const discoveredId = m.modelId.toLowerCase()
      return discoveredId === normalizedModel || discoveredId === mappedModel
    })
  }

  getPublicModelIds(): string[] {
    if (this.discoveredModels.length > 0) {
      return this.discoveredModels
        .filter((m) => m.modelId !== "auto")
        .map((m) => m.modelId)
    }
    return [...FALLBACK_KIRO_MODEL_IDS]
  }

  getDiscoveredModels(): KiroModelInfo[] {
    if (this.discoveredModels.length > 0) {
      return this.discoveredModels
    }
    // Fallback: return static model entries so Cursor still shows them
    // even when dynamic discovery failed (e.g. token expired).
    if (!this.isAvailable()) return []
    return FALLBACK_KIRO_MODEL_IDS.map((id) => ({
      modelId: id,
      modelName: id
        .replace(/^claude-/, "Claude ")
        .replace(/-/g, " ")
        .replace(/(\d)/, " $1")
        .trim(),
    }))
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.accounts.map((account) => {
      const modelCooldowns = Array.from(account.modelStates.entries())
        .filter(([, state]) => state.cooldownUntil > now)
        .map(([model, state]) => ({
          model,
          cooldownUntil: state.cooldownUntil,
          quotaExhausted: state.quotaExhausted,
          backoffLevel: state.backoffLevel,
        }))
        .sort((left, right) => left.cooldownUntil - right.cooldownUntil)
      const endpointCooldowns = Array.from(account.endpointStates.entries())
        .filter(([, state]) => state.cooldownUntil > now)
        .map(([key, state]) => {
          const [model = "", endpoint = ""] = key.split("\0")
          return {
            model,
            endpoint,
            cooldownUntil: state.cooldownUntil,
            quotaExhausted: state.quotaExhausted,
            backoffLevel: state.backoffLevel,
          }
        })
        .sort((left, right) => left.cooldownUntil - right.cooldownUntil)

      let state: BackendPoolEntryState = "ready"
      if (isAccountDisabled(account)) state = "disabled"
      else if (account.cooldownUntil > now) state = "cooldown"
      else if (modelCooldowns.length > 0) state = "model_cooldown"
      else if (endpointCooldowns.length > 0) state = "degraded"

      return {
        id: account.stateKey,
        label: account.label || account.stateKey.slice(0, 12),
        state: state as BackendPoolEntryState,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: KIRO_ENDPOINTS[0]!.url,
        proxyUrl: account.proxyUrl,
        maxContextTokens: account.maxContextTokens,
        priority: account.priority,
        modelCooldowns,
        endpointCooldowns,
      }
    })

    return {
      backend: "kiro",
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

  // ── Public entry points ─────────────────────────────────────────────────

  async sendClaudeMessage(dto: CreateMessageDto): Promise<AnthropicResponse> {
    const account = this.pickAccountOrThrow(
      this.resolveCooldownModel(dto.model)
    )
    return this.executeNonStream(dto, account)
  }

  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const account = this.pickAccountOrThrow(
      this.resolveCooldownModel(dto.model)
    )
    yield* this.executeStream(dto, account, abortSignal)
  }

  // ── One-click sync from local Kiro / AWS SSO cache ──────────────────────

  /**
   * Discover Kiro credentials cached locally (by Kiro IDE or AWS CLI / SSO)
   * and merge them into `kiro-accounts.json`.  Returns a summary describing
   * how many accounts were imported plus the destination path so the
   * dashboard can display it.
   */
  async syncFromLocalCaches(): Promise<{
    synced: boolean
    imported: number
    skipped: number
    accountCount: number
    path: string
    sources: string[]
  }> {
    const tokens = discoverLocalKiroTokens()
    const path = this.getAccountsFilePath()

    if (tokens.length === 0) {
      return {
        synced: false,
        imported: 0,
        skipped: 0,
        accountCount: this.readAccountsFile().length,
        path,
        sources: [],
      }
    }

    let imported = 0
    let skipped = 0
    const sources: string[] = []

    for (const token of tokens) {
      const ok = await this.upsertAccountFromDiscovered(token)
      if (ok) {
        imported += 1
        sources.push(token.sourcePath)
      } else {
        skipped += 1
      }
    }

    // Reload in-memory accounts so the next request sees the new state.
    this.reloadAccounts()

    return {
      synced: imported > 0,
      imported,
      skipped,
      accountCount: this.accounts.length,
      path,
      sources,
    }
  }

  // ── Builder ID one-click login (OAuth device flow) ──────────────────────

  /**
   * Start an AWS Builder ID device authorization session.  The dashboard
   * should immediately open the returned `verificationUriComplete` in the
   * user's browser, then poll `pollBuilderIdLogin()` until completion.
   */
  async startBuilderIdLogin(options?: {
    region?: string
    proxyUrl?: string
  }): Promise<{
    sessionId: string
    verificationUri: string
    verificationUriComplete: string
    userCode: string
    intervalMs: number
    expiresAt: number
  }> {
    this.evictExpiredDeviceSessions()

    const session = await startKiroBuilderIdDeviceFlow({
      region: options?.region,
      proxyUrl: options?.proxyUrl,
    })
    this.deviceAuthSessions.set(session.sessionId, session)
    this.logger.log(
      `[Kiro] Builder ID device flow started (session=${session.sessionId.slice(0, 8)}, userCode=${session.userCode})`
    )

    return {
      sessionId: session.sessionId,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      userCode: session.userCode,
      intervalMs: session.intervalMs,
      expiresAt: session.expiresAt,
    }
  }

  /**
   * Poll the OIDC token endpoint for the given session.  Returns a
   * `pending`/`slow_down` status while the user has not yet approved, or
   * `completed` once the token is issued (and persisted).
   */
  async pollBuilderIdLogin(
    sessionId: string,
    options?: { proxyUrl?: string }
  ): Promise<
    | { status: "pending"; intervalMs: number }
    | { status: "slow_down"; intervalMs: number }
    | { status: "completed"; accountCount: number; path: string }
    | { status: "expired" }
  > {
    this.evictExpiredDeviceSessions()
    const session = this.deviceAuthSessions.get(sessionId)
    if (!session) {
      return { status: "expired" }
    }

    let result: KiroDevicePollResult
    try {
      result = await pollKiroBuilderIdDeviceFlow(session, options?.proxyUrl)
    } catch (error) {
      this.deviceAuthSessions.delete(sessionId)
      throw error
    }

    if (result.status === "pending") {
      return { status: "pending", intervalMs: session.intervalMs }
    }
    if (result.status === "slow_down") {
      session.intervalMs = Math.min(60_000, session.intervalMs + 5_000)
      return { status: "slow_down", intervalMs: session.intervalMs }
    }

    // Success — persist, then evict the session.
    this.deviceAuthSessions.delete(sessionId)
    const path = this.getAccountsFilePath()
    this.upsertAccountFromBuilderId(result, session)
    this.reloadAccounts()
    return {
      status: "completed",
      accountCount: this.accounts.length,
      path,
    }
  }

  /**
   * Cancel an active device flow.  Idempotent.
   */
  cancelBuilderIdLogin(sessionId: string): boolean {
    return this.deviceAuthSessions.delete(sessionId)
  }

  // ── Force-login an existing pool account into local Kiro IDE ─────────

  private async prepareKiroLocalLogin(
    identity: {
      authMethod?: string
      region?: string
      refreshToken?: string
      accessToken?: string
      clientId?: string
      kiroApiKey?: string
      label?: string
    },
    targetName = "Kiro IDE"
  ): Promise<
    | {
        success: true
        label: string
        exportInput: KiroIdeExportInput
        account: KiroAccount
      }
    | {
        success: false
        label: string
        error: string
      }
  > {
    const account = this.findInMemoryAccount(identity)
    const label =
      account?.label || identity.label || identity.region || "Kiro account"

    if (!account) {
      return {
        success: false,
        label,
        error: "Matching Kiro account not found in the pool",
      }
    }

    if (account.authMethod === "api_key") {
      return {
        success: false,
        label,
        error: `API-key accounts cannot be pushed to the ${targetName} login (no OAuth token pair)`,
      }
    }

    await this.ensureFreshToken(account, { force: true })
    await this.ensureProfileArn(account)

    return {
      success: true,
      label,
      exportInput: {
        authMethod: account.authMethod === "social" ? "social" : "idc",
        region: account.region,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
        profileArn: account.profileArn,
        provider: account.provider,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        registrationExpiresAt: account.registrationExpiresAt,
      },
      account,
    }
  }

  /**
   * Push an existing pool account's credentials into the local Kiro IDE login
   * cache (`~/.aws/sso/cache/kiro-auth-token.json`, plus the client
   * registration file for IdC accounts) so the desktop Kiro IDE signs in as
   * that account. This is the Kiro analogue of activating a Codex CLI account.
   *
   * The token is refreshed first (and profileArn resolved) so the IDE receives
   * a live access token rather than a possibly-expired one. API-key accounts
   * cannot be force-logged-in because the IDE login cache requires an
   * OAuth-style access/refresh token pair.
   */
  async forceLoginToKiroIde(identity: {
    authMethod?: string
    region?: string
    refreshToken?: string
    accessToken?: string
    clientId?: string
    kiroApiKey?: string
    label?: string
  }): Promise<{
    success: boolean
    label: string
    tokenPath?: string
    registrationPath?: string
    profilePath?: string
    error?: string
  }> {
    try {
      const prepared = await this.prepareKiroLocalLogin(identity)
      if (!prepared.success) return prepared

      const result = writeKiroIdeLogin(prepared.exportInput)
      this.rememberLocalLoginTarget("ide", prepared.account)

      this.logger.log(
        `[Kiro] Force-logged ${prepared.label} into local Kiro IDE (${result.tokenPath})`
      )
      return {
        success: true,
        label: prepared.label,
        tokenPath: result.tokenPath,
        registrationPath: result.registrationPath,
        profilePath: result.profilePath,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const label = identity.label || identity.region || "Kiro account"
      this.logger.warn(`[Kiro] IDE force-login failed for ${label}: ${message}`)
      return { success: false, label, error: message }
    }
  }

  /**
   * Push an existing pool account's credentials into the local Kiro CLI login
   * database. Kiro CLI currently accepts these pool credentials via its
   * `kirocli:social:token` entry; writing the IdC-shaped CLI token makes
   * `whoami` pass but chat fails with an invalid bearer token.
   */
  async forceLoginToKiroCli(identity: {
    authMethod?: string
    region?: string
    refreshToken?: string
    accessToken?: string
    clientId?: string
    kiroApiKey?: string
    label?: string
  }): Promise<{
    success: boolean
    label: string
    dbPath?: string
    tokenPath?: string
    error?: string
  }> {
    try {
      const prepared = await this.prepareKiroLocalLogin(identity, "Kiro CLI")
      if (!prepared.success) return prepared

      const result = writeKiroCliLogin(prepared.exportInput)
      this.rememberLocalLoginTarget("cli", prepared.account)

      this.logger.log(
        `[Kiro] Force-logged ${prepared.label} into local Kiro CLI (${result.dbPath}, ${result.tokenPath})`
      )
      return {
        success: true,
        label: prepared.label,
        dbPath: result.dbPath,
        tokenPath: result.tokenPath,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const label = identity.label || identity.region || "Kiro account"
      this.logger.warn(`[Kiro] CLI force-login failed for ${label}: ${message}`)
      return { success: false, label, error: message }
    }
  }

  /**
   * Locate an in-memory account by the same stable identity the dashboard and
   * `findMatchingEntryIndex` use (authMethod + region, then refresh/access
   * token, or clientId for IdC; api_key matches on the key itself).
   */
  private findInMemoryAccount(identity: {
    authMethod?: string
    region?: string
    refreshToken?: string
    accessToken?: string
    clientId?: string
    kiroApiKey?: string
  }): KiroAccount | undefined {
    const norm = (value: unknown): string =>
      typeof value === "string" ? value.trim() : ""
    const normRegion = (value: unknown): string => norm(value) || "us-east-1"
    const wantAuth: KiroAuthMethod =
      identity.authMethod === "api_key" || identity.authMethod === "apikey"
        ? "api_key"
        : identity.authMethod === "social"
          ? "social"
          : "idc"
    const wantRegion = normRegion(identity.region)
    const wantRefresh = norm(identity.refreshToken)
    const wantAccess = norm(identity.accessToken)
    const wantClient = norm(identity.clientId)
    const wantApiKey = norm(identity.kiroApiKey)

    return this.accounts.find((account) => {
      if (account.authMethod !== wantAuth) return false
      if (normRegion(account.region) !== wantRegion) return false
      if (wantAuth === "api_key") {
        return wantApiKey !== "" && wantApiKey === norm(account.kiroApiKey)
      }
      if (
        wantRefresh &&
        norm(account.refreshToken) &&
        wantRefresh === norm(account.refreshToken)
      ) {
        return true
      }
      if (
        wantAccess &&
        norm(account.accessToken) &&
        wantAccess === norm(account.accessToken)
      ) {
        return true
      }
      if (wantAuth !== "idc") return false
      return wantClient !== "" && wantClient === norm(account.clientId)
    })
  }

  // ── Quota / usage info ──────────────────────────────────────────────────

  /**
   * Fetch usage/subscription info for all active Kiro accounts.
   * Returns a snapshot array suitable for the dashboard quota panel.
   */
  async getQuotaSnapshots(): Promise<KiroQuotaSnapshot[]> {
    const results: KiroQuotaSnapshot[] = []
    for (const account of this.accounts) {
      if (isAccountDisabled(account)) {
        results.push({
          label: account.label || account.stateKey.slice(0, 12),
          state: "disabled",
          email: null,
          subscriptionType: null,
          usageCurrent: null,
          usageLimit: null,
          usagePercent: null,
          nextResetDate: null,
          currentOverages: null,
          overageCharges: null,
          overageRate: null,
          overageCap: null,
          error: account.disabledReason || "disabled",
        })
        continue
      }
      try {
        await this.ensureFreshToken(account)
        await this.ensureProfileArn(account)
        const usage = await getKiroUsageLimits({
          accessToken: account.accessToken,
          machineId: account.machineId,
          proxyUrl: account.proxyUrl,
          client: account.client,
          profileArn: account.profileArn,
          tokenType: account.authMethod === "api_key" ? "API_KEY" : undefined,
        })
        const breakdown = usage.usageBreakdownList?.[0]
        const current = breakdown?.currentUsage ?? 0
        const limit = breakdown?.usageLimit ?? 0
        const percent = limit > 0 ? Math.round((current / limit) * 100) : null
        const subType = parseSubscriptionType(
          usage.subscriptionInfo?.subscriptionTitle ||
            usage.subscriptionInfo?.subscriptionName ||
            usage.subscriptionInfo?.subscriptionType ||
            ""
        )
        const email = usage.userInfo?.email || null
        let nextReset: string | null = null
        if (usage.nextDateReset) {
          const ts =
            typeof usage.nextDateReset === "number"
              ? usage.nextDateReset
              : Number.parseFloat(String(usage.nextDateReset))
          if (Number.isFinite(ts) && ts > 0) {
            nextReset = new Date(ts > 1e12 ? ts : ts * 1000).toISOString()
          }
        }
        results.push({
          label: account.label || email || account.stateKey.slice(0, 12),
          state: "ready",
          email,
          subscriptionType: subType,
          usageCurrent: current,
          usageLimit: limit,
          usagePercent: percent,
          nextResetDate: nextReset,
          currentOverages:
            typeof breakdown?.currentOveragesWithPrecision === "number"
              ? breakdown.currentOveragesWithPrecision
              : typeof breakdown?.currentOverages === "number"
                ? breakdown.currentOverages
                : null,
          overageCharges:
            typeof breakdown?.overageCharges === "number"
              ? breakdown.overageCharges
              : null,
          overageRate:
            typeof breakdown?.overageRate === "number"
              ? breakdown.overageRate
              : null,
          overageCap:
            typeof breakdown?.overageCap === "number"
              ? breakdown.overageCap
              : null,
          error: null,
        })
      } catch (error) {
        results.push({
          label: account.label || account.stateKey.slice(0, 12),
          state: "error",
          email: null,
          subscriptionType: null,
          usageCurrent: null,
          usageLimit: null,
          usagePercent: null,
          nextResetDate: null,
          currentOverages: null,
          overageCharges: null,
          overageRate: null,
          overageCap: null,
          error: (error as Error).message || "unknown error",
        })
      }
    }
    return results
  }

  // ── Manual paste fallback ───────────────────────────────────────────────

  /**
   * Parse a raw JSON paste (Kiro IDE export, AWS SSO cache file, or our own
   * `kiro-accounts.json` shape) and import any usable token entries.
   */
  importFromRawJson(raw: string): {
    imported: number
    skipped: number
    accountCount: number
    path: string
  } {
    const trimmed = (raw || "").trim()
    if (!trimmed) {
      return {
        imported: 0,
        skipped: 0,
        accountCount: this.accounts.length,
        path: this.getAccountsFilePath(),
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error("Provided text is not valid JSON")
    }

    const candidates = this.flattenManualPayload(parsed)
    let imported = 0
    let skipped = 0

    for (const candidate of candidates) {
      if (this.upsertAccountFromManualEntry(candidate)) {
        imported += 1
      } else {
        skipped += 1
      }
    }

    this.reloadAccounts()
    return {
      imported,
      skipped,
      accountCount: this.accounts.length,
      path: this.getAccountsFilePath(),
    }
  }

  // ── Account loading ─────────────────────────────────────────────────────

  private loadAllAccountsFromFile(): KiroAccount[] {
    const candidates = getAccountConfigPathCandidates("kiro-accounts.json")
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue
      try {
        const content = fs.readFileSync(candidate, "utf-8")
        const data = JSON.parse(content) as KiroAccountConfigFile
        if (!data.accounts || !Array.isArray(data.accounts)) {
          continue
        }
        this.accountsConfigPath = candidate
        const records: KiroAccount[] = []
        for (const entry of data.accounts) {
          const built = this.buildAccountRecord(entry, "file")
          if (built) records.push(built)
        }
        if (records.length > 0) {
          this.logger.log(
            `Loaded ${records.length} Kiro account(s) from ${candidate}`
          )
        }
        return records
      } catch (error) {
        this.logger.warn(
          `Failed to load Kiro accounts from ${candidate}: ${(error as Error).message}`
        )
      }
    }
    return []
  }

  private buildAccountRecord(
    entry: KiroAccountFileEntry,
    source: "env" | "file"
  ): KiroAccount | null {
    const accessToken = (entry.accessToken || "").trim()
    const refreshToken = (entry.refreshToken || "").trim()
    const kiroApiKey = (entry.kiroApiKey || "").trim()

    // API Key mode: only needs kiroApiKey, no accessToken/refreshToken required.
    const isApiKey =
      entry.authMethod === "api_key" ||
      entry.authMethod === "apikey" ||
      (kiroApiKey && !refreshToken && !accessToken)

    if (!isApiKey && !accessToken && !refreshToken) {
      this.logger.warn(
        `Skipping Kiro account "${entry.label || "(unnamed)"}": both accessToken and refreshToken are empty`
      )
      return null
    }
    if (isApiKey && !kiroApiKey) {
      this.logger.warn(
        `Skipping Kiro account "${entry.label || "(unnamed)"}": authMethod=api_key but kiroApiKey is empty`
      )
      return null
    }

    const authMethod: KiroAuthMethod = isApiKey
      ? "api_key"
      : entry.authMethod === "social"
        ? "social"
        : "idc"

    if (authMethod === "idc" && (!entry.clientId || !entry.clientSecret)) {
      this.logger.warn(
        `Kiro account "${entry.label}": IdC auth needs clientId and clientSecret; refresh will fail.`
      )
    }

    // For API Key accounts, use the key itself as the stable identity for stateKey.
    const stateKeyInput =
      authMethod === "api_key" ? kiroApiKey : refreshToken || accessToken

    const stateKey = crypto
      .createHash("sha256")
      .update(authMethod)
      .update("\0")
      .update(entry.region || "")
      .update("\0")
      .update(entry.clientId || "")
      .update("\0")
      .update(stateKeyInput)
      .digest("hex")

    return {
      label: entry.label,
      source,
      stateKey,
      authMethod,
      provider: entry.provider?.trim() || undefined,
      region: (entry.region || "us-east-1").trim() || "us-east-1",
      // For API Key accounts, use the key as the access token directly.
      accessToken: authMethod === "api_key" ? kiroApiKey : accessToken,
      refreshToken,
      expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : 0,
      clientId:
        authMethod === "idc" ? entry.clientId?.trim() || undefined : undefined,
      clientSecret:
        authMethod === "idc"
          ? entry.clientSecret?.trim() || undefined
          : undefined,
      registrationExpiresAt:
        typeof entry.registrationExpiresAt === "number"
          ? entry.registrationExpiresAt
          : undefined,
      machineId:
        (entry.machineId || "").trim() ||
        crypto.createHash("md5").update(stateKey).digest("hex"),
      profileArn: entry.profileArn?.trim() || undefined,
      proxyUrl: entry.proxyUrl?.trim() || undefined,
      maxContextTokens:
        typeof entry.maxContextTokens === "number" && entry.maxContextTokens > 0
          ? Math.floor(entry.maxContextTokens)
          : undefined,
      priority:
        typeof entry.priority === "number" && Number.isFinite(entry.priority)
          ? entry.priority
          : 0,
      preferredEndpoint:
        entry.preferredEndpoint === "kiro" ||
        entry.preferredEndpoint === "codewhisperer"
          ? entry.preferredEndpoint
          : "auto",
      endpointFallback: entry.endpointFallback !== false,
      client: mergeKiroClientConfig(entry),
      kiroApiKey: authMethod === "api_key" ? kiroApiKey : undefined,
      cooldownUntil: 0,
      modelStates: new Map(),
      endpointStates: new Map(),
    }
  }

  // ── Account selection ──────────────────────────────────────────────────

  private resolveCooldownModel(model: string | undefined): string {
    return mapKiroModel(model || "")
  }

  /**
   * Whether to bail out of `callKiro`'s in-loop backoff when no alternate
   * account is available, so the caller's model router can pick a
   * different backend (claude-api / google-claude) instead of waiting for
   * a Kiro cooldown to expire. Default off to preserve existing behavior;
   * set `KIRO_FAST_FAIL_ON_NO_ALTERNATE=1` to opt in.
   */
  private shouldFastFailOnNoAlternate(): boolean {
    const raw = (process.env.KIRO_FAST_FAIL_ON_NO_ALTERNATE || "")
      .trim()
      .toLowerCase()
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
  }

  /**
   * Render a stable, human-friendly identifier for log lines: prefer the
   * `(label) [stateKeyShort]` form so two accounts that share a label
   * (e.g. two Google social logins) are still distinguishable in the log.
   */
  private accountTag(account: KiroAccount): string {
    const short = account.stateKey.slice(0, 8)
    if (account.label) return `${account.label} [${short}]`
    return `account ${short}`
  }

  /**
   * Find the next available account (round-robin, cooldown-aware) WITHOUT
   * advancing the global pointer. The caller is responsible for updating
   * `accountIndex` once it commits to using the picked account.
   *
   * Selection order:
   *   1. Eligible (not in cooldown for `model`, not excluded, has at least
   *      one warm endpoint).
   *   2. Among eligible, prefer the **lowest historical backoff level** for
   *      this model — accounts that have been recently 429'd into L2/L3/L4
   *      are dropped to the back of the queue even after their cooldown
   *      expires, so the next request lands on a healthier account first.
   *      This avoids the pathological pattern where one always-stressed
   *      account (e.g. k2) keeps absorbing the first request of every turn,
   *      stealing 1-2s on a guaranteed 429 before we switch.
   *   3. Among accounts at the same backoff level, fall back to round-robin
   *      using `accountIndex + startOffset` as the starting point.
   */
  private findAvailableAccount(
    model: string,
    options?: { exclude?: Set<string>; startOffset?: number; now?: number }
  ): KiroAccount | null {
    if (this.accounts.length === 0) return null
    const now = options?.now ?? Date.now()
    const exclude = options?.exclude
    const startOffset = options?.startOffset ?? 0

    // Collect every eligible account along with its rotation rank so the
    // scoring stage can break ties deterministically.
    const eligible: Array<{ account: KiroAccount; rotationRank: number }> = []
    for (let offset = 0; offset < this.accounts.length; offset++) {
      const idx =
        (this.accountIndex + startOffset + offset) % this.accounts.length
      const account = this.accounts[idx]!
      if (exclude && exclude.has(account.stateKey)) continue
      if (
        isAccountAvailableForModel(account, model, now) &&
        this.hasAvailableEndpointForModel(account, model, now)
      ) {
        eligible.push({ account, rotationRank: offset })
      }
    }
    if (eligible.length === 0) return null

    // Score each candidate: lower is better.
    //   - backoffLevel for this model (0 if never 429'd)
    //   - then rotation rank, so ties keep round-robin behaviour
    eligible.sort((a, b) => {
      const aLevel = a.account.modelStates.get(model)?.backoffLevel ?? 0
      const bLevel = b.account.modelStates.get(model)?.backoffLevel ?? 0
      if (aLevel !== bLevel) return aLevel - bLevel
      return a.rotationRank - b.rotationRank
    })
    return eligible[0]!.account
  }

  private hasAvailableEndpointForModel(
    account: KiroAccount,
    model: string,
    now: number
  ): boolean {
    return this.getOrderedEndpoints(account, model, now).length > 0
  }

  private indexOfAccount(account: KiroAccount): number {
    return this.accounts.findIndex((a) => a.stateKey === account.stateKey)
  }

  /**
   * When multiple accounts share the same label, append a `#N` suffix so
   * logs and the dashboard can distinguish them.
   */
  private deduplicateAccountLabels(): void {
    const seen = new Map<string, number>()
    for (const account of this.accounts) {
      const base = account.label || "unnamed"
      const count = (seen.get(base) ?? 0) + 1
      seen.set(base, count)
      if (count > 1) {
        account.label = `${base} #${count}`
      }
    }
    // If the first occurrence also has duplicates, tag it as #1.
    for (const [base, count] of seen.entries()) {
      if (count <= 1) continue
      const first = this.accounts.find(
        (a) => a.label === base || (!a.label && base === "unnamed")
      )
      if (first) {
        first.label = `${base} #1`
      }
    }
  }

  private pickAccountOrThrow(model: string): KiroAccount {
    if (this.accounts.length === 0) {
      throw new BackendAccountPoolUnavailableError(
        "No Kiro accounts configured",
        { backend: "kiro" }
      )
    }

    const picked = this.findAvailableAccount(model)
    if (picked) {
      const idx = this.indexOfAccount(picked)
      if (idx >= 0) {
        this.accountIndex = (idx + 1) % this.accounts.length
      }
      return picked
    }

    const recovery = this.getEarliestRecoveryForModel(model)
    const retryAfterSeconds =
      recovery && recovery.retryAfterMs > 0
        ? Math.ceil(recovery.retryAfterMs / 1000)
        : undefined
    throw new BackendAccountPoolUnavailableError(
      "All Kiro accounts are cooling down",
      {
        backend: "kiro",
        retryAfterSeconds,
      }
    )
  }

  // ── Token refresh ───────────────────────────────────────────────────────

  /**
   * Ensure the account has a fresh access token.
   *
   * - When `force=false` (default), only refresh if the token is missing or
   *   within {@link TOKEN_REFRESH_SKEW_SECONDS} of expiry.
   * - When `force=true`, refresh unconditionally. Used after the upstream
   *   service rejects the token with 401/403 even though our local clock
   *   thinks it is still valid (the social/IdC provider may have rotated
   *   or revoked the token server-side).
   */
  private async ensureFreshToken(
    account: KiroAccount,
    options?: { force?: boolean }
  ): Promise<void> {
    // API Key accounts never need token refresh — the key is used directly.
    if (account.authMethod === "api_key") return

    const force = options?.force === true
    const nowSec = Math.floor(Date.now() / 1000)
    const needsRefresh =
      force ||
      !account.accessToken ||
      (account.expiresAt > 0 &&
        nowSec >= account.expiresAt - TOKEN_REFRESH_SKEW_SECONDS)
    if (!needsRefresh) return

    if (account.refreshPromise) {
      await account.refreshPromise
      return
    }

    const refreshTask = (async () => {
      if (!account.refreshToken) {
        throw new Error("Kiro account has no refreshToken")
      }
      try {
        const result = await refreshKiroToken({
          authMethod: account.authMethod,
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          region: account.region,
          proxyUrl: account.proxyUrl,
        })
        account.accessToken = result.accessToken
        account.refreshToken = result.refreshToken
        account.expiresAt = result.expiresAt
        if (result.profileArn) {
          account.profileArn = result.profileArn
        }
        // Persist to disk so next restart has fresh token.
        this.persistTokenToDisk(account)
        this.mirrorLocalLoginsIfSelected(account)
        this.logger.log(
          `[Kiro] Refreshed access token for ${account.label || account.stateKey.slice(0, 12)} (expiresAt=${account.expiresAt})`
        )
      } catch (refreshError) {
        // Refresh failed (e.g. one-time refresh token already used).
        // Fallback: try to re-read from local AWS SSO cache, but only
        // accept tokens whose authMethod matches the current account so
        // we never marry a Builder ID registration to a Google/GitHub
        // social token (or vice-versa).
        this.logger.warn(
          `[Kiro] Token refresh failed for ${account.label || account.stateKey.slice(0, 12)}: ${(refreshError as Error).message}; trying local cache fallback`
        )
        const tokens = discoverLocalKiroTokens()
        const sameMethod = tokens.filter(
          (t) => t.authMethod === account.authMethod
        )
        const fresh =
          sameMethod.find(
            (t) => t.accessToken && t.accessToken !== account.accessToken
          ) || sameMethod[0]
        if (fresh && fresh.accessToken) {
          account.accessToken = fresh.accessToken
          account.refreshToken = fresh.refreshToken
          account.expiresAt = fresh.expiresAt
          if (account.authMethod === "idc") {
            if (fresh.clientId) account.clientId = fresh.clientId
            if (fresh.clientSecret) account.clientSecret = fresh.clientSecret
          } else {
            // Social accounts must not carry idc credentials, regardless of
            // what we fished out of the cache directory.
            account.clientId = undefined
            account.clientSecret = undefined
          }
          if (fresh.profileArn) account.profileArn = fresh.profileArn
          this.persistTokenToDisk(account)
          this.logger.log(
            `[Kiro] Recovered ${account.authMethod} token from local cache for ${account.label || account.stateKey.slice(0, 12)}`
          )
        } else {
          throw refreshError
        }
      }
    })()
    account.refreshPromise = refreshTask
    try {
      await refreshTask
    } finally {
      account.refreshPromise = undefined
    }
  }

  private async ensureProfileArn(account: KiroAccount): Promise<void> {
    // API Key accounts do not use profileArn.
    if (account.authMethod === "api_key") return
    if (account.profileArn) return

    // Mirror Kiro-Go's ResolveProfileArn: retry ListAvailableProfiles on
    // transient failures (network / 5xx / 429), then fall back to a token
    // refresh whose response may carry the profileArn (social accounts).
    // IdC/Enterprise accounts get their ARN from ListAvailableProfiles; the
    // upstream rejects generateAssistantResponse with HTTP 400
    // "profileArn is required" when it is missing, so resolving it here is
    // mandatory, not best-effort.
    const MAX_ATTEMPTS = 3
    let backoffMs = 200
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const arn = await listAvailableProfileArn({
          accessToken: account.accessToken,
          machineId: account.machineId,
          proxyUrl: account.proxyUrl,
          client: account.client,
        })
        if (arn) {
          account.profileArn = arn
          this.persistAccountStates()
          // Cache to disk too so a restart skips re-resolution.
          this.persistTokenToDisk(account)
          this.logger.log(
            `[Kiro] Resolved profileArn for ${account.label || account.stateKey.slice(0, 12)}`
          )
          return
        }
        // Empty profile list is authoritative — stop retrying and try the
        // refresh fallback below.
        break
      } catch (error) {
        const message = (error as Error).message
        const isTransient =
          /HTTP 5\d\d|HTTP 429/.test(message) || !/HTTP \d/.test(message)
        if (!isTransient || attempt === MAX_ATTEMPTS) {
          this.logger.debug?.(
            `[Kiro] ListAvailableProfiles failed for ${account.label || ""}: ${message}`
          )
          break
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        backoffMs *= 2
      }
    }

    // Fallback: a forced token refresh may return profileArn (social).
    if (account.refreshToken) {
      try {
        const result = await refreshKiroToken({
          authMethod: account.authMethod,
          refreshToken: account.refreshToken,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          region: account.region,
          proxyUrl: account.proxyUrl,
        })
        account.accessToken = result.accessToken
        account.refreshToken = result.refreshToken
        account.expiresAt = result.expiresAt
        if (result.profileArn) {
          account.profileArn = result.profileArn
          this.persistAccountStates()
          this.persistTokenToDisk(account)
          this.logger.log(
            `[Kiro] Resolved profileArn via refresh for ${account.label || account.stateKey.slice(0, 12)}`
          )
        }
      } catch (error) {
        this.logger.debug?.(
          `[Kiro] profileArn refresh fallback failed for ${account.label || ""}: ${(error as Error).message}`
        )
      }
    }
  }

  // ── Endpoint helpers ────────────────────────────────────────────────────

  private getBaseOrderedEndpoints(account: KiroAccount): KiroEndpoint[] {
    const fallback = account.endpointFallback
    let primary = 0
    switch (account.preferredEndpoint) {
      case "kiro":
        primary = 0
        break
      case "codewhisperer":
        primary = 1
        break
      default:
        return [...KIRO_ENDPOINTS]
    }
    if (!fallback) {
      return [KIRO_ENDPOINTS[primary]!]
    }
    const ordered: KiroEndpoint[] = [KIRO_ENDPOINTS[primary]!]
    for (let i = 0; i < KIRO_ENDPOINTS.length; i++) {
      if (i === primary) continue
      ordered.push(KIRO_ENDPOINTS[i]!)
    }
    return ordered
  }

  private getOrderedEndpoints(
    account: KiroAccount,
    model?: string,
    now: number = Date.now()
  ): KiroEndpoint[] {
    const endpoints = this.getBaseOrderedEndpoints(account)
    if (!model) return endpoints
    return endpoints.filter((endpoint) =>
      this.isEndpointAvailableForModel(account, endpoint, model, now)
    )
  }

  private endpointCooldownKey(endpoint: KiroEndpoint, model: string): string {
    return `${model}\0${endpoint.name}`
  }

  private isEndpointAvailableForModel(
    account: KiroAccount,
    endpoint: KiroEndpoint,
    model: string,
    now: number = Date.now()
  ): boolean {
    const key = this.endpointCooldownKey(endpoint, model)
    const state = account.endpointStates.get(key)
    if (!state) return true
    if (state.cooldownUntil > now) return false
    if (state.cooldownUntil > 0) {
      account.endpointStates.set(key, {
        ...state,
        cooldownUntil: 0,
      })
    }
    return true
  }

  private getActiveEndpointCooldownUntil(
    account: KiroAccount,
    endpoint: KiroEndpoint,
    model: string,
    now: number = Date.now()
  ): number {
    const key = this.endpointCooldownKey(endpoint, model)
    const state = account.endpointStates.get(key)
    if (!state) return 0
    if (state.cooldownUntil > now) return state.cooldownUntil
    if (state.cooldownUntil > 0) {
      account.endpointStates.set(key, {
        ...state,
        cooldownUntil: 0,
      })
    }
    return 0
  }

  private getEarliestRecoveryForModel(
    model: string
  ): { earliestRecovery: number; retryAfterMs: number } | null {
    const now = Date.now()
    let earliest = Infinity

    for (const account of this.accounts) {
      if (isAccountDisabled(account)) continue

      const globalOrModelRecovery = Math.max(
        account.cooldownUntil > now ? account.cooldownUntil : 0,
        account.modelStates.get(model)?.cooldownUntil ?? 0
      )
      const activeEndpointRecoveries = this.getBaseOrderedEndpoints(account)
        .map((endpoint) =>
          this.getActiveEndpointCooldownUntil(account, endpoint, model, now)
        )
        .filter((cooldownUntil) => cooldownUntil > now)
      const allEndpointsCooling =
        activeEndpointRecoveries.length ===
        this.getBaseOrderedEndpoints(account).length
      const endpointRecovery = allEndpointsCooling
        ? Math.min(...activeEndpointRecoveries)
        : 0
      const accountRecovery = Math.max(globalOrModelRecovery, endpointRecovery)

      if (accountRecovery <= now) {
        return null
      }
      earliest = Math.min(earliest, accountRecovery)
    }

    if (earliest === Infinity) return null
    return {
      earliestRecovery: earliest,
      retryAfterMs: Math.max(0, earliest - now),
    }
  }

  private markEndpointCooldown(
    account: KiroAccount,
    endpoint: KiroEndpoint,
    model: string,
    retryAfterHeader?: string
  ): void {
    const key = this.endpointCooldownKey(endpoint, model)
    const existing = account.endpointStates.get(key)
    const backoffLevel = existing?.backoffLevel ?? 0
    const delayMs = retryAfterHeader
      ? parseEndpointRetryAfterMs(
          retryAfterHeader,
          ENDPOINT_QUOTA_BACKOFF_BASE_MS
        )
      : nextEndpointQuotaCooldown(backoffLevel)

    account.endpointStates.set(key, {
      cooldownUntil: Date.now() + delayMs,
      quotaExhausted: true,
      backoffLevel: backoffLevel + 1,
    })

    this.logger.warn(
      `[Kiro] Endpoint ${endpoint.name} 429 for ${this.accountTag(account)} ` +
        `model=${model}; endpoint cooldown ${formatEndpointDuration(delayMs)} ` +
        `(backoff L${backoffLevel + 1}); trying next endpoint`
    )
  }

  private markEndpointSuccess(
    account: KiroAccount,
    endpoint: KiroEndpoint,
    model: string
  ): void {
    account.endpointStates.delete(this.endpointCooldownKey(endpoint, model))
  }

  private markAccountQuotaCooldownIfEndpointsExhausted(
    account: KiroAccount,
    model: string,
    retryAfterHeader?: string
  ): boolean {
    if (this.hasAvailableEndpointForModel(account, model, Date.now())) {
      return false
    }

    markAccountCooldown(
      account,
      429,
      model,
      retryAfterHeader,
      this.accountTag(account)
    )
    this.persistAccountStates()
    this.logger.warn(
      `[Kiro] All endpoints are cooling for ${this.accountTag(account)} ` +
        `model=${model}; skipping this account until quota recovery`
    )
    return true
  }

  private buildProxyDispatcher(account: KiroAccount): unknown {
    const proxyUrl = account.proxyUrl
    if (!proxyUrl) return undefined
    try {
      const url = new URL(proxyUrl)
      if (
        url.protocol === "socks:" ||
        url.protocol === "socks4:" ||
        url.protocol === "socks5:"
      ) {
        return new SocksProxyAgent(proxyUrl)
      }
      if (url.protocol === "http:") return new HttpProxyAgent(proxyUrl)
      if (url.protocol === "https:") return new HttpsProxyAgent(proxyUrl)
    } catch {
      // ignore
    }
    return undefined
  }

  // ── Core call ───────────────────────────────────────────────────────────

  /**
   * Resolve the per-request `additionalModelRequestFields` we want the
   * Kiro backend to honour for this DTO.
   *
   * Background: the Kiro `claude-opus-4.7` family advertises (via
   * `ListAvailableModels.additionalModelRequestFieldsSchema`) a
   * `thinking: { type: "adaptive" | "disabled", display: ... }` knob plus
   * an `output_config.effort` knob. When the wire payload omits the field,
   * the backend falls back to its model default — which on Opus 4.7 means
   * adaptive thinking with summarized display. Empirically that adds 5–40
   * seconds of `reasoningContentEvent` frames before any tool/assistant
   * output even on trivial tool continuations, dominating turn latency.
   *
   * We translate the bridge-internal `ThinkingIntent` (built upstream from
   * the Cursor request and/or `dto.thinking`) into the wire shape Kiro
   * accepts, so callers who explicitly disabled thinking get a true
   * non-thinking call instead of silently falling back to Opus 4.7's
   * default adaptive mode.
   *
   * Returns `undefined` when no override is needed (caller wants the
   * model default). Callers that want a non-thinking call must pass an
   * intent of `{ mode: "disabled" }` upstream.
   */
  private prepareAdditionalModelRequestFields(
    dto: CreateMessageDto
  ): KiroAdditionalModelRequestFields | undefined {
    const intent = resolveThinkingIntentFromDto(dto)
    if (!intent) return undefined

    return this.intentToKiroFields(intent)
  }

  private intentToKiroFields(
    intent: ThinkingIntent
  ): KiroAdditionalModelRequestFields | undefined {
    switch (intent.mode) {
      case "disabled":
        return { thinking: { type: "disabled", display: "omitted" } }
      case "adaptive": {
        const out: KiroAdditionalModelRequestFields = {
          thinking: { type: "adaptive", display: "summarized" },
        }
        const effort = this.normalizeKiroEffort(intent.effort)
        if (effort) out.output_config = { effort }
        return out
      }
      case "explicit_effort": {
        const effort = this.normalizeKiroEffort(intent.effort)
        const out: KiroAdditionalModelRequestFields = {
          thinking: { type: "adaptive", display: "summarized" },
        }
        if (effort) out.output_config = { effort }
        return out
      }
      case "explicit_budget":
        // Kiro's schema does not accept `budget_tokens` directly; the
        // closest mapping is enabling adaptive thinking. Effort stays
        // unset so the backend picks a sensible default.
        return { thinking: { type: "adaptive", display: "summarized" } }
      default:
        return undefined
    }
  }

  private normalizeKiroEffort(
    effort: ThinkingIntentEffort | undefined
  ): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
    switch (effort) {
      case "minimal":
      case "low":
        return "low"
      case "medium":
        return "medium"
      case "high":
        return "high"
      case "xhigh":
        return "xhigh"
      case "max":
        return "max"
      default:
        return undefined
    }
  }

  /**
   * Classify a Kiro / CodeWhisperer non-2xx response into the unified
   * BackendErrorClass taxonomy. Reads the structured `reason` field
   * from the JSON body (a stable upstream enum) ahead of any prose
   * matching, so this classifier survives upstream rephrasing.
   *
   * The two endpoints in this backend (Kiro IDE + CodeWhisperer) emit
   * slightly different message strings for the same underlying
   * condition; both carry the same `reason` enum value, which is what
   * we key on. See backend-error-class.ts for the cross-provider
   * taxonomy and downstream policy.
   */
  private classifyKiroResponseError(
    status: number,
    responseText: string
  ): { errorClass: BackendErrorClass; maxTokens?: number } {
    if (status === 401 || status === 403) {
      return { errorClass: "auth_failed" }
    }
    if (status === 429) {
      return { errorClass: "rate_limited" }
    }
    if (status >= 500 && status < 600) {
      return { errorClass: "transient_5xx" }
    }
    if (status !== 400) {
      return { errorClass: "unknown" }
    }

    // 400: dispatch on the structured `reason` enum first.
    let reason: string | undefined
    try {
      const parsed = JSON.parse(responseText) as Record<string, unknown>
      const candidate = typeof parsed.reason === "string" ? parsed.reason : ""
      if (candidate) reason = candidate
    } catch {
      // body wasn't JSON; fall through to prose match.
    }

    if (reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD") {
      return {
        errorClass: "context_length_exceeded",
        // Kiro doesn't return the actual / max numbers — its reject is
        // wire-byte based (~2.15 MB JSON body), not token based, and
        // the upstream error body carries no counters. The Anthropic
        // envelope renderer (formatAnthropicMessage) emits the bare
        // "prompt is too long" string in that case, which CC CLI still
        // matches via its case-insensitive substring check at
        // services/api/errors.ts:564 — the precise N/M numbers are
        // only used by the reactive-compact gap math, which falls back
        // to a heuristic step when the numbers are missing.
        maxTokens: undefined,
      }
    }

    // No structured enum — last-resort classification on prose. Tools
    // / schema / validation are bridge-debuggable shape problems; the
    // rest are generic 4xx that we don't auto-recover.
    if (
      /toolconfig|tool_config_missing|tool config|schema|validation/i.test(
        responseText
      )
    ) {
      return { errorClass: "tool_schema_invalid" }
    }
    // Defense in depth: if `reason` was missing but the prose still
    // describes a length error, classify it correctly.
    if (
      /input is too long|input content length exceeds|exceeds threshold|prompt is too long/i.test(
        responseText
      )
    ) {
      return { errorClass: "context_length_exceeded" }
    }
    return { errorClass: "request_shape_invalid" }
  }

  /**
   * @deprecated Use `classifyKiroResponseError` + RETRY_POLICY instead.
   * Kept for one release as a thin shim over the new classifier.
   */
  private isNonRetryableRequestShapeError(
    status: number,
    responseText: string
  ): boolean {
    const { errorClass } = this.classifyKiroResponseError(status, responseText)
    return !RETRY_POLICY[errorClass].retryableDifferentAccount
  }

  /**
   * Tag a parser-side stream failure with the unified BackendError
   * taxonomy so the router / fallback layer can act on it.
   *
   * The "Kiro stream closed without producing any assistant content"
   * case (event-stream.ts) is a real, observed failure mode where AWS
   * closes the connection cleanly mid-flight on long compaction
   * summary requests. Without an explicit class tag the surrounding
   * catch site re-throws a bare Error which `classifyBackendError`
   * maps to `unknown` — that class disables both same-account retry
   * and cross-backend fallback in RETRY_POLICY, so the request would
   * dead-end here. Tagging it as `transient_5xx` matches its
   * semantics (upstream produced no useful response) and unlocks the
   * retry / fallback ladder.
   *
   * Non-empty-stream errors are passed through unchanged — the caller
   * sees the original error type and message.
   */
  private tagKiroStreamParseError(error: unknown): unknown {
    if (
      error instanceof Error &&
      !(error instanceof BackendApiError) &&
      error.message.startsWith("Kiro stream closed without producing")
    ) {
      return new BackendApiError(error.message, {
        backend: "kiro",
        statusCode: 502,
        errorClass: "transient_5xx",
      })
    }
    return error
  }

  /**
   * Detect whether an error is an AbortError thrown by fetch() when the
   * AbortSignal fires. Node's undici throws a DOMException with name
   * "AbortError", while older environments may throw a plain Error with
   * "aborted" in the message.
   */
  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const e = error as { name?: string; code?: string; message?: string }
    if (e.name === "AbortError") return true
    if (e.code === "ABORT_ERR") return true
    if (e.name === "TimeoutError") return true
    if (/abort/i.test(e.message ?? "")) return true
    return false
  }

  private resolveStreamRequestTimeoutMs(): number {
    const raw = (process.env.KIRO_STREAM_REQUEST_TIMEOUT_MS || "").trim()
    if (!raw) return STREAM_REQUEST_TIMEOUT_MS
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `[Kiro] Ignoring invalid KIRO_STREAM_REQUEST_TIMEOUT_MS=${raw}`
      )
      return STREAM_REQUEST_TIMEOUT_MS
    }
    return Math.max(1_000, Math.floor(parsed))
  }

  private createStreamRequestAbortSignal(externalSignal?: AbortSignal): {
    signal: AbortSignal
    timeoutMs: number
  } {
    const timeoutMs = this.resolveStreamRequestTimeoutMs()
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    return {
      signal: externalSignal
        ? AbortSignal.any([externalSignal, timeoutSignal])
        : timeoutSignal,
      timeoutMs,
    }
  }

  private isTimeoutAbort(error: unknown, signal?: AbortSignal): boolean {
    const reason: unknown = signal?.reason
    if (reason && typeof reason === "object") {
      const name = (reason as { name?: string }).name
      if (name === "TimeoutError") return true
    }
    if (reason instanceof Error && /timeout/i.test(reason.message)) return true
    if (typeof reason === "string" && /timeout/i.test(reason)) return true

    if (error && typeof error === "object") {
      const e = error as { name?: string; message?: string }
      if (e.name === "TimeoutError") return true
      if (/timeout/i.test(e.message ?? "")) return true
    }
    return false
  }

  /**
   * Extract a human-readable abort reason from the error or signal.
   */
  private extractAbortReason(
    error: unknown,
    abortSignal?: AbortSignal
  ): string {
    // AbortSignal.reason is the value passed to controller.abort(reason)
    const signalReason: unknown = abortSignal?.reason
    if (signalReason instanceof Error) return signalReason.message
    if (typeof signalReason === "string") return signalReason
    const errorMessage = (error as Error)?.message
    if (errorMessage) return errorMessage
    return "unknown abort reason"
  }

  private buildKiroPayload(
    dto: CreateMessageDto,
    account: KiroAccount
  ): KiroPayload {
    const fields = this.prepareAdditionalModelRequestFields(dto)
    const payload = claudeToKiro(dto, {
      thinking: fields?.thinking,
      effort: fields?.output_config?.effort,
      profileArn: account.profileArn,
      conversationId: (dto._conversationId || "").trim() || undefined,
    })

    // Splice the previous turn(s)' reasoning digest into the user content.
    // The wire path does not carry structured thinking blocks across turns,
    // so the bridge-level continuity strategy for kiro is `text_preamble`
    // (see backend-capability.ts). The send-time pipeline in
    // cursor-connect-stream.ts owns the projection — it sources records
    // from ReasoningMemoryService, applies budget arithmetic, frames the
    // text as `<previous_thinking>...</previous_thinking>`, and hands the
    // ready-to-splice payload over via `dto._lastThinkingSummary`. We
    // splice it raw — no additional framing — so the contract is:
    //
    //   `dto._lastThinkingSummary` is wire-ready preamble text, including
    //   its own XML envelope and trailing blank line. Producers (and only
    //   producers) decide its shape.
    const summary = dto._lastThinkingSummary
    if (typeof summary === "string" && summary.length > 0) {
      const userMsg = payload.conversationState.currentMessage.userInputMessage
      const existing = userMsg.content || ""
      userMsg.content = summary + existing
      this.logger.log?.(
        `[Kiro] Injected previous-turn reasoning preamble: ${summary.length} chars`
      )
    }

    return payload
  }

  private async callKiro(
    dto: CreateMessageDto,
    account: KiroAccount,
    callback: KiroStreamCallback,
    abortSignal?: AbortSignal
  ): Promise<{
    httpStatus: number
    endpointName: string
    account: KiroAccount
  }> {
    await this.ensureFreshToken(account)
    await this.ensureProfileArn(account)

    let currentAccount = account
    const model = this.resolveCooldownModel(dto.model)
    let lastError: Error | null = null
    const MAX_RETRIES = 10
    const BASE_DELAY_MS = 3000
    /** Accounts that have been tried and failed or entered cooldown this call. */
    const attemptedAccountKeys = new Set<string>()
    /** Accounts that have already been force-refreshed this call (max once per account). */
    const forceRefreshedKeys = new Set<string>()

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Class-driven early exit: if the last failure carries a class
      // that policy says is not retryable on a different account,
      // there is no point churning the retry loop. PTL is the
      // motivating case — every account fails identically because
      // the wire body is identical.
      if (
        attempt > 0 &&
        lastError instanceof BackendApiError &&
        lastError.errorClass &&
        !RETRY_POLICY[lastError.errorClass].retryableDifferentAccount
      ) {
        throw lastError
      }
      if (attempt > 0) {
        // Before waiting, try to switch to a different account if available.
        const alternate = this.findAvailableAccount(model, {
          exclude: attemptedAccountKeys,
        })
        if (alternate && alternate.stateKey !== currentAccount.stateKey) {
          this.logger.log(
            `[Kiro] Switching from ${this.accountTag(currentAccount)} to ${this.accountTag(alternate)} after previous account failure/cooldown`
          )
          currentAccount = alternate
          await this.ensureFreshToken(currentAccount)
          await this.ensureProfileArn(currentAccount)
        } else {
          // No alternate available. Two paths:
          //   - Default: wait with exponential backoff (capped at 30s) and
          //     hope a cooldown expires.
          //   - KIRO_FAST_FAIL_ON_NO_ALTERNATE=1: throw immediately so the
          //     model router can fall back to claude-api / google-claude
          //     instead of stalling the user-visible turn for 3-30s while
          //     every Kiro account is hot. The backend pool error class is
          //     non-permanent so the router will re-enter Kiro on a later
          //     turn once cooldowns clear.
          if (this.shouldFastFailOnNoAlternate()) {
            this.logger.warn(
              `[Kiro] No alternate Kiro account available (attempted=${attemptedAccountKeys.size}/${this.accounts.length}); fast-failing so the upstream router can pick a different backend.`
            )
            throw (
              lastError ??
              new BackendApiError(
                `No Kiro account available for model=${model} (all in cooldown)`,
                { backend: "kiro", statusCode: 429 }
              )
            )
          }
          // No alternate available — wait with backoff (capped at 30s).
          const delay = Math.min(
            30_000,
            BASE_DELAY_MS * Math.pow(2, attempt - 1)
          )
          this.logger.warn(
            `[Kiro] All endpoints/accounts failed on attempt ${attempt}, retrying in ${delay}ms...`
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          if (abortSignal?.aborted) {
            const reason = this.extractAbortReason(
              abortSignal.reason,
              abortSignal
            )
            throw new BackendApiError(`Kiro request aborted: ${reason}`, {
              backend: "kiro",
              statusCode: 499,
              permanent: true,
              errorClass: "client_aborted",
            })
          }
          // After waiting, cooldowns may have expired — try to pick a fresh account.
          const recovered = this.findAvailableAccount(model)
          if (recovered) {
            currentAccount = recovered
            await this.ensureFreshToken(currentAccount)
            await this.ensureProfileArn(currentAccount)
          }
        }
      }

      const payload = this.buildKiroPayload(dto, currentAccount)

      // Last-resort guard: if profileArn is still missing after all
      // ensureProfileArn calls, force one final parse attempt before
      // sending the request. This prevents 400 "profileArn is required"
      // errors from reaching the wire.
      if (!payload.profileArn) {
        this.logger.warn(
          `[Kiro] profileArn missing in payload for ${this.accountTag(currentAccount)} before request — forcing final parse attempt`
        )
        await this.ensureProfileArn(currentAccount)
        // Rebuild payload with (hopefully) fresh profileArn
        const rebuiltPayload = this.buildKiroPayload(dto, currentAccount)
        if (rebuiltPayload.profileArn) {
          Object.assign(payload, rebuiltPayload)
          this.logger.log(
            `[Kiro] profileArn recovered: ${rebuiltPayload.profileArn}`
          )
        } else {
          this.logger.error(
            `[Kiro] profileArn still missing after final parse attempt for ${this.accountTag(currentAccount)} — request will likely fail with 400`
          )
        }
      }

      const orderedEndpoints = this.getOrderedEndpoints(currentAccount, model)
      if (orderedEndpoints.length === 0) {
        lastError = new BackendApiError(
          `All Kiro endpoints are cooling down for ${this.accountTag(currentAccount)} model=${model}`,
          { backend: "kiro", statusCode: 429, errorClass: "rate_limited" }
        )
        attemptedAccountKeys.add(currentAccount.stateKey)
        continue
      }

      for (const endpoint of orderedEndpoints) {
        payload.conversationState.currentMessage.userInputMessage.origin =
          endpoint.origin

        const url = endpoint.url
        const host = new URL(url).host
        const headerValues = buildStreamingHeaderValues({
          machineId: currentAccount.machineId,
          host,
          client: currentAccount.client,
        })
        const baseHeaders = buildKiroBaseHeaders({
          accessToken: currentAccount.accessToken,
          values: headerValues,
          extra: {
            "Content-Type": "application/json",
            Accept: "*/*",
            "x-amzn-kiro-agent-mode": "vibe",
            "x-amzn-codewhisperer-optout": "true",
            "amz-sdk-request": "attempt=1; max=3",
            "amz-sdk-invocation-id": randomUUID(),
          },
        })
        if (endpoint.amzTarget) {
          baseHeaders["X-Amz-Target"] = endpoint.amzTarget
        }
        if (currentAccount.authMethod === "api_key") {
          baseHeaders["tokentype"] = "API_KEY"
        }

        let activeRequestAbort =
          this.createStreamRequestAbortSignal(abortSignal)
        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
          method: "POST",
          headers: baseHeaders,
          signal: activeRequestAbort.signal,
        }
        const dispatcher = this.buildProxyDispatcher(currentAccount)
        if (dispatcher) fetchOptions.dispatcher = dispatcher

        try {
          const bodyStr = JSON.stringify(payload)
          const tmpPath = path.join(
            os.tmpdir(),
            "agent-vibes-kiro-payload.json"
          )
          fs.writeFileSync(tmpPath, bodyStr)
          this.logger.debug(
            `[Kiro] Request payload written to ${tmpPath} (${bodyStr.length} bytes)`
          )
          this.logger.log(
            `[Kiro] -> ${endpoint.name} POST ${url} (account=${this.accountTag(currentAccount)}, model=${model})`
          )
          const response = await fetch(url, {
            ...fetchOptions,
            body: bodyStr,
          })

          if (response.status === 429) {
            const retryAfterHeader =
              response.headers.get("retry-after") || undefined
            this.markEndpointCooldown(
              currentAccount,
              endpoint,
              model,
              retryAfterHeader
            )
            const accountEndpointsExhausted =
              this.markAccountQuotaCooldownIfEndpointsExhausted(
                currentAccount,
                model,
                retryAfterHeader
              )
            if (accountEndpointsExhausted) {
              attemptedAccountKeys.add(currentAccount.stateKey)
            }
            lastError = new BackendApiError(
              `Kiro endpoint ${endpoint.name} returned 429`,
              { backend: "kiro", statusCode: 429 }
            )
            response.body?.cancel().catch(() => undefined)
            if (accountEndpointsExhausted) break
            continue
          }

          if (!response.ok) {
            const text = await response.text().catch(() => "")
            const status = response.status
            this.logger.warn(
              `[Kiro] Endpoint ${endpoint.name} HTTP ${status} for ${this.accountTag(currentAccount)}: ${text.slice(0, 240)}`
            )

            if (status === 401 || status === 403) {
              // Auth failure — attempt a forced token refresh before giving up.
              // Each account gets at most ONE force-refresh per callKiro invocation
              // (mirrors kiro.rs's HashSet<u64> guard to avoid infinite refresh loops).
              const alreadyRefreshed = forceRefreshedKeys.has(
                currentAccount.stateKey
              )

              if (!alreadyRefreshed) {
                forceRefreshedKeys.add(currentAccount.stateKey)
                this.logger.log(
                  `[Kiro] Auth failure (${status}) for ${this.accountTag(currentAccount)}, attempting forced token refresh...`
                )
                let refreshed = false
                try {
                  await this.ensureFreshToken(currentAccount, { force: true })
                  refreshed = true
                } catch (refreshErr) {
                  this.logger.warn(
                    `[Kiro] Forced token refresh failed for ${this.accountTag(currentAccount)}: ${(refreshErr as Error).message}`
                  )
                }

                if (refreshed) {
                  // Retry the SAME endpoint once with the new token.
                  const retryHeaders = buildKiroBaseHeaders({
                    accessToken: currentAccount.accessToken,
                    values: buildStreamingHeaderValues({
                      machineId: currentAccount.machineId,
                      host,
                      client: currentAccount.client,
                    }),
                    extra: {
                      "Content-Type": "application/json",
                      Accept: "*/*",
                      "x-amzn-kiro-agent-mode": "vibe",
                      "x-amzn-codewhisperer-optout": "true",
                      "amz-sdk-request": "attempt=1; max=3",
                      "amz-sdk-invocation-id": randomUUID(),
                    },
                  })
                  if (endpoint.amzTarget) {
                    retryHeaders["X-Amz-Target"] = endpoint.amzTarget
                  }
                  if (currentAccount.authMethod === "api_key") {
                    retryHeaders["tokentype"] = "API_KEY"
                  }
                  activeRequestAbort =
                    this.createStreamRequestAbortSignal(abortSignal)
                  const retryFetchOptions: RequestInit & {
                    dispatcher?: unknown
                  } = {
                    method: "POST",
                    headers: retryHeaders,
                    signal: activeRequestAbort.signal,
                  }
                  const retryDispatcher =
                    this.buildProxyDispatcher(currentAccount)
                  if (retryDispatcher)
                    retryFetchOptions.dispatcher = retryDispatcher

                  const retryPayload = this.buildKiroPayload(
                    dto,
                    currentAccount
                  )
                  retryPayload.conversationState.currentMessage.userInputMessage.origin =
                    endpoint.origin
                  const retryBodyStr = JSON.stringify(retryPayload)

                  this.logger.log(
                    `[Kiro] -> ${endpoint.name} POST ${url} (retry after refresh, account=${this.accountTag(currentAccount)})`
                  )
                  const retryResponse = await fetch(url, {
                    ...retryFetchOptions,
                    body: retryBodyStr,
                  })

                  if (retryResponse.ok && retryResponse.body) {
                    try {
                      await parseKiroEventStream(
                        retryResponse.body,
                        callback,
                        activeRequestAbort.signal
                      )
                    } catch (parseError) {
                      throw this.tagKiroStreamParseError(parseError)
                    }
                    this.logger.log(
                      `[Kiro] <- ${endpoint.name} stream completed after refresh (account=${this.accountTag(currentAccount)}, model=${model})`
                    )
                    this.markEndpointSuccess(currentAccount, endpoint, model)
                    markAccountSuccess(currentAccount, model)
                    clearAccountDisablement(currentAccount)
                    this.persistAccountStates()
                    return {
                      httpStatus: retryResponse.status,
                      endpointName: endpoint.name,
                      account: currentAccount,
                    }
                  }
                  // Retry also failed — fall through to cooldown.
                  const retryText = await retryResponse.text().catch(() => "")
                  this.logger.warn(
                    `[Kiro] Retry after refresh still failed (${retryResponse.status}) for ${this.accountTag(currentAccount)}: ${retryText.slice(0, 200)}`
                  )
                  retryResponse.body?.cancel().catch(() => undefined)
                }
              } else {
                this.logger.warn(
                  `[Kiro] Auth failure (${status}) for ${this.accountTag(currentAccount)}, already force-refreshed — switching account`
                )
              }

              // Cooldown this account and mark it as attempted.
              markAccountCooldown(
                currentAccount,
                status,
                undefined,
                undefined,
                this.accountTag(currentAccount)
              )
              this.persistAccountStates()
              attemptedAccountKeys.add(currentAccount.stateKey)
              lastError = new BackendApiError(
                `Kiro auth error: HTTP ${status} ${text.slice(0, 200)}`,
                {
                  backend: "kiro",
                  statusCode: status,
                  errorClass: "auth_failed",
                }
              )
              // Break out of endpoint loop to trigger account switch at top of retry loop.
              break
            }

            // All other non-200: classify with structured-field-aware
            // logic and tag the BackendApiError so downstream retry /
            // fallback / Anthropic-envelope rendering can read the
            // class instead of re-parsing the wire body.
            const { errorClass, maxTokens } = this.classifyKiroResponseError(
              status,
              text
            )
            const requestError = new BackendApiError(
              `Kiro endpoint ${endpoint.name} HTTP ${status}: ${text.slice(0, 200)}`,
              {
                backend: "kiro",
                statusCode: status,
                errorClass,
                maxTokens,
              }
            )
            // Per-class policy decides whether to keep trying on this
            // backend (different account / different endpoint) or
            // bubble up so the model router can pick a different
            // backend entirely. PTL: bubble up immediately — every
            // account fails identically because the wire body is
            // identical.
            if (!RETRY_POLICY[errorClass].retryableDifferentAccount) {
              throw requestError
            }
            lastError = requestError
            response.body?.cancel().catch(() => undefined)
            continue
          }

          if (!response.body) {
            throw new BackendApiError("Kiro response has no body", {
              backend: "kiro",
              statusCode: 502,
              errorClass: "transient_5xx",
            })
          }

          try {
            await parseKiroEventStream(
              response.body,
              callback,
              activeRequestAbort.signal
            )
          } catch (parseError) {
            throw this.tagKiroStreamParseError(parseError)
          }
          this.logger.log(
            `[Kiro] <- ${endpoint.name} stream completed (account=${this.accountTag(currentAccount)}, model=${model})`
          )
          this.markEndpointSuccess(currentAccount, endpoint, model)
          markAccountSuccess(currentAccount, model)
          clearAccountDisablement(currentAccount)
          this.persistAccountStates()
          return {
            httpStatus: response.status,
            endpointName: endpoint.name,
            account: currentAccount,
          }
        } catch (error) {
          if (error instanceof BackendApiError) {
            if (
              error.permanent ||
              this.isNonRetryableRequestShapeError(
                error.statusCode ?? 0,
                error.message
              )
            )
              throw error
            lastError = error
            continue
          }

          // Abort errors from stream supersession are non-retryable.
          // The AbortController fires with reason containing "Superseded"
          // when a new bidi stream replaces the current one.
          if (this.isAbortError(error)) {
            const reason = this.extractAbortReason(
              error,
              activeRequestAbort.signal
            )
            if (this.isTimeoutAbort(error, activeRequestAbort.signal)) {
              throw new BackendApiError(
                `Kiro request timed out after ${activeRequestAbort.timeoutMs}ms`,
                {
                  backend: "kiro",
                  statusCode: 504,
                  errorClass: "transient_network",
                }
              )
            }
            throw new BackendApiError(`Kiro request aborted: ${reason}`, {
              backend: "kiro",
              statusCode: 499,
              permanent: true,
              errorClass: "client_aborted",
            })
          }

          const message = (error as Error).message || String(error)
          // Belt-and-suspenders: not every supersede surfaces as a proper
          // AbortError. When `backendStreamAbortRegistry.abortOtherStreams`
          // tears down an in-flight fetch the underlying error sometimes
          // arrives as a generic Error / TypeError whose message still
          // carries the "Superseded by stream <id> during ..." reason
          // string we set on the AbortController. Without this guard the
          // generic `Endpoint X failed for Y` warning fires and pollutes
          // both the operator log and downstream endpoint-health
          // statistics, even though no real endpoint failure occurred.
          // Treat any such error as a non-retryable cancellation, mirror
          // the proper abort path, and log at debug only.
          if (message.includes("Superseded by stream")) {
            this.logger.debug(
              `[Kiro] Endpoint ${endpoint.name} cancelled for ${this.accountTag(currentAccount)} (stream supersede): ${message}`
            )
            throw new BackendApiError(`Kiro request cancelled: ${message}`, {
              backend: "kiro",
              statusCode: 499,
              permanent: true,
              errorClass: "client_aborted",
            })
          }
          this.logger.warn(
            `[Kiro] Endpoint ${endpoint.name} failed for ${this.accountTag(currentAccount)}: ${message}`
          )
          lastError = new BackendApiError(
            `Kiro endpoint ${endpoint.name} failed: ${message}`,
            { backend: "kiro", statusCode: 504 }
          )
        }
      } // end endpoint loop
    } // end retry loop

    throw (
      lastError ||
      new BackendApiError("All Kiro endpoints failed after retries", {
        backend: "kiro",
        statusCode: 502,
      })
    )
  }

  private estimateRequestInputTokens(dto: CreateMessageDto): number {
    let total = 0
    const sumString = (s: string | undefined): void => {
      if (s) total += Math.max(1, Math.ceil(s.length / 4))
    }

    if (typeof dto.system === "string") {
      sumString(dto.system)
    } else if (Array.isArray(dto.system)) {
      for (const block of dto.system) {
        if (block && typeof block === "object") {
          const text = (block as { text?: string }).text
          sumString(text)
        }
      }
    }

    if (Array.isArray(dto.tools)) {
      for (const tool of dto.tools) {
        sumString(tool?.name)
        sumString(tool?.description)
        if (tool?.input_schema) {
          sumString(JSON.stringify(tool.input_schema))
        }
      }
    }

    for (const msg of dto.messages || []) {
      if (typeof msg.content === "string") {
        sumString(msg.content)
        continue
      }
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue
        const blockObj = block as unknown as Record<string, unknown>
        if (typeof blockObj.text === "string") sumString(blockObj.text)
        if (typeof blockObj.input === "object") {
          sumString(JSON.stringify(blockObj.input))
        }
        if (typeof blockObj.content === "string") sumString(blockObj.content)
        if (Array.isArray(blockObj.content)) {
          for (const inner of blockObj.content) {
            if (inner && typeof inner === "object") {
              const innerText = (inner as { text?: string }).text
              sumString(innerText)
            }
          }
        }
      }
    }

    return total
  }

  private getStreamUsageRecord(
    account: KiroAccount,
    dto: CreateMessageDto,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    cacheUsage?: KiroPromptCacheUsage
  ): void {
    this.usageStats.recordKiroUsage({
      transport: "messages",
      modelName: mapKiroModel(dto.model || dto._requestedModel || ""),
      accountKey: account.stateKey,
      accountLabel: account.label || account.stateKey.slice(0, 12),
      inputTokens,
      cachedInputTokens: cacheUsage?.cacheReadInputTokens,
      cacheCreationInputTokens: cacheUsage?.cacheCreationInputTokens,
      outputTokens,
      durationMs,
    })
  }

  // ── Non-streaming ──────────────────────────────────────────────────────

  private async executeNonStream(
    dto: CreateMessageDto,
    initialAccount: KiroAccount
  ): Promise<AnthropicResponse> {
    let account = initialAccount
    const startedAt = Date.now()
    const textParts: string[] = []
    const thinkingParts: string[] = []
    const toolUses: KiroToolUse[] = []
    const collected = {
      inputTokens: 0,
      outputTokens: 0,
    }

    // Compute simulated cache usage before sending the request so the
    // billed input_tokens can be reported as Anthropic-style cache_read /
    // cache_creation. Kiro / CodeWhisperer does not expose these counters
    // upstream, so the tracker fills the gap client-side.
    const estimatedInputTokens = this.estimateRequestInputTokens(dto)
    const cacheProfile = this.cacheTracker.buildProfile(
      dto,
      estimatedInputTokens
    )
    const cacheUsage = this.cacheTracker.compute(account.stateKey, cacheProfile)

    const callback: KiroStreamCallback = {
      onText: (text, isThinking) => {
        if (isThinking) thinkingParts.push(text)
        else textParts.push(text)
      },
      onToolUse: (tu) => {
        // 工具名按原样透传（与抓包一致），无需反向映射。
        toolUses.push(tu)
      },
      onComplete: (input, output) => {
        collected.inputTokens = input
        collected.outputTokens = output
      },
    }

    await this.callKiro(dto, account, callback).then((result) => {
      // If callKiro switched accounts mid-flight, update the cache tracker
      // to use the account that actually succeeded.
      if (result.account.stateKey !== account.stateKey) {
        account = result.account
      }
    })
    // Persist the breakpoints only after a successful response so a failed
    // request does not poison the cache state.
    this.cacheTracker.update(account.stateKey, cacheProfile)

    if (collected.inputTokens <= 0) {
      collected.inputTokens = estimatedInputTokens
    }

    this.getStreamUsageRecord(
      account,
      dto,
      collected.inputTokens,
      collected.outputTokens,
      Date.now() - startedAt,
      cacheUsage
    )

    const blocks: ContentBlock[] = []
    if (thinkingParts.length > 0) {
      blocks.push({ type: "thinking", thinking: thinkingParts.join("") })
    }
    const text = textParts.join("")
    if (text) blocks.push({ type: "text", text })
    for (const tu of toolUses) {
      blocks.push({
        type: "tool_use",
        id: tu.toolUseId,
        name: tu.name,
        input: tu.input,
      })
    }

    const billedInput = billedKiroInputTokens(collected.inputTokens, cacheUsage)
    const includeCache = cacheProfile != null

    return {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      content: blocks,
      model: mapKiroModel(dto.model || ""),
      stop_reason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage: {
        input_tokens: billedInput,
        output_tokens: collected.outputTokens,
        ...(includeCache
          ? {
              cache_read_input_tokens: cacheUsage.cacheReadInputTokens,
              cache_creation_input_tokens: cacheUsage.cacheCreationInputTokens,
              cache_creation: {
                ephemeral_5m_input_tokens:
                  cacheUsage.cacheCreation5mInputTokens,
                ephemeral_1h_input_tokens:
                  cacheUsage.cacheCreation1hInputTokens,
              },
            }
          : {}),
      },
    }
  }

  // ── Streaming ──────────────────────────────────────────────────────────

  private async *executeStream(
    dto: CreateMessageDto,
    initialAccount: KiroAccount,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    let account = initialAccount
    const startedAt = Date.now()
    const messageId = `msg_${randomUUID()}`
    const modelId = mapKiroModel(dto.model || "")

    // Pre-compute the simulated cache usage so message_start can advertise the
    // cache_read tokens and the closing message_delta can settle the bill.
    const estimatedInputTokens = this.estimateRequestInputTokens(dto)
    const cacheProfile = this.cacheTracker.buildProfile(
      dto,
      estimatedInputTokens
    )
    const cacheUsage = this.cacheTracker.compute(account.stateKey, cacheProfile)

    const events: string[] = []
    const eventQueue: Array<{ resolve?: () => void }> = []
    let finished = false
    let streamError: Error | null = null

    const emit = (event: string) => {
      events.push(event)
      const waiter = eventQueue.shift()
      if (waiter?.resolve) waiter.resolve()
    }

    const waitForNext = () =>
      new Promise<void>((resolve) => {
        eventQueue.push({ resolve })
      })

    const buildUsageObject = (
      inputTokens: number,
      outputTokens: number
    ): Record<string, unknown> => {
      const billed = billedKiroInputTokens(inputTokens, cacheUsage)
      const usage: Record<string, unknown> = {
        input_tokens: billed,
        output_tokens: outputTokens,
      }
      if (cacheProfile != null) {
        usage["cache_read_input_tokens"] = cacheUsage.cacheReadInputTokens
        usage["cache_creation_input_tokens"] =
          cacheUsage.cacheCreationInputTokens
        usage["cache_creation"] = {
          ephemeral_5m_input_tokens: cacheUsage.cacheCreation5mInputTokens,
          ephemeral_1h_input_tokens: cacheUsage.cacheCreation1hInputTokens,
        }
      }
      return usage
    }

    // Initial Claude SSE preamble. The opening message_start carries the
    // cache_read_input_tokens so clients that bill on the initial event
    // (e.g. Cursor's usage panel) get the right numbers right away.
    emit(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: buildUsageObject(estimatedInputTokens, 0),
        },
      })
    )

    let textBlockOpen = false
    let thinkingBlockOpen = false
    let textBlockIndex = 0
    let blockCounter = 0
    const toolUseBlockMeta = new Map<string, number>()
    let collectedInput = 0
    let collectedOutput = 0

    const closeTextBlock = () => {
      if (!textBlockOpen) return
      emit(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: textBlockIndex,
        })
      )
      textBlockOpen = false
    }

    const closeThinkingBlock = () => {
      if (!thinkingBlockOpen) return
      emit(
        sseEvent("content_block_stop", {
          type: "content_block_stop",
          index: textBlockIndex,
        })
      )
      thinkingBlockOpen = false
    }

    const callback: KiroStreamCallback = {
      onText: (text, isThinking) => {
        if (isThinking) {
          if (textBlockOpen) closeTextBlock()
          if (!thinkingBlockOpen) {
            textBlockIndex = blockCounter++
            thinkingBlockOpen = true
            emit(
              sseEvent("content_block_start", {
                type: "content_block_start",
                index: textBlockIndex,
                content_block: { type: "thinking", thinking: "" },
              })
            )
          }
          emit(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: textBlockIndex,
              delta: { type: "thinking_delta", thinking: text },
            })
          )
        } else {
          if (thinkingBlockOpen) closeThinkingBlock()
          if (!textBlockOpen) {
            textBlockIndex = blockCounter++
            textBlockOpen = true
            emit(
              sseEvent("content_block_start", {
                type: "content_block_start",
                index: textBlockIndex,
                content_block: { type: "text", text: "" },
              })
            )
          }
          emit(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: textBlockIndex,
              delta: { type: "text_delta", text },
            })
          )
        }
      },
      onToolUse: (tu) => {
        if (textBlockOpen) closeTextBlock()
        if (thinkingBlockOpen) closeThinkingBlock()
        // 工具名按原样透传（与抓包一致），无需反向映射。
        const idx = blockCounter++
        toolUseBlockMeta.set(tu.toolUseId, idx)
        emit(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: {
              type: "tool_use",
              id: tu.toolUseId,
              name: tu.name,
              input: {},
            },
          })
        )
        emit(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(tu.input),
            },
          })
        )
        emit(
          sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: idx,
          })
        )
      },
      onComplete: (input, output) => {
        collectedInput = input
        collectedOutput = output
      },
    }

    const runner = (async () => {
      let completedNormally = false
      try {
        const result = await this.callKiro(dto, account, callback, abortSignal)
        // If callKiro switched accounts mid-flight, update for cache tracking.
        if (result.account.stateKey !== account.stateKey) {
          account = result.account
        }
        // Persist the breakpoints only after a successful response so a
        // failed turn does not poison the cache state of this account.
        this.cacheTracker.update(account.stateKey, cacheProfile)
        completedNormally = true
      } catch (error) {
        streamError = error as Error
      } finally {
        // Always close any opened content blocks to keep block_start /
        // block_stop frames balanced — the consumer's SSE parser treats
        // an unbalanced frame count as a protocol violation regardless
        // of whether the turn succeeded or errored.
        if (textBlockOpen) closeTextBlock()
        if (thinkingBlockOpen) closeThinkingBlock()

        // CRITICAL: only emit message_delta + message_stop when the
        // upstream stream actually finished. On error, emitting these
        // looks to CC CLI like a well-formed `stop_reason: end_turn`
        // turn with empty content — the compact summary path then
        // accepts the empty assistant text as success, replaces history
        // with an empty <summary>, and the next turn immediately
        // recreates the over-cap condition. The error path must let
        // the BackendApiError surface so the controller can render an
        // SSE `event: error` instead, which CC CLI maps to either a
        // PTL retry (truncateHeadForPTLRetry, MAX_PTL_RETRIES=3) or a
        // visible "Failed to generate conversation summary" failure —
        // both safe outcomes vs. silent corruption.
        if (completedNormally) {
          if (collectedInput <= 0) {
            collectedInput = estimatedInputTokens
          }
          const stopReason = toolUseBlockMeta.size > 0 ? "tool_use" : "end_turn"
          emit(
            sseEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: buildUsageObject(collectedInput, collectedOutput),
            })
          )
          emit(sseEvent("message_stop", { type: "message_stop" }))
        }
        finished = true
        const waiter = eventQueue.shift()
        if (waiter?.resolve) waiter.resolve()
      }
    })()

    try {
      while (true) {
        if (events.length > 0) {
          yield events.shift()!
          continue
        }
        if (finished) break
        await waitForNext()
      }
      while (events.length > 0) {
        yield events.shift()!
      }
    } finally {
      try {
        await runner
      } catch {
        // already captured into streamError
      }
      this.getStreamUsageRecord(
        account,
        dto,
        collectedInput,
        collectedOutput,
        Date.now() - startedAt,
        cacheUsage
      )
    }

    if (streamError) {
      throw streamError as Error
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────

  private applyPersistedAccountState(
    account: KiroAccount,
    state?: PersistedKiroAccountState
  ): void {
    if (!state) return
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
      for (const ms of state.modelStates) {
        if (
          !ms ||
          typeof ms.model !== "string" ||
          typeof ms.cooldownUntil !== "number" ||
          ms.cooldownUntil <= now
        ) {
          continue
        }
        account.modelStates.set(ms.model, {
          cooldownUntil: ms.cooldownUntil,
          quotaExhausted: !!ms.quotaExhausted,
          backoffLevel:
            typeof ms.backoffLevel === "number" ? ms.backoffLevel : 0,
        })
      }
    }
  }

  private serializeAccountState(
    account: KiroAccount
  ): PersistedKiroAccountState | null {
    if (
      !isAccountDisabled(account) &&
      account.cooldownUntil <= 0 &&
      account.modelStates.size === 0
    ) {
      return null
    }
    const record: PersistedKiroAccountState = {
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
        ([model, state]) => ({
          model,
          cooldownUntil: state.cooldownUntil,
          quotaExhausted: state.quotaExhausted,
          backoffLevel: state.backoffLevel,
        })
      )
    }
    return record
  }

  private persistAccountStates(): void {
    this.accountStateStore.replaceStates(
      "kiro",
      this.accounts
        .map((account) => this.serializeAccountState(account))
        .filter((record): record is PersistedKiroAccountState => record != null)
    )
  }

  // ── Account file helpers (sync / login support) ────────────────────────

  /** Resolve the canonical accounts JSON path (cached after first load). */
  private getAccountsFilePath(): string {
    return (
      this.accountsConfigPath ||
      resolveDefaultAccountConfigPath("kiro-accounts.json")
    )
  }

  private getLocalLoginTargetsPath(): string {
    return path.join(
      path.dirname(this.getAccountsFilePath()),
      "kiro-local-login-targets.json"
    )
  }

  private readLocalLoginTargets(): KiroLocalLoginTargetsFile {
    const filePath = this.getLocalLoginTargetsPath()
    if (!fs.existsSync(filePath)) return {}
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as KiroLocalLoginTargetsFile
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch (error) {
      this.logger.warn(
        `[Kiro] Failed to read local login targets: ${(error as Error).message}`
      )
      return {}
    }
  }

  private writeLocalLoginTargets(targets: KiroLocalLoginTargetsFile): void {
    const filePath = this.getLocalLoginTargetsPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(targets, null, 2) + "\n", {
      mode: 0o600,
    })
  }

  private rememberLocalLoginTarget(
    kind: KiroLocalLoginKind,
    account: KiroAccount
  ): void {
    const targets = this.readLocalLoginTargets()
    targets[kind] = {
      authMethod: account.authMethod,
      region: account.region,
      stateKey: account.stateKey,
      clientId: account.clientId,
      label: account.label,
      updatedAt: new Date().toISOString(),
    }
    this.writeLocalLoginTargets(targets)
  }

  private accountMatchesLocalLoginTarget(
    account: KiroAccount,
    target: KiroLocalLoginTarget | undefined
  ): boolean {
    if (!target) return false
    if (account.authMethod !== target.authMethod) return false
    const normalize = (value: unknown) =>
      typeof value === "string" ? value.trim() : ""
    const accountRegion = normalize(account.region || "us-east-1")
    const targetRegion = normalize(target.region || "us-east-1")
    if (accountRegion !== targetRegion) return false
    if (target.stateKey && target.stateKey === account.stateKey) return true
    if (target.clientId && target.clientId === account.clientId) return true
    return !!target.label && target.label === account.label
  }

  private buildLocalLoginExportInput(account: KiroAccount): KiroIdeExportInput {
    return {
      authMethod: account.authMethod === "social" ? "social" : "idc",
      region: account.region,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      profileArn: account.profileArn,
      provider: account.provider,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      registrationExpiresAt: account.registrationExpiresAt,
    }
  }

  private mirrorLocalLoginsIfSelected(account: KiroAccount): void {
    if (account.authMethod === "api_key") return
    if (!account.accessToken || !account.refreshToken) return

    const targets = this.readLocalLoginTargets()
    const exportInput = this.buildLocalLoginExportInput(account)

    if (this.accountMatchesLocalLoginTarget(account, targets.ide)) {
      try {
        writeKiroIdeLogin(exportInput)
        this.logger.log(
          `[Kiro] Mirrored refreshed token into local Kiro IDE for ${account.label || account.stateKey.slice(0, 12)}`
        )
      } catch (error) {
        this.logger.warn(
          `[Kiro] Failed to mirror refreshed token into local Kiro IDE: ${(error as Error).message}`
        )
      }
    }

    if (this.accountMatchesLocalLoginTarget(account, targets.cli)) {
      try {
        writeKiroCliLogin(exportInput)
        this.logger.log(
          `[Kiro] Mirrored refreshed token into local Kiro CLI for ${account.label || account.stateKey.slice(0, 12)}`
        )
      } catch (error) {
        this.logger.warn(
          `[Kiro] Failed to mirror refreshed token into local Kiro CLI: ${(error as Error).message}`
        )
      }
    }
  }

  /** Read the accounts JSON file as a list, returning [] when missing. */
  private readAccountsFile(): KiroAccountFileEntry[] {
    const filePath = this.getAccountsFilePath()
    if (!fs.existsSync(filePath)) return []
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as KiroAccountConfigFile
      return Array.isArray(parsed.accounts) ? parsed.accounts : []
    } catch (error) {
      this.logger.warn(
        `Failed to parse ${filePath}: ${(error as Error).message}`
      )
      return []
    }
  }

  /** Persist the account list to the canonical accounts JSON path. */
  private writeAccountsFile(entries: KiroAccountFileEntry[]): void {
    const filePath = this.getAccountsFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      JSON.stringify({ accounts: entries }, null, 2) + "\n"
    )
    this.accountsConfigPath = filePath
  }

  /** Refresh the in-memory account list from disk after a sync/login. */
  private reloadAccounts(): void {
    const fresh = this.loadAllAccountsFromFile()
    const persisted = this.accountStateStore.loadStates("kiro")
    for (const account of fresh) {
      this.applyPersistedAccountState(account, persisted.get(account.stateKey))
    }
    this.accounts = fresh
    this.deduplicateAccountLabels()
    this.persistAccountStates()
  }

  /**
   * Background token refresh loop — runs every 15 minutes.
   * Mirrors Kiro-Go's `backgroundRefresh` goroutine.
   * Refreshes tokens proactively and persists them to disk so the next
   * bridge restart has fresh credentials.
   */
  private startBackgroundRefresh(): void {
    const INTERVAL_MS = 15 * 60_000 // 15 minutes
    const loop = async () => {
      for (const account of this.accounts) {
        if (isAccountDisabled(account)) continue
        if (!account.refreshToken) continue
        const nowSec = Math.floor(Date.now() / 1000)
        const needsRefresh =
          !account.accessToken ||
          (account.expiresAt > 0 &&
            nowSec >= account.expiresAt - TOKEN_REFRESH_SKEW_SECONDS)
        if (!needsRefresh) continue

        try {
          const result = await refreshKiroToken({
            authMethod: account.authMethod,
            refreshToken: account.refreshToken,
            clientId: account.clientId,
            clientSecret: account.clientSecret,
            region: account.region,
            proxyUrl: account.proxyUrl,
          })
          account.accessToken = result.accessToken
          account.refreshToken = result.refreshToken
          account.expiresAt = result.expiresAt
          if (result.profileArn) {
            account.profileArn = result.profileArn
          }
          // Persist refreshed token to disk so next restart has fresh creds.
          this.persistTokenToDisk(account)
          this.mirrorLocalLoginsIfSelected(account)
          this.logger.log(
            `[Kiro] Background refresh OK: ${account.label || account.stateKey.slice(0, 12)} (expires=${new Date(result.expiresAt * 1000).toISOString()})`
          )
        } catch (error) {
          this.logger.warn(
            `[Kiro] Background refresh failed for ${account.label || account.stateKey.slice(0, 12)}: ${(error as Error).message}`
          )
        }
      }
    }
    setInterval(() => void loop(), INTERVAL_MS)
  }

  /**
   * Write the refreshed token back to kiro-accounts.json so the next
   * bridge restart picks up fresh credentials.
   */
  private persistTokenToDisk(account: KiroAccount): void {
    try {
      const entries = this.readAccountsFile()
      const idx = this.findMatchingEntryIndex(entries, {
        authMethod: account.authMethod,
        region: account.region,
        refreshToken: account.refreshToken,
        accessToken: account.accessToken,
        clientId: account.clientId,
      })
      if (idx >= 0) {
        entries[idx] = {
          ...entries[idx],
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          expiresAt: account.expiresAt,
          profileArn: account.profileArn,
          registrationExpiresAt: account.registrationExpiresAt,
        }
        this.writeAccountsFile(entries)
      }
    } catch (error) {
      this.logger.warn(
        `[Kiro] Failed to persist refreshed token: ${(error as Error).message}`
      )
    }
  }

  /** Fetch and cache the available model list from the Kiro API. */
  private async refreshDiscoveredModels(account: KiroAccount): Promise<void> {
    try {
      const models = await listKiroAvailableModels({
        accessToken: account.accessToken,
        machineId: account.machineId,
        proxyUrl: account.proxyUrl,
        client: account.client,
        profileArn: account.profileArn,
        tokenType: account.authMethod === "api_key" ? "API_KEY" : undefined,
      })
      if (models.length > 0) {
        this.discoveredModels = models
        this.discoveredModelsFetchedAt = Date.now()
        this.logger.log(
          `  [Kiro] Discovered ${models.length} model(s): ${models.map((m) => m.modelId).join(", ")}`
        )
      }
    } catch (error) {
      this.logger.warn(
        `  [Kiro] Model discovery failed: ${(error as Error).message}`
      )
    }
  }

  /** Drop expired device-auth sessions from the in-memory map. */
  private evictExpiredDeviceSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.deviceAuthSessions.entries()) {
      if (session.expiresAt <= now) {
        this.deviceAuthSessions.delete(id)
      }
    }
  }

  /**
   * Match an existing entry by `(authMethod, region, refreshToken|accessToken)`
   * — the same triple we use to build `stateKey`.
   *
   * `authMethod` is a hard filter: a Kiro IDE social refresh token MUST NOT
   * match an old Builder ID entry (or vice-versa) even if they happen to
   * share a refresh token / accessToken / clientId field.  When the user
   * switches identity, we want a clean overwrite — not a merge that keeps
   * the stale `clientId/clientSecret/profileArn`.
   */
  private findMatchingEntryIndex(
    entries: KiroAccountFileEntry[],
    candidate: {
      authMethod: KiroAuthMethod
      region: string
      refreshToken?: string
      accessToken?: string
      clientId?: string
      kiroApiKey?: string
    }
  ): number {
    const normalize = (value: unknown) =>
      typeof value === "string" ? value.trim() : ""
    const wantRefresh = normalize(candidate.refreshToken)
    const wantAccess = normalize(candidate.accessToken)
    const wantApiKey = normalize(candidate.kiroApiKey)

    return entries.findIndex((entry) => {
      const entryAuth: KiroAuthMethod =
        entry.authMethod === "api_key" || entry.authMethod === "apikey"
          ? "api_key"
          : entry.authMethod === "social"
            ? "social"
            : "idc"
      if (entryAuth !== candidate.authMethod) return false
      if (
        normalize(entry.region || "us-east-1") !==
        normalize(candidate.region || "us-east-1")
      ) {
        return false
      }
      // API key accounts are identified solely by the kiroApiKey value.
      if (candidate.authMethod === "api_key") {
        const entryApiKey = normalize(entry.kiroApiKey)
        return wantApiKey !== "" && wantApiKey === entryApiKey
      }
      const entryRefresh = normalize(entry.refreshToken)
      const entryAccess = normalize(entry.accessToken)
      if (wantRefresh && entryRefresh && wantRefresh === entryRefresh) {
        return true
      }
      if (wantAccess && entryAccess && wantAccess === entryAccess) {
        return true
      }
      // For IdC accounts a stable clientId is enough to pin the identity;
      // for social accounts there is no such anchor so we require token
      // match above.
      if (candidate.authMethod !== "idc") return false
      const wantClient = normalize(candidate.clientId)
      const entryClient = normalize(entry.clientId)
      return wantClient !== "" && wantClient === entryClient
    })
  }

  /** Upsert a discovered local cache entry into the accounts file. */
  private upsertAccountFromDiscovered(
    token: DiscoveredKiroToken
  ): Promise<boolean> {
    let entries = this.readAccountsFile()

    // If the user just switched identity (e.g. logged out of Builder ID and
    // back in via Google), there may still be a stale opposite-authMethod
    // entry that points at the SAME Kiro account.  We can't know that from
    // tokens alone, but if the previous entry only differs from the new
    // one by authMethod (same region, same accessToken or refreshToken) we
    // drop it so the dashboard does not display a phantom IdC row anymore.
    const oppositeAuth: KiroAuthMethod =
      token.authMethod === "idc" ? "social" : "idc"
    const staleIdx = this.findMatchingEntryIndex(entries, {
      authMethod: oppositeAuth,
      region: token.region,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
    })
    if (staleIdx >= 0) {
      this.logger.log(
        `[Kiro] Removing stale ${oppositeAuth} entry shadowed by new ${token.authMethod} login`
      )
      entries = entries.filter((_, i) => i !== staleIdx)
    }

    const idx = this.findMatchingEntryIndex(entries, {
      authMethod: token.authMethod,
      region: token.region,
      refreshToken: token.refreshToken,
      accessToken: token.accessToken,
      clientId: token.clientId,
    })

    const existing = idx >= 0 ? entries[idx] : undefined
    const defaultLabel =
      token.authMethod === "idc"
        ? "Kiro Builder ID"
        : token.provider
          ? `Kiro Social (${token.provider})`
          : "Kiro Social"

    // Build the merged entry from scratch with explicit field-by-field
    // selection so social entries cannot inherit stale idc fields and
    // vice-versa.  Mutable fields (label/proxyUrl/priority/etc.) are
    // preserved from the existing entry; identity fields are overwritten.
    const merged: KiroAccountFileEntry = {
      label: existing?.label || defaultLabel,
      authMethod: token.authMethod,
      region: token.region,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt || undefined,
      registrationExpiresAt:
        token.registrationExpiresAt || existing?.registrationExpiresAt,
      profileArn: token.profileArn || existing?.profileArn,
      provider: token.provider || existing?.provider,
      machineId: existing?.machineId,
      proxyUrl: existing?.proxyUrl,
      maxContextTokens: existing?.maxContextTokens,
      priority: existing?.priority,
      preferredEndpoint: existing?.preferredEndpoint,
      endpointFallback: existing?.endpointFallback,
      kiroVersion: existing?.kiroVersion,
      systemVersion: existing?.systemVersion,
      nodeVersion: existing?.nodeVersion,
    }
    if (token.authMethod === "idc") {
      merged.clientId = token.clientId
      merged.clientSecret = token.clientSecret
    }

    if (idx >= 0) {
      entries[idx] = merged
    } else {
      entries.push(merged)
    }
    this.writeAccountsFile(entries)
    this.logger.log(
      `[Kiro] Synced ${token.authMethod} account from local cache (${path.basename(token.sourcePath)}, region=${token.region}${token.provider ? `, provider=${token.provider}` : ""})`
    )
    return Promise.resolve(true)
  }

  /** Persist a freshly minted Builder ID token. */
  private upsertAccountFromBuilderId(
    result: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      clientId: string
      clientSecret: string
      registrationExpiresAt?: number
      region: string
    },
    session: KiroDeviceAuthSession
  ): void {
    const entries = this.readAccountsFile()
    const idx = this.findMatchingEntryIndex(entries, {
      authMethod: "idc",
      region: result.region,
      refreshToken: result.refreshToken,
      accessToken: result.accessToken,
      clientId: result.clientId,
    })

    const merged: KiroAccountFileEntry = {
      ...(idx >= 0 ? entries[idx] : {}),
      label:
        (idx >= 0 && entries[idx]!.label) ||
        `Kiro Builder ID (${session.userCode})`,
      authMethod: "idc",
      region: result.region,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      clientId: result.clientId,
      clientSecret: result.clientSecret,
      registrationExpiresAt: result.registrationExpiresAt,
    }
    if (idx >= 0) {
      entries[idx] = merged
    } else {
      entries.push(merged)
    }
    this.writeAccountsFile(entries)
    this.logger.log(
      `[Kiro] Builder ID login completed; account written to ${this.getAccountsFilePath()}`
    )
  }

  /** Flatten a manual paste into a list of account-shaped candidates. */
  private flattenManualPayload(payload: unknown): KiroAccountFileEntry[] {
    const candidates: KiroAccountFileEntry[] = []

    const pushIfShaped = (value: unknown): void => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return
      const obj = value as Record<string, unknown>
      const access = typeof obj.accessToken === "string" ? obj.accessToken : ""
      const refresh =
        typeof obj.refreshToken === "string" ? obj.refreshToken : ""
      const apiKey = typeof obj.kiroApiKey === "string" ? obj.kiroApiKey : ""
      const authMethodRaw =
        typeof obj.authMethod === "string" ? obj.authMethod : undefined
      const isApiKey =
        authMethodRaw === "api_key" ||
        authMethodRaw === "apikey" ||
        (apiKey && !access && !refresh)
      if (!isApiKey && !access && !refresh) return
      candidates.push({
        label: typeof obj.label === "string" ? obj.label : undefined,
        authMethod: isApiKey ? "api_key" : authMethodRaw,
        region: typeof obj.region === "string" ? obj.region : undefined,
        accessToken: access,
        refreshToken: refresh,
        kiroApiKey: apiKey || undefined,
        expiresAt:
          typeof obj.expiresAt === "number" ? obj.expiresAt : undefined,
        clientId: typeof obj.clientId === "string" ? obj.clientId : undefined,
        clientSecret:
          typeof obj.clientSecret === "string" ? obj.clientSecret : undefined,
        proxyUrl: typeof obj.proxyUrl === "string" ? obj.proxyUrl : undefined,
      })
    }

    if (Array.isArray(payload)) {
      for (const item of payload) pushIfShaped(item)
      return candidates
    }
    if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>
      if (Array.isArray(obj.accounts)) {
        for (const item of obj.accounts) pushIfShaped(item)
        return candidates
      }
      pushIfShaped(payload)
    }
    return candidates
  }

  /** Upsert a single manually pasted entry; returns true on change. */
  private upsertAccountFromManualEntry(
    candidate: KiroAccountFileEntry
  ): boolean {
    const entries = this.readAccountsFile()
    const apiKey = (candidate.kiroApiKey || "").trim()
    const refresh = (candidate.refreshToken || "").trim()
    const access = (candidate.accessToken || "").trim()
    const isApiKey =
      candidate.authMethod === "api_key" ||
      candidate.authMethod === "apikey" ||
      (apiKey && !refresh && !access)
    const authMethod: KiroAuthMethod = isApiKey
      ? "api_key"
      : candidate.authMethod === "social"
        ? "social"
        : "idc"
    const region = (candidate.region || "us-east-1").trim() || "us-east-1"
    if (isApiKey) {
      if (!apiKey) return false
    } else if (!refresh && !access) {
      return false
    }

    const idx = this.findMatchingEntryIndex(entries, {
      authMethod,
      region,
      refreshToken: refresh,
      accessToken: access,
      clientId: candidate.clientId,
      kiroApiKey: apiKey,
    })

    const fallbackLabel = isApiKey
      ? "Kiro API Key"
      : authMethod === "idc"
        ? "Kiro Builder ID"
        : "Kiro Social"

    const merged: KiroAccountFileEntry = {
      ...(idx >= 0 ? entries[idx] : {}),
      label:
        candidate.label ||
        (idx >= 0 ? entries[idx]!.label : undefined) ||
        fallbackLabel,
      authMethod,
      region,
      accessToken: isApiKey
        ? undefined
        : access || (idx >= 0 ? entries[idx]!.accessToken : undefined),
      refreshToken: isApiKey
        ? undefined
        : refresh || (idx >= 0 ? entries[idx]!.refreshToken : undefined),
      kiroApiKey: isApiKey
        ? apiKey
        : idx >= 0
          ? entries[idx]!.kiroApiKey
          : undefined,
      expiresAt: isApiKey
        ? undefined
        : candidate.expiresAt ||
          (idx >= 0 ? entries[idx]!.expiresAt : undefined),
      clientId: isApiKey
        ? undefined
        : candidate.clientId || (idx >= 0 ? entries[idx]!.clientId : undefined),
      clientSecret: isApiKey
        ? undefined
        : candidate.clientSecret ||
          (idx >= 0 ? entries[idx]!.clientSecret : undefined),
      proxyUrl:
        candidate.proxyUrl || (idx >= 0 ? entries[idx]!.proxyUrl : undefined),
    }

    if (idx >= 0) {
      entries[idx] = merged
    } else {
      entries.push(merged)
    }
    this.writeAccountsFile(entries)
    return true
  }
}

function sseEvent(eventName: string, data: Record<string, unknown>): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`
}

function parseSubscriptionType(raw: string): string {
  const upper = (raw || "").toUpperCase()
  if (upper.includes("PRO_PLUS") || upper.includes("PROPLUS")) return "PRO_PLUS"
  if (upper.includes("POWER")) return "POWER"
  if (upper.includes("PRO")) return "PRO"
  return "FREE"
}

function nextEndpointQuotaCooldown(backoffLevel: number): number {
  const delay = ENDPOINT_QUOTA_BACKOFF_BASE_MS * Math.pow(2, backoffLevel)
  return Math.min(delay, ENDPOINT_QUOTA_BACKOFF_MAX_MS)
}

function parseEndpointRetryAfterMs(
  retryAfterHeader: string,
  defaultMs: number
): number {
  const seconds = Number.parseFloat(retryAfterHeader)
  if (!Number.isFinite(seconds) || seconds <= 0) return defaultMs
  return Math.ceil(seconds * 1000)
}

function formatEndpointDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
