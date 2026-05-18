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
  getAccountConfigPathCandidates,
  resolveDefaultAccountConfigPath,
} from "../../shared/protocol-bridge-paths"
import { UsageStatsService } from "../../usage"
import {
  clearAccountDisablement,
  getEarliestRecovery,
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
  BackendAccountPoolUnavailableError,
  BackendApiError,
} from "../shared/backend-errors"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
} from "../shared/backend-pool-status"
import { canPublicClaudeModelUseKiro } from "../shared/model-registry"
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
  discoverLocalKiroTokens,
  type DiscoveredKiroToken,
} from "./local-import"
import { refreshKiroToken, type KiroAuthMethod } from "./oidc"
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
  region: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId?: string
  clientSecret?: string
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

/** Fallback model IDs used when dynamic discovery has not yet completed. */
const FALLBACK_KIRO_MODEL_IDS: string[] = [
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
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
  }

  isAvailable(): boolean {
    return this.accounts.some((account) => !isAccountDisabled(account))
  }

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  supportsModel(model: string): boolean {
    if (!this.isAvailable()) return false
    const normalizedModel = model.toLowerCase().trim()
    // Check dynamic model list first (exact match on Kiro model IDs).
    if (this.discoveredModels.length > 0) {
      if (
        this.discoveredModels.some(
          (m) => m.modelId.toLowerCase() === normalizedModel
        )
      ) {
        return true
      }
      // Also check after mapping through the Kiro model name translator
      // (e.g. "claude-opus-4-7-thinking" -> "claude-opus-4.7").
      const mapped = mapKiroModel(normalizedModel).toLowerCase()
      if (
        this.discoveredModels.some((m) => m.modelId.toLowerCase() === mapped)
      ) {
        return true
      }
    }
    // Fallback to static Claude model check.
    return canPublicClaudeModelUseKiro(model)
  }

  getConfiguredMaxContextTokens(model: string): number | undefined {
    if (!this.supportsModel(model)) return undefined
    // Check discovered model token limits first.
    const normalizedModel = model.toLowerCase().trim()
    const discovered = this.discoveredModels.find(
      (m) => m.modelId.toLowerCase() === normalizedModel
    )
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

      let state: BackendPoolEntryState = "ready"
      if (isAccountDisabled(account)) state = "disabled"
      else if (account.cooldownUntil > now) state = "cooldown"
      else if (modelCooldowns.length > 0) state = "model_cooldown"

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
    const account = this.pickAccountOrThrow(dto.model)
    return this.executeNonStream(dto, account)
  }

  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const account = this.pickAccountOrThrow(dto.model)
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
      client: {
        kiroVersion: entry.kiroVersion,
        systemVersion: entry.systemVersion,
        nodeVersion: entry.nodeVersion,
      },
      kiroApiKey: authMethod === "api_key" ? kiroApiKey : undefined,
      cooldownUntil: 0,
      modelStates: new Map(),
    }
  }

  // ── Account selection ──────────────────────────────────────────────────

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
   */
  private findAvailableAccount(
    model: string,
    options?: { exclude?: Set<string>; startOffset?: number; now?: number }
  ): KiroAccount | null {
    if (this.accounts.length === 0) return null
    const now = options?.now ?? Date.now()
    const exclude = options?.exclude
    const startOffset = options?.startOffset ?? 0
    for (let offset = 0; offset < this.accounts.length; offset++) {
      const idx =
        (this.accountIndex + startOffset + offset) % this.accounts.length
      const account = this.accounts[idx]!
      if (exclude && exclude.has(account.stateKey)) continue
      if (isAccountAvailableForModel(account, model, now)) {
        return account
      }
    }
    return null
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

    const recovery = getEarliestRecovery(this.accounts, model)
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
        this.logger.log(
          `[Kiro] Resolved profileArn for ${account.label || account.stateKey.slice(0, 12)}`
        )
      }
    } catch (error) {
      this.logger.debug?.(
        `[Kiro] ListAvailableProfiles failed for ${account.label || ""}: ${(error as Error).message}`
      )
    }
  }

  // ── Endpoint helpers ────────────────────────────────────────────────────

  private getOrderedEndpoints(account: KiroAccount): KiroEndpoint[] {
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

  private prepareThinking(dto: CreateMessageDto): boolean {
    const intent = dto._thinkingIntent
    if (intent && intent.mode !== "disabled") return true
    if (
      dto.thinking &&
      typeof dto.thinking === "object" &&
      typeof dto.thinking.type === "string"
    ) {
      const type = dto.thinking.type.toLowerCase()
      if (type === "enabled" || type === "adaptive" || type === "auto")
        return true
    }
    return /thinking/.test((dto.model || "").toLowerCase())
  }

  private buildKiroPayload(
    dto: CreateMessageDto,
    account: KiroAccount
  ): KiroPayload {
    const thinking = this.prepareThinking(dto)
    const payload = claudeToKiro(dto, {
      thinking,
      profileArn: account.profileArn,
      conversationId: (dto._conversationId || "").trim() || undefined,
    })
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
    const model = mapKiroModel(dto.model || "")
    let lastError: Error | null = null
    const MAX_RETRIES = 10
    const BASE_DELAY_MS = 3000
    /** Accounts that have been tried and failed with auth errors this call. */
    const attemptedAccountKeys = new Set<string>()
    /** Accounts that have already been force-refreshed this call (max once per account). */
    const forceRefreshedKeys = new Set<string>()

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Before waiting, try to switch to a different account if available.
        const alternate = this.findAvailableAccount(model, {
          exclude: attemptedAccountKeys,
        })
        if (alternate && alternate.stateKey !== currentAccount.stateKey) {
          this.logger.log(
            `[Kiro] Switching from ${this.accountTag(currentAccount)} to ${this.accountTag(alternate)} after auth failure`
          )
          currentAccount = alternate
          await this.ensureFreshToken(currentAccount)
          await this.ensureProfileArn(currentAccount)
        } else {
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
            throw lastError || new Error("Kiro request aborted")
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
      const orderedEndpoints = this.getOrderedEndpoints(currentAccount)

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

        const fetchOptions: RequestInit & { dispatcher?: unknown } = {
          method: "POST",
          headers: baseHeaders,
          signal: abortSignal ?? AbortSignal.timeout(STREAM_REQUEST_TIMEOUT_MS),
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
            markAccountCooldown(
              currentAccount,
              429,
              model,
              response.headers.get("retry-after") || undefined,
              this.accountTag(currentAccount)
            )
            this.persistAccountStates()
            this.logger.warn(
              `[Kiro] Endpoint ${endpoint.name} quota exhausted (429) for ${this.accountTag(currentAccount)}; trying next`
            )
            lastError = new BackendApiError(
              `Kiro endpoint ${endpoint.name} returned 429`,
              { backend: "kiro", statusCode: 429 }
            )
            response.body?.cancel().catch(() => undefined)
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
                  const retryFetchOptions: RequestInit & {
                    dispatcher?: unknown
                  } = {
                    method: "POST",
                    headers: retryHeaders,
                    signal:
                      abortSignal ??
                      AbortSignal.timeout(STREAM_REQUEST_TIMEOUT_MS),
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
                    await parseKiroEventStream(
                      retryResponse.body,
                      callback,
                      abortSignal
                    )
                    this.logger.log(
                      `[Kiro] <- ${endpoint.name} stream completed after refresh (account=${this.accountTag(currentAccount)}, model=${model})`
                    )
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
                { backend: "kiro", statusCode: status }
              )
              // Break out of endpoint loop to trigger account switch at top of retry loop.
              break
            }

            // All other non-200: continue to next endpoint.
            lastError = new BackendApiError(
              `Kiro endpoint ${endpoint.name} HTTP ${status}: ${text.slice(0, 200)}`,
              { backend: "kiro", statusCode: status }
            )
            response.body?.cancel().catch(() => undefined)
            continue
          }

          if (!response.body) {
            throw new BackendApiError("Kiro response has no body", {
              backend: "kiro",
              statusCode: 502,
            })
          }

          await parseKiroEventStream(response.body, callback, abortSignal)
          this.logger.log(
            `[Kiro] <- ${endpoint.name} stream completed (account=${this.accountTag(currentAccount)}, model=${model})`
          )
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
            if (error.permanent) throw error
            lastError = error
            continue
          }
          const message = (error as Error).message || String(error)
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
      try {
        const result = await this.callKiro(dto, account, callback, abortSignal)
        // If callKiro switched accounts mid-flight, update for cache tracking.
        if (result.account.stateKey !== account.stateKey) {
          account = result.account
        }
        // Persist the breakpoints only after a successful response so a
        // failed turn does not poison the cache state of this account.
        this.cacheTracker.update(account.stateKey, cacheProfile)
      } catch (error) {
        streamError = error as Error
      } finally {
        if (textBlockOpen) closeTextBlock()
        if (thinkingBlockOpen) closeThinkingBlock()

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
    }
  ): number {
    const normalize = (value: unknown) =>
      typeof value === "string" ? value.trim() : ""
    const wantRefresh = normalize(candidate.refreshToken)
    const wantAccess = normalize(candidate.accessToken)

    return entries.findIndex((entry) => {
      const entryAuth = entry.authMethod === "social" ? "social" : "idc"
      if (entryAuth !== candidate.authMethod) return false
      if (
        normalize(entry.region || "us-east-1") !==
        normalize(candidate.region || "us-east-1")
      ) {
        return false
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
      if (!access && !refresh) return
      candidates.push({
        label: typeof obj.label === "string" ? obj.label : undefined,
        authMethod:
          typeof obj.authMethod === "string" ? obj.authMethod : undefined,
        region: typeof obj.region === "string" ? obj.region : undefined,
        accessToken: access,
        refreshToken: refresh,
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
    const authMethod: KiroAuthMethod =
      candidate.authMethod === "social" ? "social" : "idc"
    const region = (candidate.region || "us-east-1").trim() || "us-east-1"
    const refresh = (candidate.refreshToken || "").trim()
    const access = (candidate.accessToken || "").trim()
    if (!refresh && !access) return false

    const idx = this.findMatchingEntryIndex(entries, {
      authMethod,
      region,
      refreshToken: refresh,
      accessToken: access,
      clientId: candidate.clientId,
    })

    const merged: KiroAccountFileEntry = {
      ...(idx >= 0 ? entries[idx] : {}),
      label:
        candidate.label ||
        (idx >= 0 ? entries[idx]!.label : undefined) ||
        (authMethod === "idc" ? "Kiro Builder ID" : "Kiro Social"),
      authMethod,
      region,
      accessToken: access || (idx >= 0 ? entries[idx]!.accessToken : undefined),
      refreshToken:
        refresh || (idx >= 0 ? entries[idx]!.refreshToken : undefined),
      expiresAt:
        candidate.expiresAt || (idx >= 0 ? entries[idx]!.expiresAt : undefined),
      clientId:
        candidate.clientId || (idx >= 0 ? entries[idx]!.clientId : undefined),
      clientSecret:
        candidate.clientSecret ||
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
