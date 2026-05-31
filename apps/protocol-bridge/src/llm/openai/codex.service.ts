/**
 * CodexService — Core executor for Codex (OpenAI Responses API) reverse proxy.
 *
 * Handles:
 * - Claude → Codex request translation
 * - HTTP POST to Codex upstream (SSE streaming)
 * - WebSocket transport (with automatic fallback to HTTP)
 * - Codex SSE → Claude SSE response translation
 * - Non-streaming mode
 * - Proxy support (HTTP/HTTPS/SOCKS5)
 * - Request header emulation matching CLIProxyAPI Codex behavior
 * - OAuth token management with auto-refresh
 * - Prompt caching via Conversation_id/Session_id headers
 * - Retry-after handling for rate limits
 *
 * Ported from CLIProxyAPI:
 *   - internal/runtime/executor/codex_executor.go
 *   - internal/runtime/executor/codex_websockets_executor.go
 *   - internal/translator/codex/claude/
 */

import { HttpException, Injectable, Logger, OnModuleInit } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import WebSocket from "ws"
import type {
  ProviderAdapter,
  ProviderWarmupHint,
} from "../shared/provider-adapter.interface"
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
  UpstreamRequestAbortedError,
} from "../shared/abort-signal"
import {
  type CooldownableAccount,
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
import { PersistenceService } from "../../persistence"
import type { CodexReplacementHistoryItem } from "../../context"
import {
  BackendPoolEntryState,
  BackendPoolStatus,
  type CodexRateLimitAccountSummary,
  type CodexRateLimitModelSummary,
  type CodexRateLimitSnapshot,
  type CodexRateLimitSource,
  type CodexRateLimitWindow,
} from "../shared/backend-pool-status"
import {
  CodexModelTier,
  getCodexModelIdsForTier,
  getPublicModelMetadata,
  isChatGptCodexModelSupported,
  normalizeCodexModelTier,
  supportsCodexModelForTier,
} from "../shared/model-registry"
import { CodexAuthService, type CodexTokenData } from "./codex-auth.service"
import { CodexCacheService } from "./codex-cache.service"
import { CodexClientIdentityService } from "./codex-client-identity.service"
import {
  buildCodexHttpHeaders,
  type CodexForwardHeaders,
} from "./codex-header-utils"
import {
  buildCodexRequest,
  extractWarmupPayload,
  type CodexCustomToolCall,
  type CodexExecutionRequest,
  type CodexFunctionCall,
  type CodexInputItem,
  type CodexInputMessage,
  type CodexRequest,
} from "./codex-request-builder"
import { getCodexIncrementalInput } from "./codex-incremental"
import { createCodexExecutionRequestFromClaude } from "./codex-request-translator"
import {
  createStreamState,
  translateCodexSseEvent,
  translateCodexToClaudeNonStream,
} from "./codex-response-translator"
import {
  CodexWebSocketService,
  CodexWebSocketUpgradeError,
} from "./codex-websocket.service"
import { buildReverseMapFromClaudeTools } from "./tool-name-shortener"

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const CODEX_ACCOUNTS_CONFIG_PATHS = getAccountConfigPathCandidates(
  "codex-accounts.json"
)
const CODEX_ACCOUNTS_DEFAULT_PATH = resolveDefaultAccountConfigPath(
  "codex-accounts.json"
)
const CODEX_MODEL_TIER_ORDER: CodexModelTier[] = ["free", "plus", "team", "pro"]
const DEFAULT_CODEX_RATE_LIMIT_MODEL = "gpt-5.5"

export class CodexApiError extends HttpException {
  constructor(
    statusCode: number,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(
      {
        type: "error",
        error: {
          type: "api_error",
          message,
        },
        message,
        ...(retryAfterSeconds != null
          ? { retry_after: retryAfterSeconds }
          : {}),
      },
      statusCode
    )
    this.name = "CodexApiError"
  }
}

// ── Service ────────────────────────────────────────────────────────────

interface PersistedCodexAccountRecord {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: string
  expire?: string
  baseUrl?: string
  proxyUrl?: string
}

interface LoadedCodexAccountRecord extends PersistedCodexAccountRecord {
  configPath: string
}

interface CodexAccountSlot extends CooldownableAccount {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: CodexModelTier
  baseUrl: string
  proxyUrl?: string
  configPath?: string
  source: "env" | "file"
  /** 持久化 disabled 状态的唯一标识 key */
  stateKey: string
  /** Per-slot token data for independent refresh */
  tokenData: CodexTokenData | null
  refreshPromise?: Promise<CodexTokenData | null>
  persistedMatch?: {
    apiKey?: string
    email?: string
    accountId?: string
    accessToken?: string
    refreshToken?: string
  }
  /** Rate limit snapshots from x-codex-* response headers, keyed by model */
  rateLimitSnapshots: Map<
    string,
    Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  >
}

interface ConversationSlotBinding {
  slotKey: string
  expire: number
}

/**
 * Mirrors the official Codex CLI ModelClientSession.
 *
 * Turn-scoped management of WebSocket connection + previous_response_id + request signature.
 * Each turn (executeStreamWithCooldownRetry call) creates a fresh context and disposes
 * it in the finally block, returning the WS connection to cachedWsSessions.
 *
 * This matches the official design:
 *   - "Create a fresh ModelClientSession for each Codex turn. Reusing it across
 *     turns would replay the previous turn's sticky-routing token into the next
 *     turn, which violates the client/server contract" (client.rs:209-211)
 *
 * Cross-turn state preservation:
 *   - lastResponseId is carried across turns (via cachedWsSessions) for incremental append
 *   - request signature is carried with it so the next request can send only the delta
 *
 * Lifecycle:
 *   - Turn start: getOrCreateTurnContext() takes connection from cachedWsSessions
 *   - Turn stream: operates on the context
 *   - Turn end (finally): disposeTurnContext() returns connection to cachedWsSessions
 */
interface CodexTurnContext {
  /** Current WebSocket session ID (key in wsService.sessions) */
  wsSessionId: string
  /** Stable Codex turn metadata key used to scope sticky routing state */
  turnKey: string | undefined
  /** x-codex-turn-state captured from the WebSocket upgrade response */
  turnState: string | undefined
  /** Last completed response metadata used for incremental append */
  lastResponse: CodexLastResponse | undefined
  /** Last full request sent on this WebSocket session */
  lastRequest: Record<string, unknown> | undefined
  /** Whether the connection was reused from cache */
  connectionReused: boolean
}

interface CodexLastResponse {
  responseId: string
  itemsAdded: CodexInputItem[]
}

/** Cross-turn cached WebSocket connection entry, keyed by slotStickyKey + model */
interface CachedWsEntry {
  /** Session ID in wsService */
  wsSessionId: string
  /** Turn metadata key that produced turnState */
  turnKey: string | undefined
  /** x-codex-turn-state captured for this turn only */
  turnState: string | undefined
  /** Last completed response metadata, carried across turns */
  lastResponse: CodexLastResponse | undefined
  /** Last full request sent on this WebSocket session */
  lastRequest: Record<string, unknown> | undefined
  /** Last time this cache entry was used or refreshed */
  updatedAt: number
}

interface WarmupPayloadCacheEntry {
  payload: Record<string, unknown>
  updatedAt: number
}

/**
 * 单一会话状态机条目。
 *
 * 一个 conversationId 对应一个 ConversationCodexSession，承载该会话所有 turn 间共享状态：
 *   - active: 当前 turn 持有的 CodexTurnContext（turn 边界内非空）
 *   - streamTail: turn 串行锁的尾 promise（保证一个 conv 同时只有 1 个 turn 在跑）
 *   - createdAt/updatedAt: 用于 LRU + TTL 清理
 *
 * 不接管的：
 *   - cachedWsSessions: cache key 含 slot+model 维度，跨 conversation 共用；保留独立
 *   - wsService.sessions: 物理 WebSocket 连接层；通过 turnContext.wsSessionId 间接引用
 */
interface ConversationCodexSession {
  conversationId: string
  active: CodexTurnContext | null
  streamTail: Promise<void> | null
  createdAt: number
  updatedAt: number
}

@Injectable()
export class CodexService implements OnModuleInit, ProviderAdapter {
  private readonly logger = new Logger(CodexService.name)

  /** All loaded accounts (round-robin pool) */
  private accounts: CodexAccountSlot[] = []
  /** Round-robin counter */
  private accountIndex = 0
  /** Backing file used for multi-account OAuth persistence */
  private accountsFilePath: string = CODEX_ACCOUNTS_DEFAULT_PATH

  /** Sticky conversation -> account binding to keep cache locality intact. */
  private readonly conversationSlotBindings = new Map<
    string,
    ConversationSlotBinding
  >()

  private configuredModelTier: CodexModelTier | null = null
  private configuredDefaultServiceTier: string | undefined

  /** Whether to prefer WebSocket transport over HTTP */
  private useWebSocket: boolean = false
  private readonly sessionWarmupPromises = new Map<string, Promise<void>>()

  /**
   * Cross-turn cached WebSocket connections, keyed by
   * getCachedWsKey(slot, model, conversationId).
   * Mirrors the official Codex CLI ModelClient.cached_websocket_session.
   * Connections are returned here when a turn ends; the next turn reuses the same connection.
   */
  private readonly cachedWsSessions = new Map<string, CachedWsEntry>()

  /**
   * 单一会话状态机：每个 conversationId 对应一个 ConversationCodexSession。
   *
   * 合并了原先三套并行 Map：
   *   - activeTurnContexts (Map<conversationId, CodexTurnContext>)
   *   - conversationStreamLocks (Map<conversationId, Promise<void>>)
   *   - 部分 conversation-scoped 的 cache 句柄
   *
   * 物理 WS 连接仍由 wsService.sessions 管理——它是 transport 层，
   * 这里 conversationSessions 是逻辑会话层；二者通过 wsSessionId 字符串关联，
   * 物理连接的关闭 / 失效不会反向破坏逻辑会话状态，反之亦然。
   */
  private readonly conversationSessions = new Map<
    string,
    ConversationCodexSession
  >()

  /**
   * Warmup payload cache, keyed by conversationId.
   * Previously stored in SessionLifecycleService (protocol layer);
   * now owned by the provider adapter where it belongs.
   */
  private readonly warmupPayloadCache = new Map<
    string,
    WarmupPayloadCacheEntry
  >()

  private readonly CONVERSATION_SLOT_TTL_MS = 60 * 60 * 1000
  private readonly WS_SESSION_CACHE_TTL_MS = 10 * 60 * 1000
  private readonly WARMUP_PAYLOAD_CACHE_TTL_MS = 30 * 60 * 1000
  private readonly MAX_CACHED_WS_SESSIONS = 128
  private readonly MAX_WARMUP_PAYLOAD_CACHE_ENTRIES = 256
  private rateLimitProbePromise: Promise<number> | null = null
  private activeLiveRequests = 0
  private activeRateLimitProbeAbortController: AbortController | null = null

  /** 持久化 Codex 账号 disabled 状态的 store */
  private readonly accountStateStore: BackendAccountStateStore

  constructor(
    private readonly configService: ConfigService,
    private readonly authService: CodexAuthService,
    private readonly cacheService: CodexCacheService,
    private readonly wsService: CodexWebSocketService,
    private readonly identity: CodexClientIdentityService,
    private readonly usageStats: UsageStatsService,
    persistence: PersistenceService
  ) {
    this.accountStateStore = new BackendAccountStateStore(
      persistence,
      this.logger
    )
  }

  onModuleInit() {
    const envApiKey = this.configService.get<string>("CODEX_API_KEY", "").trim()
    const envAccessToken = this.configService
      .get<string>("CODEX_ACCESS_TOKEN", "")
      .trim()
    const envIdToken = this.configService
      .get<string>("CODEX_ID_TOKEN", "")
      .trim()
    const envRefreshToken = this.configService
      .get<string>("CODEX_REFRESH_TOKEN", "")
      .trim()
    const envAccountId = this.configService
      .get<string>("CODEX_ACCOUNT_ID", "")
      .trim()
    const envPlanType = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    const envBaseUrl =
      this.configService
        .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
        .trim() || DEFAULT_BASE_URL
    const envProxyUrl = this.configService
      .get<string>("CODEX_PROXY_URL", "")
      .trim()

    // WebSocket transport preference.
    // Default to enabled because it offers lower latency and will
    // automatically fall back to HTTP when the upstream rejects upgrades.
    const wsEnv = this.configService
      .get<string>("CODEX_USE_WEBSOCKET", "")
      .trim()
      .toLowerCase()
    this.useWebSocket = !["false", "0", "off", "no"].includes(wsEnv)

    // 1. Load all accounts from codex-accounts.json
    const fileAccounts = this.loadAllCodexAccountsFromFile()

    // 2. Load persisted tokens (for legacy single-account mode)
    const persisted = this.authService.loadPersistedTokens()

    // 3. Add env-var account as first slot if it has credentials
    if (envApiKey || envAccessToken || persisted?.refreshToken) {
      const envSlot: CodexAccountSlot = {
        label: "env",
        apiKey: envApiKey || undefined,
        accessToken: envAccessToken || undefined,
        baseUrl: envBaseUrl,
        proxyUrl: envProxyUrl || undefined,
        source: "env",
        stateKey: this.buildCodexSlotStateKey({
          apiKey: envApiKey,
          email: "",
          accountId: envAccountId,
          baseUrl: envBaseUrl,
        }),
        tokenData: null,
        cooldownUntil: 0,
        modelStates: new Map(),
        rateLimitSnapshots: new Map(),
      }

      if (persisted?.refreshToken) {
        this.applyTokenDataToSlot(envSlot, persisted)
      } else if (envAccessToken || envRefreshToken || envIdToken) {
        this.applyTokenDataToSlot(
          envSlot,
          this.hydrateTokenData({
            idToken: envIdToken,
            accessToken: envAccessToken,
            refreshToken: envRefreshToken,
            accountId: envAccountId,
            email: "",
          })
        )
      }

      if (envPlanType) {
        envSlot.planType = envPlanType
      }

      // Only add if not duplicated in file accounts
      const isDuplicate = fileAccounts.some(
        (a) =>
          (a.apiKey && a.apiKey === envSlot.apiKey) ||
          ((a.email || a.accountId) &&
            a.email === envSlot.email &&
            (a.accountId || "") === (envSlot.accountId || ""))
      )
      if (!isDuplicate) {
        this.accounts.unshift(envSlot)
      }
    }

    // 4. Add file accounts
    for (const fa of fileAccounts) {
      const slot: CodexAccountSlot = {
        label: fa.label || fa.email || undefined,
        apiKey: fa.apiKey || undefined,
        accessToken: fa.accessToken || undefined,
        refreshToken: fa.refreshToken || undefined,
        accountId: fa.accountId || undefined,
        workspaceId: fa.workspaceId || undefined,
        email: fa.email || undefined,
        planType: normalizeCodexModelTier(fa.planType) || undefined,
        baseUrl: fa.baseUrl || envBaseUrl,
        proxyUrl: fa.proxyUrl || envProxyUrl || undefined,
        configPath: fa.configPath,
        source: "file",
        stateKey: this.buildCodexSlotStateKey({
          apiKey: fa.apiKey,
          email: fa.email,
          accountId: fa.accountId,
          baseUrl: fa.baseUrl || envBaseUrl,
        }),
        tokenData: null,
        cooldownUntil: 0,
        modelStates: new Map(),
        rateLimitSnapshots: new Map(),
        persistedMatch: {
          apiKey: fa.apiKey || undefined,
          email: fa.email || undefined,
          accountId: fa.accountId || undefined,
          accessToken: fa.accessToken || undefined,
          refreshToken: fa.refreshToken || undefined,
        },
      }

      if (fa.accessToken || fa.refreshToken || fa.idToken) {
        this.applyTokenDataToSlot(
          slot,
          this.hydrateTokenData({
            idToken: fa.idToken || "",
            accessToken: fa.accessToken || "",
            refreshToken: fa.refreshToken || "",
            accountId: fa.accountId || "",
            workspaceId: fa.workspaceId || "",
            email: fa.email || "",
            expire: fa.expire || "",
          })
        )
      }

      this.accounts.push(slot)
    }

    this.configuredModelTier = this.resolveConfiguredModelTier()
    this.configuredDefaultServiceTier =
      this.resolveConfiguredDefaultServiceTier()

    this.logger.log(
      `Codex backend initialized: ${this.accounts.length} account(s), ` +
        `defaultBaseUrl=${envBaseUrl}, useWebSocket=${this.useWebSocket}, ` +
        `modelTier=${this.configuredModelTier || "unknown"}, ` +
        `serviceTier=${this.configuredDefaultServiceTier || "default"}`
    )
    for (const acct of this.accounts) {
      this.logger.log(
        `  → ${acct.label || acct.email || "unnamed"}: ` +
          `${acct.apiKey ? "api-key" : "oauth"} @ ${acct.baseUrl}`
      )
    }
    if (this.accounts.length === 0) {
      this.logger.warn(
        "No Codex credentials configured. " +
          "GPT/O-series models will not be available."
      )
    }

    // 5. 恢复持久化的 disabled 状态，避免重启后再次用失效账号做 warmup 导致无意义 401
    this.restorePersistedAccountStates()
  }

  /**
   * Check if Codex backend is available (has at least one account).
   */
  isAvailable(): boolean {
    return this.accounts.length > 0
  }

  /**
   * Hot-reload accounts from config file.
   * Reconciles file-backed slots against the latest account file, preserving
   * runtime state only for matching live slots and removing stale file slots.
   * Returns the number of newly added accounts.
   */
  reloadAccounts(): number {
    const freshRecords = this.loadAllCodexAccountsFromFile()
    const envBaseUrl =
      this.configService
        .get<string>("CODEX_BASE_URL", DEFAULT_BASE_URL)
        .trim() || DEFAULT_BASE_URL
    const envProxyUrl = this.configService
      .get<string>("CODEX_PROXY_URL", "")
      .trim()

    const existingFileSlots = new Map<string, CodexAccountSlot>()
    for (const slot of this.accounts) {
      if (slot.source !== "file") {
        continue
      }
      existingFileSlots.set(this.getFileSlotReloadKey(slot), slot)
    }

    const nextAccounts = this.accounts.filter((slot) => slot.source !== "file")
    const seenReloadKeys = new Set<string>()
    let added = 0

    freshRecords.forEach((record, index) => {
      const reloadKey = this.getLoadedRecordReloadKey(record, envBaseUrl, index)
      if (seenReloadKeys.has(reloadKey)) {
        return
      }
      seenReloadKeys.add(reloadKey)

      const existingSlot = existingFileSlots.get(reloadKey)
      if (existingSlot) {
        this.refreshFileSlotFromRecord(
          existingSlot,
          record,
          envBaseUrl,
          envProxyUrl
        )
        nextAccounts.push(existingSlot)
        existingFileSlots.delete(reloadKey)
        return
      }

      const slot = this.createFileSlotFromLoadedRecord(
        record,
        envBaseUrl,
        envProxyUrl
      )
      nextAccounts.push(slot)
      added++
      this.logger.log(
        `[Hot-reload] Added new Codex account: ${this.getAccountLabel(slot)}`
      )
    })

    const removedSlots = Array.from(existingFileSlots.values())
    if (removedSlots.length > 0) {
      this.pruneConversationBindingsForSlots(removedSlots)
      this.logger.log(
        `[Hot-reload] Codex: removed ${removedSlots.length} stale file account(s)`
      )
    }

    this.accounts = nextAccounts
    this.accountIndex =
      this.accounts.length > 0 ? this.accountIndex % this.accounts.length : 0
    this.configuredModelTier = this.resolveConfiguredModelTier()

    if (added > 0 || removedSlots.length > 0) {
      this.logger.log(
        `[Hot-reload] Codex: +${added} / -${removedSlots.length}, total=${this.accounts.length}`
      )
    }

    return added
  }

  getPoolStatus(): BackendPoolStatus {
    const now = Date.now()
    const entries = this.accounts.map((account) => {
      const modelCooldowns = this.getActiveModelCooldowns(account, now)
      const state = this.getPoolEntryState(account, modelCooldowns, now)
      return {
        id: [
          account.email || "",
          account.accountId || "",
          account.workspaceId || "",
          account.apiKey || "",
          account.baseUrl,
        ].join("\0"),
        label: this.getAccountLabel(account),
        state,
        cooldownUntil: account.cooldownUntil,
        disabledAt: account.disabledAt,
        disabledReason: account.disabledReason,
        source: account.source,
        baseUrl: account.baseUrl,
        proxyUrl: account.proxyUrl,
        planType: account.planType,
        email: account.email,
        accountId: account.accountId,
        workspaceId: account.workspaceId,
        modelCooldowns,
        rateLimits: this.getRateLimitAccountSummary(account),
      }
    })

    return {
      backend: "codex",
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
      configPath: this.accountsFilePath,
      entries,
    }
  }

  getModelTier(): CodexModelTier | null {
    return this.getHighestLoadedModelTier() || this.configuredModelTier
  }

  getDefaultServiceTier(): string | undefined {
    return this.configuredDefaultServiceTier
  }

  supportsModel(modelName: string): boolean {
    const normalized = modelName.toLowerCase().trim()
    if (!normalized) {
      return false
    }

    return this.hasSupportingAccount(normalized)
  }

  private resolveConfiguredModelTier(): CodexModelTier | null {
    const envTier = normalizeCodexModelTier(
      this.configService.get<string>("CODEX_PLAN_TYPE", "")
    )
    if (envTier) {
      return envTier
    }

    return this.readModelTierFromLocalAuthFile()
  }

  private resolveConfiguredDefaultServiceTier(): string | undefined {
    const envTier = this.normalizeConfiguredServiceTier(
      this.configService.get<string>("CODEX_SERVICE_TIER", "")
    )
    if (envTier) {
      return envTier
    }

    return this.readServiceTierFromLocalConfig()
  }

  private normalizeConfiguredServiceTier(
    rawValue?: string
  ): string | undefined {
    const normalized = rawValue?.trim().toLowerCase()
    if (!normalized) {
      return undefined
    }

    switch (normalized) {
      case "priority":
      case "fast":
      case "true":
      case "on":
      case "enabled":
      case "1":
        return "priority"
      default:
        return undefined
    }
  }

  private readServiceTierFromLocalConfig(): string | undefined {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const configFile = path.join(codexHome, "config.toml")

    try {
      if (!fs.existsSync(configFile)) {
        return undefined
      }

      const raw = fs.readFileSync(configFile, "utf8")
      const match = raw.match(/^\s*service_tier\s*=\s*"([^"]+)"/m)
      return this.normalizeConfiguredServiceTier(match?.[1])
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex service tier from ${configFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
  }

  private readModelTierFromLocalAuthFile(): CodexModelTier | null {
    const codexHome =
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    const authFile = path.join(codexHome, "auth.json")

    try {
      if (!fs.existsSync(authFile)) {
        return null
      }

      const raw = fs.readFileSync(authFile, "utf8")
      const parsed = JSON.parse(raw) as {
        tokens?: { id_token?: string }
      }

      return this.authService.getPlanTypeFromIdToken(
        parsed.tokens?.id_token || ""
      )
    } catch (error) {
      this.logger.warn(
        `Failed to infer Codex plan type from ${authFile}: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  /**
   * Load all Codex accounts from codex-accounts.json.
   */
  private loadAllCodexAccountsFromFile(): LoadedCodexAccountRecord[] {
    const loadedRecords: LoadedCodexAccountRecord[] = []
    const loadedPaths: string[] = []

    for (const configPath of CODEX_ACCOUNTS_CONFIG_PATHS) {
      if (!fs.existsSync(configPath)) continue

      try {
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        if (Array.isArray(data.accounts) && data.accounts.length > 0) {
          loadedPaths.push(configPath)
          this.logger.log(
            `Loaded ${data.accounts.length} Codex account(s) from ${configPath}`
          )
          loadedRecords.push(
            ...data.accounts.map((account) => ({
              ...account,
              configPath,
            }))
          )
        }
      } catch (err) {
        this.logger.warn(
          `Failed to parse ${configPath}: ${(err as Error).message}`
        )
      }
    }

    if (loadedRecords.length === 0) {
      return []
    }

    const mergedRecords = this.mergeLoadedAccountRecords(loadedRecords)
    const preferredConfigPath =
      mergedRecords[mergedRecords.length - 1]?.configPath ||
      loadedPaths[loadedPaths.length - 1] ||
      CODEX_ACCOUNTS_DEFAULT_PATH

    this.accountsFilePath = preferredConfigPath

    if (
      loadedPaths.length > 1 ||
      mergedRecords.length !== loadedRecords.length
    ) {
      this.logger.log(
        `Merged ${mergedRecords.length} Codex account(s) from ${loadedPaths.join(", ")}`
      )
    }

    return mergedRecords
  }

  private mergeLoadedAccountRecords(
    records: LoadedCodexAccountRecord[]
  ): LoadedCodexAccountRecord[] {
    const merged = new Map<string, LoadedCodexAccountRecord>()

    records.forEach((record, index) => {
      const key = this.getLoadedAccountOverrideKey(record, index)
      if (merged.has(key)) {
        merged.delete(key)
      }
      merged.set(key, record)
    })

    return Array.from(merged.values())
  }

  private getLoadedAccountOverrideKey(
    account: LoadedCodexAccountRecord,
    index: number
  ): string {
    const email = account.email?.trim().toLowerCase()
    const accountId = account.accountId?.trim()
    if (email && accountId) {
      return `email:${email}:${accountId}`
    }
    if (email) {
      return `email:${email}`
    }

    const apiKey = account.apiKey?.trim()
    if (apiKey) {
      return `api_key:${apiKey}`
    }

    const refreshToken = account.refreshToken?.trim()
    if (refreshToken) {
      return `refresh_token:${refreshToken}`
    }

    const accessToken = account.accessToken?.trim()
    if (accessToken) {
      return `access_token:${accessToken}`
    }

    if (accountId) {
      return `account_id:${accountId}`
    }

    return `path:${account.configPath}:${index}`
  }

  /**
   * Derive per-slot token metadata from persisted or env-backed credentials.
   */
  private hydrateTokenData(tokenData: Partial<CodexTokenData>): CodexTokenData {
    const idToken = tokenData.idToken?.trim() || ""
    const accessToken = tokenData.accessToken?.trim() || ""

    return {
      idToken,
      accessToken,
      refreshToken: tokenData.refreshToken?.trim() || "",
      accountId:
        tokenData.accountId?.trim() ||
        this.authService.getAccountIdFromIdToken(idToken),
      workspaceId:
        tokenData.workspaceId?.trim() ||
        this.authService.getWorkspaceIdFromIdToken(idToken),
      email: tokenData.email?.trim() || "",
      expire:
        tokenData.expire?.trim() || this.inferTokenExpiry(accessToken, idToken),
    }
  }

  private inferTokenExpiry(...tokens: Array<string | undefined>): string {
    for (const token of tokens) {
      if (!token) continue
      const expire = this.authService.getTokenExpiryFromJwt(token)
      if (expire) {
        return expire
      }
    }

    return new Date(Date.now() + 3600 * 1000).toISOString()
  }

  private applyTokenDataToSlot(
    slot: CodexAccountSlot,
    tokenData: CodexTokenData
  ): void {
    slot.tokenData = tokenData
    slot.accessToken = tokenData.accessToken || slot.accessToken
    slot.refreshToken = tokenData.refreshToken || slot.refreshToken
    slot.accountId =
      tokenData.accountId ||
      slot.accountId ||
      this.authService.getAccountIdFromIdToken(tokenData.idToken)
    slot.workspaceId =
      tokenData.workspaceId ||
      slot.workspaceId ||
      this.authService.getWorkspaceIdFromIdToken(tokenData.idToken)
    slot.email = tokenData.email || slot.email

    // 与 CLIProxyAPI 的管理面板保持一致：
    // 如果账号文件里已经明确声明了 planType，就不要再被 token claim 覆盖。
    // 某些账号会出现 token 里仍然是 free，但实际账号/面板展示应保持 plus 的情况。
    if (!slot.planType) {
      slot.planType =
        this.authService.getPlanTypeFromTokenData(tokenData) ?? undefined
    }
  }

  private getSlotPlanType(slot: CodexAccountSlot): CodexModelTier | null {
    return (
      slot.planType || this.authService.getPlanTypeFromTokenData(slot.tokenData)
    )
  }

  private getHighestLoadedModelTier(): CodexModelTier | null {
    let highest: CodexModelTier | null = null

    for (const slot of this.accounts) {
      const tier = this.getSlotPlanType(slot)
      if (!tier) continue
      if (
        !highest ||
        CODEX_MODEL_TIER_ORDER.indexOf(tier) >
          CODEX_MODEL_TIER_ORDER.indexOf(highest)
      ) {
        highest = tier
      }
    }

    return highest
  }

  private getSlotAccountId(slot: CodexAccountSlot): string {
    return (
      this.authService.getAccountIdFromTokenData(slot.tokenData) ||
      slot.accountId ||
      ""
    )
  }

  private getConversationId(
    request: Pick<CodexExecutionRequest, "conversationId">
  ): string {
    return typeof request.conversationId === "string"
      ? request.conversationId.trim()
      : ""
  }

  private getCodexTurnKey(codexRequest: Record<string, unknown>): string {
    const metadata = codexRequest.client_metadata
    if (!metadata || typeof metadata !== "object") {
      return ""
    }

    const record = metadata as Record<string, unknown>
    const rawTurnMetadata = record["x-codex-turn-metadata"]
    if (typeof rawTurnMetadata === "string" && rawTurnMetadata.trim()) {
      try {
        const parsed = JSON.parse(rawTurnMetadata) as Record<string, unknown>
        const turnId = parsed?.turn_id
        if (typeof turnId === "string" && turnId.trim()) {
          return turnId.trim()
        }
      } catch {
        return rawTurnMetadata.trim()
      }
      return rawTurnMetadata.trim()
    }

    const windowId = record["x-codex-window-id"]
    return typeof windowId === "string" ? windowId.trim() : ""
  }

  private applyCodexTurnStateHeader(
    headers: Record<string, string>,
    context: CodexTurnContext | undefined
  ): void {
    const turnState = context?.turnState?.trim()
    if (!turnState) {
      return
    }
    headers["x-codex-turn-state"] = turnState
  }

  private captureCodexTurnStateFromConnection(
    context: CodexTurnContext | undefined,
    ws: WebSocket
  ): void {
    const turnState = this.wsService
      .getConnectionMetadata(ws)
      ?.turnState?.trim()
    if (!context || !turnState || context.turnState === turnState) {
      return
    }
    context.turnState = turnState
    this.logger.debug(
      `[Codex][TurnContext] Captured x-codex-turn-state for session=${context.wsSessionId} turn=${context.turnKey || "unknown"}`
    )
  }

  // ── CodexTurnContext lifecycle management ──────────────────────────────
  //
  // Mirrors the official Codex CLI ModelClient.new_session() / ModelClientSession.Drop.
  // All requests for a conversation (prewarm + stream) share a single CodexTurnContext.
  // When a turn ends the connection is returned to cachedWsSessions.
  // Eliminates the warm pool promotion mechanism entirely.

  // ── ConversationCodexSession store ─────────────────────────────────────
  //
  // 唯一入口管理逻辑会话状态。所有读 / 写 active turn context 与 stream lock 都
  // 走这里，不再直接操作裸 Map，避免 turn / lock / dispose 三处状态错位。

  private getConversationSession(
    conversationId: string
  ): ConversationCodexSession | undefined {
    const normalized = conversationId.trim()
    if (!normalized) return undefined
    return this.conversationSessions.get(normalized)
  }

  private getOrCreateConversationSession(
    conversationId: string
  ): ConversationCodexSession {
    const normalized = conversationId.trim()
    if (!normalized) {
      throw new Error(
        "[CodexService] empty conversationId passed to getOrCreateConversationSession"
      )
    }
    const existing = this.conversationSessions.get(normalized)
    if (existing) {
      existing.updatedAt = Date.now()
      return existing
    }
    const created: ConversationCodexSession = {
      conversationId: normalized,
      active: null,
      streamTail: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.conversationSessions.set(normalized, created)
    return created
  }

  /** 仅用于"无 active turn 也无 lock 残留时"清理空 session，避免 Map 长期膨胀。 */
  private maybePurgeConversationSession(conversationId: string): void {
    const normalized = conversationId.trim()
    if (!normalized) return
    const session = this.conversationSessions.get(normalized)
    if (!session) return
    if (session.active === null && session.streamTail === null) {
      this.conversationSessions.delete(normalized)
    }
  }

  /**
   * Generate the cross-turn connection cache key.
   * Conversation-scoped requests must not share previous_response_id state.
   * Global keys are only used for startup/model-picker warmups with no conversation.
   */
  private getCachedWsKey(
    slot: CodexAccountSlot,
    modelName: string,
    conversationId?: string
  ): string {
    const slotKeyHash = this.hashIdentityPart(this.getSlotStickyKey(slot))
    const normalizedModel = modelName.toLowerCase().trim() || "unknown"
    const normalizedConversationId = conversationId?.trim()
    const scope = normalizedConversationId
      ? `conversation:${this.hashIdentityPart(normalizedConversationId)}`
      : "global"
    return `ws:${normalizedModel}:${slotKeyHash}:${scope}`
  }

  /**
   * Get or create a turn context for the given conversation.
   * Mirrors the official ModelClient.new_session().
   *
   * If cachedWsSessions has a matching connection, it is taken and reused.
   * If an active turn context already exists, it is returned directly.
   */
  private getOrCreateTurnContext(
    conversationId: string,
    slot: CodexAccountSlot,
    modelName: string,
    turnKey?: string
  ): CodexTurnContext {
    const session = this.getOrCreateConversationSession(conversationId)
    const existing = session.active
    if (existing) {
      if (existing.turnKey !== turnKey) {
        existing.turnKey = turnKey
        existing.turnState = undefined
      }
      return existing
    }

    this.pruneCodexRuntimeCaches()
    const cacheKey = this.getCachedWsKey(slot, modelName, conversationId)
    const cached = this.cachedWsSessions.get(cacheKey)

    let context: CodexTurnContext
    if (cached) {
      // Reuse connection from cache (mirrors take_cached_websocket_session)
      this.cachedWsSessions.delete(cacheKey)
      context = {
        wsSessionId: cached.wsSessionId,
        turnKey,
        turnState: cached.turnKey === turnKey ? cached.turnState : undefined,
        lastResponse: cached.lastResponse,
        lastRequest: cached.lastRequest,
        connectionReused: true,
      }
    } else {
      // No cached connection; use conversationId as session key (lazy connect)
      context = {
        wsSessionId: conversationId,
        turnKey,
        turnState: undefined,
        lastResponse: undefined,
        lastRequest: undefined,
        connectionReused: false,
      }
    }

    session.active = context
    session.updatedAt = Date.now()
    return context
  }

  /**
   * Return the turn context's connection to cachedWsSessions.
   * Mirrors the official ModelClientSession.Drop.
   */
  private disposeTurnContext(
    conversationId: string,
    slot: CodexAccountSlot,
    modelName: string
  ): void {
    const session = this.getConversationSession(conversationId)
    if (!session) return
    const context = session.active
    if (!context) return

    const cacheKey = this.getCachedWsKey(slot, modelName, conversationId)
    // Return connection to cache (mirrors store_cached_websocket_session)
    this.setCachedWsSession(cacheKey, {
      wsSessionId: context.wsSessionId,
      turnKey: context.turnKey,
      turnState: context.turnState,
      lastResponse: context.lastResponse,
      lastRequest: context.lastRequest,
      updatedAt: Date.now(),
    })

    session.active = null
    session.updatedAt = Date.now()
    this.maybePurgeConversationSession(conversationId)
  }

  /**
   * Automatically inject previous_response_id before sending a request.
   * Mirrors official prepare_websocket_request() + get_incremental_items().
   *
   * We only use previous_response_id when the new full request is a strict extension
   * of the previous full request plus server-returned output items. This avoids sending
   * a fabricated delta when the transcript was truncated, compacted, or otherwise rebuilt.
   */
  private prepareRequestWithTurnContext(
    codexRequest: Record<string, unknown>,
    context: CodexTurnContext,
    conversationId: string
  ): Record<string, unknown> {
    if (!context.lastResponse?.responseId || !context.lastRequest) {
      context.lastRequest = codexRequest
      return codexRequest
    }

    const incrementalInput = this.getIncrementalItems(
      codexRequest,
      context.lastRequest,
      context.lastResponse,
      true
    )
    if (!incrementalInput) {
      this.logger.debug(
        `[Codex][TurnContext] Discarding response_id=${context.lastResponse.responseId} ` +
          `for ${conversationId}: request is not a strict incremental extension`
      )
      context.lastRequest = codexRequest
      return codexRequest
    }

    this.logger.debug(
      `[Codex][TurnContext] Injected previous_response_id=${context.lastResponse.responseId} ` +
        `for conversation=${conversationId}; incremental_items=${incrementalInput.length}`
    )
    context.lastRequest = codexRequest
    return {
      ...codexRequest,
      input: incrementalInput,
      previous_response_id: context.lastResponse.responseId,
    }
  }

  private getIncrementalItems(
    request: Record<string, unknown>,
    previousRequest: Record<string, unknown>,
    lastResponse: CodexLastResponse,
    allowEmptyDelta: boolean
  ): CodexInputItem[] | undefined {
    const result = getCodexIncrementalInput(
      request,
      previousRequest,
      lastResponse,
      allowEmptyDelta
    )
    if (!result.ok) {
      const detail =
        result.reason === "static_fields_changed"
          ? ` keys=${result.changedStaticKeys.join(",") || "unknown"}`
          : ` baseline=${result.inputMismatch.baselineLength} request=${result.inputMismatch.requestLength}` +
            (typeof result.inputMismatch.mismatchIndex === "number"
              ? ` mismatch_index=${result.inputMismatch.mismatchIndex}` +
                ` baseline_type=${result.inputMismatch.baselineType || "unknown"}` +
                ` request_type=${result.inputMismatch.requestType || "unknown"}`
              : "")
      this.logger.debug(
        `[Codex][TurnContext] Incremental request unavailable: ${result.reason}${detail}`
      )
      return undefined
    }

    return result.input
  }

  private convertResponseOutputItemToInputItem(
    item: Record<string, unknown> | undefined
  ): CodexInputItem | undefined {
    if (!item) return undefined

    if (item.type === "function_call") {
      return {
        type: "function_call",
        call_id: typeof item.call_id === "string" ? item.call_id : "",
        name: typeof item.name === "string" ? item.name : "",
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
      } satisfies CodexFunctionCall
    }

    if (item.type === "custom_tool_call") {
      return {
        type: "custom_tool_call",
        call_id: typeof item.call_id === "string" ? item.call_id : "",
        name: typeof item.name === "string" ? item.name : "",
        input:
          typeof item.input === "string"
            ? item.input
            : JSON.stringify(item.input ?? ""),
      } satisfies CodexCustomToolCall
    }

    if (item.type === "message") {
      const rawContent = item.content
      const content = Array.isArray(rawContent)
        ? (rawContent as Array<Record<string, unknown>>)
        : typeof rawContent === "string"
          ? [{ type: "output_text", text: rawContent }]
          : []

      return {
        type: "message",
        role: typeof item.role === "string" ? item.role : "assistant",
        content,
      } satisfies CodexInputMessage
    }

    return undefined
  }

  /**
   * Capture the response_id and output items from a response.completed event.
   * Mirrors map_response_stream() ResponseEvent::Completed → LastResponse.
   */
  private captureResponseInTurnContext(
    conversationId: string,
    responseId: string,
    itemsAdded: CodexInputItem[]
  ): void {
    if (!conversationId || !responseId) return
    const session = this.getConversationSession(conversationId)
    const context = session?.active
    if (!context) return
    context.lastResponse = { responseId, itemsAdded }
    if (session) session.updatedAt = Date.now()
    this.logger.debug(
      `[Codex][TurnContext] Captured response_id=${responseId} ` +
        `for conversation=${conversationId}; items_added=${itemsAdded.length}`
    )
  }

  /**
   * Clear response state in the turn context when the transcript baseline is
   * no longer safe for incremental append.
   */
  private resetTurnContextResponseState(
    conversationId: string,
    reason?: string
  ): void {
    const session = this.getConversationSession(conversationId)
    const context = session?.active
    if (context) {
      if (context.lastResponse?.responseId && reason) {
        this.logger.debug(
          `[Codex][TurnContext] ${reason} for ${conversationId}, ` +
            `discarding stale previous_response_id=${context.lastResponse.responseId}`
        )
      }
      context.lastResponse = undefined
      context.lastRequest = undefined
      if (session) session.updatedAt = Date.now()
    }
  }

  /**
   * Reset Codex continuation state after the model-facing transcript was
   * rewritten by compaction, snip, microcompact, or hard-fit projection.
   *
   * This mirrors Codex CLI's ModelClientSession.reset_websocket_session():
   * once history is rewritten, the previous WebSocket response chain is no
   * longer a valid baseline for previous_response_id deltas.
   */
  resetConversationContinuationState(
    conversationId: string | undefined,
    modelName?: string,
    reason?: string
  ): void {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) {
      return
    }

    let resetCount = 0
    const activeSession = this.getConversationSession(normalizedConversationId)
    const activeContext = activeSession?.active
    if (activeContext) {
      this.resetTurnContextResponseState(normalizedConversationId, reason)
      this.wsService.closeSession(activeContext.wsSessionId)
      activeContext.connectionReused = false
      resetCount++
    }

    const normalizedModel = modelName?.trim()
    if (normalizedModel) {
      for (const slot of this.accounts) {
        const cacheKey = this.getCachedWsKey(
          slot,
          normalizedModel,
          normalizedConversationId
        )
        const cached = this.cachedWsSessions.get(cacheKey)
        if (!cached) {
          continue
        }
        this.wsService.closeSession(cached.wsSessionId)
        this.cachedWsSessions.delete(cacheKey)
        resetCount++
      }
    }

    this.warmupPayloadCache.delete(normalizedConversationId)

    if (resetCount > 0 || reason) {
      this.logger.debug(
        `[Codex][TurnContext] Reset continuation state for ${normalizedConversationId}` +
          `${normalizedModel ? ` model=${normalizedModel}` : ""}` +
          `${reason ? `: ${reason}` : ""}`
      )
    }
  }

  /**
   * Check whether the given conversation has an active turn context with a captured response.
   * Used by cache identity and slot selection to distinguish initial vs continuation requests.
   */
  private hasActiveTurnContext(conversationId: string): boolean {
    return this.hasConversationContinuationState(conversationId)
  }

  private hasConversationContinuationState(
    conversationId: string,
    slot?: CodexAccountSlot,
    modelName?: string
  ): boolean {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) {
      return false
    }

    const activeContext = this.getConversationSession(
      normalizedConversationId
    )?.active
    if (activeContext?.lastResponse?.responseId) {
      return true
    }

    if (!slot || !modelName) {
      return false
    }

    this.pruneCodexRuntimeCaches()
    const cached = this.cachedWsSessions.get(
      this.getCachedWsKey(slot, modelName, normalizedConversationId)
    )
    return !!cached?.lastResponse?.responseId
  }

  private async acquireConversationStreamLock(
    conversationId: string
  ): Promise<() => void> {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) {
      return () => {}
    }

    const session = this.getOrCreateConversationSession(
      normalizedConversationId
    )
    const previousTail = session.streamTail
    let release!: () => void
    const currentTail = new Promise<void>((resolve) => {
      release = resolve
    })
    session.streamTail = currentTail
    session.updatedAt = Date.now()

    if (previousTail) {
      try {
        await previousTail
      } catch {
        // 锁尾 promise 理论上只 resolve；这里防御异常，避免永久阻塞后续 turn。
      }
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.getConversationSession(normalizedConversationId)
      if (current && current.streamTail === currentTail) {
        current.streamTail = null
        current.updatedAt = Date.now()
        this.maybePurgeConversationSession(normalizedConversationId)
      }
      release()
    }
  }

  private onLiveRequestStart(): void {
    this.activeLiveRequests += 1
    if (this.activeRateLimitProbeAbortController) {
      this.activeRateLimitProbeAbortController.abort()
    }
  }

  private onLiveRequestEnd(): void {
    this.activeLiveRequests = Math.max(0, this.activeLiveRequests - 1)
  }

  private pruneCodexRuntimeCaches(now: number = Date.now()): void {
    for (const [key, entry] of this.cachedWsSessions) {
      if (entry.updatedAt + this.WS_SESSION_CACHE_TTL_MS <= now) {
        this.cachedWsSessions.delete(key)
      }
    }
    this.pruneMapToMaxSize(this.cachedWsSessions, this.MAX_CACHED_WS_SESSIONS)

    for (const [conversationId, entry] of this.warmupPayloadCache) {
      if (entry.updatedAt + this.WARMUP_PAYLOAD_CACHE_TTL_MS <= now) {
        this.warmupPayloadCache.delete(conversationId)
      }
    }
    this.pruneMapToMaxSize(
      this.warmupPayloadCache,
      this.MAX_WARMUP_PAYLOAD_CACHE_ENTRIES
    )
  }

  private pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldestKey = map.keys().next().value
      if (oldestKey === undefined) return
      map.delete(oldestKey)
    }
  }

  private setCachedWsSession(cacheKey: string, entry: CachedWsEntry): void {
    if (!cacheKey) return
    this.pruneCodexRuntimeCaches()
    this.cachedWsSessions.set(cacheKey, {
      ...entry,
      updatedAt: Date.now(),
    })
    this.pruneMapToMaxSize(this.cachedWsSessions, this.MAX_CACHED_WS_SESSIONS)
  }

  private setWarmupPayloadCache(
    conversationId: string,
    payload: Record<string, unknown>
  ): void {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) return
    this.pruneCodexRuntimeCaches()
    this.warmupPayloadCache.set(normalizedConversationId, {
      payload,
      updatedAt: Date.now(),
    })
    this.pruneMapToMaxSize(
      this.warmupPayloadCache,
      this.MAX_WARMUP_PAYLOAD_CACHE_ENTRIES
    )
  }

  private getWarmupPayloadCache(
    conversationId: string | undefined
  ): Record<string, unknown> | undefined {
    const normalizedConversationId = conversationId?.trim()
    if (!normalizedConversationId) return undefined
    this.pruneCodexRuntimeCaches()
    const entry = this.warmupPayloadCache.get(normalizedConversationId)
    if (!entry) return undefined

    entry.updatedAt = Date.now()
    this.warmupPayloadCache.delete(normalizedConversationId)
    this.warmupPayloadCache.set(normalizedConversationId, entry)
    return entry.payload
  }

  private shouldRetrySessionWebSocketError(error: unknown): boolean {
    if (error instanceof CodexWebSocketUpgradeError) {
      return false
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error)

    return (
      message.includes("websocket is not open") ||
      message.includes("readystate") ||
      message.includes("socket has been closed")
    )
  }

  /**
   * Detect "Previous response with id ... not found" errors from the Codex API.
   * This happens when the server evicts the response from its cache (e.g. due to
   * parallel tool calls taking too long). The fix is to retry without
   * previous_response_id, sending the full input instead.
   */
  private isStaleResponseIdError(error: unknown): boolean {
    if (error instanceof CodexWebSocketUpgradeError) {
      return (
        error.statusCode === 400 &&
        /previous.response.*not found/i.test(error.body)
      )
    }
    if (error instanceof CodexApiError) {
      return (
        error.getStatus() === 400 &&
        /previous.response.*not found/i.test(error.message)
      )
    }
    return false
  }

  private shouldFallbackToHttpAfterWebSocketError(error: unknown): boolean {
    if (error instanceof CodexWebSocketUpgradeError) {
      return error.shouldFallbackToHttp()
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error)

    return (
      message.includes("handshake timeout") ||
      message.includes("unexpected server response") ||
      message.includes("socket hang up") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("ehostunreach") ||
      message.includes("enotfound") ||
      message.includes("proxy") ||
      message.includes("tls") ||
      message.includes("certificate")
    )
  }

  private hashIdentityPart(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
  }

  private getSlotStickyKey(slot: CodexAccountSlot): string {
    const apiKey = slot.apiKey?.trim()
    if (apiKey) {
      return `api_key:${apiKey}\0base:${slot.baseUrl}`
    }

    const accountId = this.getSlotAccountId(slot).trim()
    if (accountId) {
      return `account_id:${accountId}\0base:${slot.baseUrl}`
    }

    const email = slot.email?.trim().toLowerCase()
    if (email) {
      return `email:${email}\0base:${slot.baseUrl}`
    }

    const refreshToken =
      slot.tokenData?.refreshToken?.trim() || slot.refreshToken?.trim()
    if (refreshToken) {
      return `refresh:${this.hashIdentityPart(refreshToken)}\0base:${slot.baseUrl}`
    }

    const accessToken =
      slot.tokenData?.accessToken?.trim() || slot.accessToken?.trim()
    if (accessToken) {
      return `access:${this.hashIdentityPart(accessToken)}\0base:${slot.baseUrl}`
    }

    return `label:${slot.label || ""}\0base:${slot.baseUrl}`
  }

  private purgeExpiredConversationBindings(now: number = Date.now()): void {
    for (const [conversationId, binding] of this.conversationSlotBindings) {
      if (binding.expire <= now) {
        this.conversationSlotBindings.delete(conversationId)
        // 同步清理 conversationSession 的 active turn 字段（仅文本元数据，无连接句柄）。
        // 物理 WS 连接由 wsService 自己的 STALE_TIMEOUT_MS 兜底。
        const session = this.conversationSessions.get(conversationId)
        if (session) {
          session.active = null
          this.maybePurgeConversationSession(conversationId)
        }
      }
    }
  }

  private bindConversationToSlot(
    conversationId: string,
    slot: CodexAccountSlot
  ): void {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) return

    this.purgeExpiredConversationBindings()
    this.conversationSlotBindings.set(normalizedConversationId, {
      slotKey: this.getSlotStickyKey(slot),
      expire: Date.now() + this.CONVERSATION_SLOT_TTL_MS,
    })
  }

  private getStickyConversationSlot(
    conversationId: string,
    modelName: string
  ): CodexAccountSlot | null {
    const normalizedConversationId = conversationId.trim()
    if (!normalizedConversationId) {
      return null
    }

    const now = Date.now()
    this.purgeExpiredConversationBindings(now)

    const binding = this.conversationSlotBindings.get(normalizedConversationId)
    if (!binding) {
      return null
    }

    const normalizedModelName = modelName.toLowerCase().trim()
    const slot =
      this.accounts.find(
        (candidate) => this.getSlotStickyKey(candidate) === binding.slotKey
      ) || null

    if (
      !slot ||
      !this.isModelSupportedBySlot(slot, normalizedModelName) ||
      !this.isSlotAvailableForModel(slot, normalizedModelName, now)
    ) {
      this.conversationSlotBindings.delete(normalizedConversationId)
      return null
    }

    binding.expire = now + this.CONVERSATION_SLOT_TTL_MS
    this.conversationSlotBindings.set(normalizedConversationId, binding)
    return slot
  }

  private getOAuthCacheIdentity(
    request: Pick<CodexExecutionRequest, "conversationId" | "model">,
    slot: CodexAccountSlot,
    options?: {
      includeConversationId?: boolean
    }
  ): string {
    const slotKey = this.getSlotStickyKey(slot)
    const conversationId = this.getConversationId(request)

    if ((options?.includeConversationId ?? true) && conversationId) {
      return `oauth:${slotKey}:conversation:${conversationId}:model:${request.model}`
    }

    return `oauth:${slotKey}:model:${request.model}`
  }

  private isModelSupportedBySlot(
    slot: CodexAccountSlot,
    modelName: string
  ): boolean {
    if (this.isApiKeyMode(slot)) {
      return true
    }

    const tier = this.getSlotPlanType(slot) || this.getModelTier() || "pro"
    return (
      isChatGptCodexModelSupported(modelName) &&
      supportsCodexModelForTier(modelName, tier)
    )
  }

  private hasSupportingAccount(modelName: string): boolean {
    const normalized = modelName.toLowerCase().trim()
    if (!normalized) {
      return false
    }

    return this.accounts.some(
      (slot) =>
        !isAccountDisabled(slot) &&
        this.isModelSupportedBySlot(slot, normalized)
    )
  }

  // ── Codex 账号 disabled 状态持久化 ──────────────────────────────────

  /**
   * 生成 slot 的持久化 stateKey。
   * 优先使用 email+accountId（与 Codex 账号一一对应），
   * fallback 到 apiKey hash，最终 fallback 到 baseUrl hash。
   */
  private buildCodexSlotStateKey(identity: {
    apiKey?: string
    email?: string
    accountId?: string
    baseUrl?: string
  }): string {
    const email = identity.email?.trim().toLowerCase() || ""
    const accountId = identity.accountId?.trim() || ""
    const apiKey = identity.apiKey?.trim() || ""
    const baseUrl = identity.baseUrl?.trim() || DEFAULT_BASE_URL

    if (email && accountId) {
      return crypto
        .createHash("sha256")
        .update(`codex:${email}:${accountId}`)
        .digest("hex")
        .slice(0, 16)
    }
    if (email) {
      return crypto
        .createHash("sha256")
        .update(`codex:${email}`)
        .digest("hex")
        .slice(0, 16)
    }
    if (apiKey) {
      return crypto
        .createHash("sha256")
        .update(`codex:apikey:${apiKey}`)
        .digest("hex")
        .slice(0, 16)
    }
    return crypto
      .createHash("sha256")
      .update(`codex:base:${baseUrl}`)
      .digest("hex")
      .slice(0, 16)
  }

  /**
   * 从 SQLite 恢复持久化的 disabled 状态。
   * 重启后已经被永久 disable 的账号直接跳过，不再做 warmup。
   */
  private restorePersistedAccountStates(): void {
    const persistedStates = this.accountStateStore.loadStates("codex")
    if (persistedStates.size === 0) return

    for (const slot of this.accounts) {
      const state = persistedStates.get(slot.stateKey)
      if (!state) continue

      if (typeof state.disabledAt === "number" && state.disabledAt > 0) {
        slot.disabledAt = state.disabledAt
        slot.disabledReason = state.disabledReason
        slot.disabledStatusCode = state.disabledStatusCode
        slot.disabledMessage = state.disabledMessage
        slot.cooldownUntil = 0
        slot.modelStates.clear()
        this.logger.warn(
          `[Codex] 恢复已 disabled 账号: ${this.getAccountLabel(slot)} (reason=${state.disabledReason})`
        )
      }
    }
  }

  /**
   * 将所有 Codex 账号的 disabled 状态持久化到 SQLite。
   * 仅在 disableAccount 后调用，保证下次重启时跳过失效账号。
   */
  private persistCodexAccountStates(): void {
    const states: PersistedBackendAccountState[] = []
    for (const slot of this.accounts) {
      if (!isAccountDisabled(slot)) continue
      states.push({
        stateKey: slot.stateKey,
        label: slot.label || slot.email,
        disabledAt: slot.disabledAt,
        disabledReason: slot.disabledReason,
        disabledStatusCode: slot.disabledStatusCode,
        disabledMessage: slot.disabledMessage,
        updatedAt: Date.now(),
      })
    }
    this.accountStateStore.replaceStates("codex", states)
  }

  private getAccountLabel(slot: CodexAccountSlot): string {
    const base = slot.label || slot.email || slot.accountId || "slot"
    const details: string[] = []

    if (slot.accountId) {
      details.push(slot.accountId.slice(0, 8))
    } else if (slot.workspaceId) {
      details.push(`ws:${slot.workspaceId.slice(0, 8)}`)
    } else {
      details.push(slot.source)
    }

    if (slot.planType) {
      details.push(slot.planType)
    }

    return `${base} (${details.join(", ")})`
  }

  private getLoadedRecordReloadKey(
    account: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    index: number
  ): string {
    const baseUrl =
      (account.baseUrl || fallbackBaseUrl).trim() || DEFAULT_BASE_URL
    return this.getNormalizedReloadKey({
      apiKey: account.apiKey,
      email: account.email,
      accountId: account.accountId,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      baseUrl,
      configPath: account.configPath,
      index,
    })
  }

  private getFileSlotReloadKey(slot: CodexAccountSlot): string {
    return this.getNormalizedReloadKey({
      apiKey: slot.apiKey,
      email: slot.email,
      accountId: slot.accountId,
      refreshToken: slot.refreshToken || slot.tokenData?.refreshToken,
      accessToken: slot.accessToken || slot.tokenData?.accessToken,
      baseUrl: slot.baseUrl,
      configPath: slot.configPath,
      index: 0,
    })
  }

  private getNormalizedReloadKey(identity: {
    apiKey?: string
    email?: string
    accountId?: string
    refreshToken?: string
    accessToken?: string
    baseUrl?: string
    configPath?: string
    index: number
  }): string {
    const baseUrl = identity.baseUrl?.trim() || DEFAULT_BASE_URL
    const email = identity.email?.trim().toLowerCase() || ""
    const accountId = identity.accountId?.trim() || ""
    const apiKey = identity.apiKey?.trim() || ""
    const refreshToken = identity.refreshToken?.trim() || ""
    const accessToken = identity.accessToken?.trim() || ""

    if (email && accountId) {
      return `email:${email}:${accountId}\0base:${baseUrl}`
    }
    if (email && refreshToken) {
      return `email_refresh:${email}:${this.hashIdentityPart(refreshToken)}\0base:${baseUrl}`
    }
    if (email && accessToken) {
      return `email_access:${email}:${this.hashIdentityPart(accessToken)}\0base:${baseUrl}`
    }
    if (email) {
      return `email:${email}\0base:${baseUrl}`
    }
    if (apiKey) {
      return `api_key:${apiKey}\0base:${baseUrl}`
    }
    if (refreshToken) {
      return `refresh:${this.hashIdentityPart(refreshToken)}\0base:${baseUrl}`
    }
    if (accessToken) {
      return `access:${this.hashIdentityPart(accessToken)}\0base:${baseUrl}`
    }
    if (accountId) {
      return `account_id:${accountId}\0base:${baseUrl}`
    }

    return `path:${identity.configPath || ""}:${identity.index}\0base:${baseUrl}`
  }

  private createFileSlotFromLoadedRecord(
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): CodexAccountSlot {
    const slot: CodexAccountSlot = {
      label: record.label || record.email || undefined,
      apiKey: record.apiKey || undefined,
      accessToken: record.accessToken || undefined,
      refreshToken: record.refreshToken || undefined,
      accountId: record.accountId || undefined,
      workspaceId: record.workspaceId || undefined,
      email: record.email || undefined,
      planType: normalizeCodexModelTier(record.planType) || undefined,
      baseUrl: record.baseUrl || fallbackBaseUrl,
      proxyUrl: record.proxyUrl || fallbackProxyUrl || undefined,
      configPath: record.configPath,
      source: "file",
      stateKey: this.buildCodexSlotStateKey({
        apiKey: record.apiKey,
        email: record.email,
        accountId: record.accountId,
        baseUrl: record.baseUrl || fallbackBaseUrl,
      }),
      tokenData: null,
      cooldownUntil: 0,
      modelStates: new Map(),
      rateLimitSnapshots: new Map(),
      persistedMatch: {
        apiKey: record.apiKey || undefined,
        email: record.email || undefined,
        accountId: record.accountId || undefined,
        accessToken: record.accessToken || undefined,
        refreshToken: record.refreshToken || undefined,
      },
    }

    if (record.accessToken || record.refreshToken || record.idToken) {
      this.applyTokenDataToSlot(
        slot,
        this.hydrateTokenData({
          idToken: record.idToken || "",
          accessToken: record.accessToken || "",
          refreshToken: record.refreshToken || "",
          accountId: record.accountId || "",
          workspaceId: record.workspaceId || "",
          email: record.email || "",
          expire: record.expire || "",
        })
      )
    }

    return slot
  }

  private refreshFileSlotFromRecord(
    slot: CodexAccountSlot,
    record: LoadedCodexAccountRecord,
    fallbackBaseUrl: string,
    fallbackProxyUrl: string
  ): void {
    slot.label = record.label || record.email || undefined
    slot.apiKey = record.apiKey || undefined
    slot.accountId = record.accountId || undefined
    slot.workspaceId = record.workspaceId || undefined
    slot.email = record.email || undefined
    slot.planType = normalizeCodexModelTier(record.planType) || undefined
    slot.baseUrl = record.baseUrl || fallbackBaseUrl
    slot.proxyUrl = record.proxyUrl || fallbackProxyUrl || undefined
    slot.configPath = record.configPath
    slot.persistedMatch = {
      apiKey: record.apiKey || undefined,
      email: record.email || undefined,
      accountId: record.accountId || undefined,
      accessToken: record.accessToken || undefined,
      refreshToken: record.refreshToken || undefined,
    }

    if (record.accessToken || record.refreshToken || record.idToken) {
      this.applyTokenDataToSlot(
        slot,
        this.hydrateTokenData({
          idToken: record.idToken || "",
          accessToken: record.accessToken || "",
          refreshToken: record.refreshToken || "",
          accountId: record.accountId || "",
          workspaceId: record.workspaceId || "",
          email: record.email || "",
          expire: record.expire || "",
        })
      )
      return
    }

    slot.accessToken = undefined
    slot.refreshToken = undefined
    slot.tokenData = null
    slot.refreshPromise = undefined
  }

  private pruneConversationBindingsForSlots(slots: CodexAccountSlot[]): void {
    if (slots.length === 0 || this.conversationSlotBindings.size === 0) {
      return
    }

    const staleKeys = new Set(slots.map((slot) => this.getSlotStickyKey(slot)))
    for (const [conversationId, binding] of this.conversationSlotBindings) {
      if (staleKeys.has(binding.slotKey)) {
        this.conversationSlotBindings.delete(conversationId)
      }
    }
  }

  private normalizeCodexModelName(modelName: string): string {
    return modelName.toLowerCase().trim()
  }

  private getCodexDisplayModel(modelName: string): string {
    const normalized = this.normalizeCodexModelName(modelName)
    return getPublicModelMetadata(normalized)?.displayName || normalized
  }

  private hasRateLimitData(account: CodexAccountSlot): boolean {
    for (const snapshots of account.rateLimitSnapshots.values()) {
      if (snapshots.request || snapshots.probe) {
        return true
      }
    }
    return false
  }

  private getEffectiveRateLimitSnapshot(
    snapshots?: Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  ): CodexRateLimitSnapshot | null {
    if (!snapshots) {
      return null
    }

    if (snapshots.request) {
      return snapshots.request
    }

    return snapshots.probe || null
  }

  private getRateLimitModelSummary(
    account: CodexAccountSlot,
    modelName: string
  ): CodexRateLimitModelSummary | null {
    const normalized = this.normalizeCodexModelName(modelName)
    const snapshots = account.rateLimitSnapshots.get(normalized)
    const effective = this.getEffectiveRateLimitSnapshot(snapshots)

    if (!snapshots && !effective) {
      return null
    }

    const request = snapshots?.request
    const probe = snapshots?.probe
    const updatedAt = Math.max(
      request?.updatedAt || 0,
      probe?.updatedAt || 0,
      effective?.updatedAt || 0
    )

    return {
      model: normalized,
      displayModel: this.getCodexDisplayModel(normalized),
      effective,
      request,
      probe,
      updatedAt,
    }
  }

  private getRateLimitAccountSummary(
    account: CodexAccountSlot
  ): CodexRateLimitAccountSummary | undefined {
    const models = Array.from(account.rateLimitSnapshots.keys())
      .map((modelName) => this.getRateLimitModelSummary(account, modelName))
      .filter(
        (summary): summary is CodexRateLimitModelSummary => summary != null
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)

    if (models.length === 0) {
      return undefined
    }

    const preferred =
      models.find(
        (summary) => summary.model === DEFAULT_CODEX_RATE_LIMIT_MODEL
      ) || null
    const effective = preferred?.effective || models[0]?.effective || null
    const updatedAt = preferred?.updatedAt || models[0]?.updatedAt || null
    return {
      effective,
      models,
      updatedAt,
    }
  }

  private setRateLimitSnapshot(
    slot: CodexAccountSlot,
    snapshot: CodexRateLimitSnapshot
  ): void {
    const normalized = this.normalizeCodexModelName(snapshot.model)
    const existing = slot.rateLimitSnapshots.get(normalized) || {}
    existing[snapshot.source] = {
      ...snapshot,
      model: normalized,
      displayModel: this.getCodexDisplayModel(normalized),
    }
    slot.rateLimitSnapshots.set(normalized, existing)
  }

  private getQuotaRemainingPercent(
    account: CodexAccountSlot,
    tier: "primary" | "secondary",
    modelName: string
  ): number | null {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    const usedPercent = effective?.[tier]?.usedPercent
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
      return null
    }

    return Math.max(0, 100 - usedPercent)
  }

  private getQuotaCooldownUntil(
    account: CodexAccountSlot,
    tier: "primary" | "secondary",
    modelName: string
  ): number {
    const effective = this.getRateLimitModelSummary(
      account,
      modelName
    )?.effective
    const remainingPercent = this.getQuotaRemainingPercent(
      account,
      tier,
      modelName
    )
    const resetsAt = effective?.[tier]?.resetsAt

    if (
      remainingPercent === null ||
      remainingPercent >= 1 ||
      typeof resetsAt !== "number" ||
      !Number.isFinite(resetsAt)
    ) {
      return 0
    }

    return resetsAt * 1000
  }

  private getWeeklyQuotaCooldownUntil(
    account: CodexAccountSlot,
    modelName: string
  ): number {
    return this.getQuotaCooldownUntil(account, "secondary", modelName)
  }

  private getPrimaryQuotaCooldownUntil(
    account: CodexAccountSlot,
    modelName: string
  ): number {
    return this.getQuotaCooldownUntil(account, "primary", modelName)
  }

  private getRateLimitQuotaCooldownUntil(
    snapshot: CodexRateLimitSnapshot | null,
    now: number
  ): number {
    if (!snapshot) {
      return 0
    }

    const windows = [snapshot.primary, snapshot.secondary]
    const activeResets = windows
      .map((window) => {
        if (!window) {
          return 0
        }
        const remainingPercent = Math.max(0, 100 - window.usedPercent)
        if (
          remainingPercent >= 1 ||
          typeof window.resetsAt !== "number" ||
          !Number.isFinite(window.resetsAt)
        ) {
          return 0
        }
        return window.resetsAt * 1000
      })
      .filter((cooldownUntil) => cooldownUntil > now)

    return activeResets.length > 0 ? Math.max(...activeResets) : 0
  }

  private isRateLimitExhaustedForModel(
    slot: CodexAccountSlot,
    model: string
  ): boolean {
    const primaryRemaining = this.getQuotaRemainingPercent(
      slot,
      "primary",
      model
    )
    if (primaryRemaining != null && primaryRemaining < 1) {
      return true
    }

    const secondaryRemaining = this.getQuotaRemainingPercent(
      slot,
      "secondary",
      model
    )
    if (secondaryRemaining != null && secondaryRemaining < 1) {
      return true
    }

    return false
  }

  private isSlotAvailableForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): boolean {
    if (this.isRateLimitExhaustedForModel(slot, model)) {
      return false
    }

    const weeklyQuotaCooldownUntil = this.getWeeklyQuotaCooldownUntil(
      slot,
      model
    )
    if (weeklyQuotaCooldownUntil > now) {
      return false
    }

    const primaryQuotaCooldownUntil = this.getPrimaryQuotaCooldownUntil(
      slot,
      model
    )
    if (primaryQuotaCooldownUntil > now) {
      return false
    }

    return isAccountAvailableForModel(slot, model, now)
  }

  private getSlotRecoveryTimeForModel(
    slot: CodexAccountSlot,
    model: string,
    now: number
  ): number | null {
    if (isAccountDisabled(slot) || !this.isModelSupportedBySlot(slot, model)) {
      return null
    }

    const recoveryCandidates: number[] = []

    if (slot.cooldownUntil > now) {
      recoveryCandidates.push(slot.cooldownUntil)
    }

    const modelState = slot.modelStates.get(model)
    if (modelState?.cooldownUntil && modelState.cooldownUntil > now) {
      recoveryCandidates.push(modelState.cooldownUntil)
    }

    const primaryQuotaCooldownUntil = this.getPrimaryQuotaCooldownUntil(
      slot,
      model
    )
    if (primaryQuotaCooldownUntil > now) {
      recoveryCandidates.push(primaryQuotaCooldownUntil)
    }

    const weeklyQuotaCooldownUntil = this.getWeeklyQuotaCooldownUntil(
      slot,
      model
    )
    if (weeklyQuotaCooldownUntil > now) {
      recoveryCandidates.push(weeklyQuotaCooldownUntil)
    }

    if (recoveryCandidates.length === 0) {
      return null
    }

    return Math.max(...recoveryCandidates)
  }

  private getActiveModelCooldowns(
    account: CodexAccountSlot,
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
    account: CodexAccountSlot,
    modelCooldowns: BackendPoolStatus["entries"][number]["modelCooldowns"],
    now: number
  ): BackendPoolEntryState {
    if (isAccountDisabled(account)) {
      return "disabled"
    }

    const activeQuotaCooldowns = Array.from(account.rateLimitSnapshots.values())
      .map((snapshots) =>
        this.getRateLimitQuotaCooldownUntil(
          this.getEffectiveRateLimitSnapshot(snapshots),
          now
        )
      )
      .filter((cooldownUntil) => cooldownUntil > now)

    if (activeQuotaCooldowns.length > 0) {
      account.cooldownUntil = Math.max(
        account.cooldownUntil,
        ...activeQuotaCooldowns
      )
    }

    if (account.cooldownUntil > now) {
      return "cooldown"
    }
    if (modelCooldowns.length > 0) {
      return "model_cooldown"
    }
    return "ready"
  }

  /**
   * Round-robin: pick the next available account, respecting cooldowns.
   *
   * @param model - The model being requested (for per-model cooldown checks)
   * @returns The slot, or null if all accounts are in cooldown
   */
  private pickNextAvailableAccount(model: string): CodexAccountSlot | null {
    const normalized = model.toLowerCase().trim()
    const candidate = this.findNextAvailableAccount(normalized)
    if (candidate) {
      this.accountIndex = (candidate.index + 1) % this.accounts.length
      return candidate.slot
    }

    this.logger.warn(
      `[Codex] All supporting account(s) are in cooldown for model=${normalized}`
    )
    return null
  }

  /**
   * Persist refreshed OAuth metadata to the appropriate backing store.
   */
  private persistSlotTokens(slot: CodexAccountSlot): void {
    if (!slot.tokenData) return

    if (slot.source === "env") {
      this.authService.persistTokenData(slot.tokenData)
      return
    }

    this.persistFileBackedAccount(slot)
  }

  /**
   * Persist a refreshed file-backed OAuth slot back into codex-accounts.json.
   */
  private persistFileBackedAccount(slot: CodexAccountSlot): void {
    if (!slot.tokenData) return

    try {
      const filePath =
        slot.configPath || this.accountsFilePath || CODEX_ACCOUNTS_DEFAULT_PATH
      const payload: { accounts: PersistedCodexAccountRecord[] } = {
        accounts: [],
      }

      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
          accounts?: PersistedCodexAccountRecord[]
        }
        payload.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
      }

      const existingIndex = payload.accounts.findIndex((account) => {
        if (
          slot.persistedMatch?.apiKey &&
          account.apiKey === slot.persistedMatch.apiKey
        ) {
          return true
        }
        if (
          slot.persistedMatch?.refreshToken &&
          account.refreshToken === slot.persistedMatch.refreshToken
        ) {
          return true
        }
        if (
          slot.persistedMatch?.accessToken &&
          account.accessToken === slot.persistedMatch.accessToken
        ) {
          return true
        }

        const matchEmail = slot.persistedMatch?.email || slot.email || ""
        const matchAccountId =
          slot.persistedMatch?.accountId || slot.accountId || ""
        return (
          (account.email || "") === matchEmail &&
          (account.accountId || "") === matchAccountId
        )
      })

      const currentRecord: PersistedCodexAccountRecord = {
        ...(existingIndex >= 0 ? payload.accounts[existingIndex] : {}),
        ...(slot.label ? { label: slot.label } : {}),
        ...(slot.apiKey ? { apiKey: slot.apiKey } : {}),
        ...(slot.email ? { email: slot.email } : {}),
        ...(slot.baseUrl ? { baseUrl: slot.baseUrl } : {}),
        ...(slot.proxyUrl ? { proxyUrl: slot.proxyUrl } : {}),
        accessToken: slot.tokenData.accessToken,
        refreshToken: slot.tokenData.refreshToken,
        idToken: slot.tokenData.idToken,
        accountId: this.getSlotAccountId(slot) || undefined,
        workspaceId:
          slot.workspaceId || slot.tokenData.workspaceId || undefined,
        planType: this.getSlotPlanType(slot) || undefined,
        expire: slot.tokenData.expire || undefined,
      }

      Object.keys(currentRecord).forEach((key) => {
        const typedKey = key as keyof PersistedCodexAccountRecord
        if (!currentRecord[typedKey]) {
          delete currentRecord[typedKey]
        }
      })

      if (existingIndex >= 0) {
        payload.accounts[existingIndex] = currentRecord
      } else {
        payload.accounts.push(currentRecord)
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8")
      slot.configPath = filePath
      slot.persistedMatch = {
        apiKey: slot.apiKey,
        email: slot.email,
        accountId: slot.accountId,
        accessToken: slot.accessToken,
        refreshToken: slot.refreshToken,
      }
    } catch (error) {
      this.logger.warn(
        `Failed to persist Codex account to ${this.accountsFilePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Get the bearer token for authentication.
   * Refreshes OAuth credentials per slot without mutating singleton service state.
   */
  private async getBearerToken(slot: CodexAccountSlot): Promise<string> {
    if (slot.apiKey) return slot.apiKey

    if (slot.tokenData) {
      const tokenData = await this.ensureFreshTokenData(slot)
      if (tokenData?.accessToken) {
        return tokenData.accessToken
      }
    }

    return slot.accessToken || ""
  }

  /**
   * Refresh an OAuth slot once, sharing the in-flight refresh per slot.
   */
  private async ensureFreshTokenData(
    slot: CodexAccountSlot
  ): Promise<CodexTokenData | null> {
    if (!slot.tokenData) {
      return null
    }

    if (!this.authService.isTokenExpired(slot.tokenData)) {
      return slot.tokenData
    }

    if (!slot.tokenData.refreshToken) {
      return slot.tokenData
    }

    if (!slot.refreshPromise) {
      slot.refreshPromise = (async () => {
        this.logger.log(
          `[Codex] Refreshing token for ${this.getAccountLabel(slot)}`
        )
        try {
          const refreshed = await this.authService.refreshTokensWithRetry(
            slot.tokenData?.refreshToken || "",
            3,
            { persist: false, updateState: false }
          )
          this.applyTokenDataToSlot(slot, refreshed)
          this.persistSlotTokens(slot)
          return slot.tokenData
        } catch (error) {
          this.logger.error(
            `[Codex] Token refresh failed for ${this.getAccountLabel(slot)}: ${error instanceof Error ? error.message : String(error)}`
          )
          return null
        } finally {
          slot.refreshPromise = undefined
        }
      })()
    }

    const refreshed = await slot.refreshPromise
    return refreshed || slot.tokenData
  }

  /**
   * Attempt to refresh a slot's token on 401/403.
   * Reuses slot.refreshPromise to prevent concurrent refresh-token rotation violations.
   * Returns the new accessToken on success, null on failure.
   */
  private async tryRefreshSlotToken(
    slot: CodexAccountSlot,
    reason: string
  ): Promise<string | null> {
    if (this.isApiKeyMode(slot) || !slot.tokenData?.refreshToken) {
      return null
    }

    // Reuse existing refresh promise to prevent concurrent rotation violations
    if (slot.refreshPromise) {
      const existing = await slot.refreshPromise
      return existing?.accessToken || null
    }

    slot.refreshPromise = (async () => {
      this.logger.log(
        `[Codex] ${reason}: forcing token refresh for ${this.getAccountLabel(slot)}`
      )
      try {
        const refreshed = await this.authService.refreshTokensWithRetry(
          slot.tokenData?.refreshToken || "",
          2,
          { persist: false, updateState: false }
        )
        this.applyTokenDataToSlot(slot, refreshed)
        this.persistSlotTokens(slot)
        return slot.tokenData
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          `[Codex] ${reason}: token refresh failed for ${this.getAccountLabel(slot)}: ${errorMsg}`
        )

        // Refresh token rotation violation or revoked → permanently disable
        // this account to stop the pool from repeatedly selecting a slot
        // whose credentials are permanently invalid.
        const lowerMsg = errorMsg.toLowerCase()
        if (
          lowerMsg.includes("already been used") ||
          lowerMsg.includes("refresh_token_reused") ||
          lowerMsg.includes("token_invalidated") ||
          lowerMsg.includes("token has been invalidated")
        ) {
          disableAccount(slot, "token_invalidated", {
            statusCode: 401,
            message: errorMsg,
            accountLabel: this.getAccountLabel(slot),
          })
          this.persistCodexAccountStates()
        }
        return null
      } finally {
        slot.refreshPromise = undefined
      }
    })()

    const result = await slot.refreshPromise
    return result?.accessToken || null
  }

  /**
   * Determine if the slot is using an API key (vs OAuth access token).
   */
  private isApiKeyMode(slot: CodexAccountSlot): boolean {
    return !!slot.apiKey
  }

  private readProxyEnvValue(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = process.env[key] || process.env[key.toLowerCase()]
      const normalized = value?.trim()
      if (normalized) {
        return normalized
      }
    }

    return undefined
  }

  /**
   * Build an undici dispatcher for Codex HTTP fetches.
   * Uses the selected slot's proxyUrl, then falls back to standard proxy env vars.
   */
  private buildProxyDispatcher(
    slot: CodexAccountSlot
  ): import("undici").Dispatcher | undefined {
    const explicitProxyUrl = slot.proxyUrl?.trim()
    if (explicitProxyUrl) {
      if (explicitProxyUrl.toLowerCase() === "direct") {
        return undefined
      }

      return this.buildExplicitProxyDispatcher(explicitProxyUrl)
    }

    return this.buildEnvProxyDispatcher()
  }

  private buildExplicitProxyDispatcher(
    proxyUrl: string
  ): import("undici").Dispatcher | undefined {
    try {
      const parsed = new URL(proxyUrl)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        this.logger.error(
          `Unsupported Codex HTTP proxy scheme for fetch: ${parsed.protocol}`
        )
        return undefined
      }

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ProxyAgent } = require("undici") as typeof import("undici")
      return new ProxyAgent(proxyUrl)
    } catch (e) {
      this.logger.error(`Failed to parse proxy URL: ${(e as Error).message}`)
      return undefined
    }
  }

  private buildEnvProxyDispatcher(): import("undici").Dispatcher | undefined {
    const allProxy = this.readProxyEnvValue(["ALL_PROXY"])
    const httpProxy = this.readProxyEnvValue(["HTTP_PROXY"]) || allProxy
    const httpsProxy =
      this.readProxyEnvValue(["HTTPS_PROXY"]) || allProxy || httpProxy
    const noProxy = this.readProxyEnvValue(["NO_PROXY"])

    if (!httpProxy && !httpsProxy) {
      return undefined
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { EnvHttpProxyAgent } = require("undici") as typeof import("undici")
      return new EnvHttpProxyAgent({
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
      })
    } catch (e) {
      this.logger.error(
        `Failed to configure proxy dispatcher from env: ${(e as Error).message}`
      )
      return undefined
    }
  }

  /**
   * Build request headers matching CLIProxyAPI Codex behavior.
   */
  private buildHeaders(
    slot: CodexAccountSlot,
    token: string,
    stream: boolean,
    cacheHeaders?: Record<string, string>,
    options?: {
      conversationId?: string
      omitAccountId?: boolean
      forwardHeaders?: CodexForwardHeaders
    }
  ): Record<string, string> {
    return buildCodexHttpHeaders({
      token,
      isApiKey: this.isApiKeyMode(slot),
      conversationId: options?.conversationId,
      accountId: this.getSlotAccountId(slot),
      workspaceId: slot.workspaceId,
      stream,
      cacheHeaders,
      forwardHeaders: options?.forwardHeaders,
      omitAccountId: options?.omitAccountId,
      identity: {
        version: this.identity.version(),
        userAgent: this.identity.userAgent(),
        originator: this.identity.originator(),
      },
    })
  }

  /**
   * Parse retry-after from Codex rate limit errors.
   * Ported from: codex_executor.go parseCodexRetryAfter()
   */
  private parseRetryAfter(
    statusCode: number,
    errorBody: string
  ): number | null {
    if (statusCode !== 429) return null

    try {
      const parsed = JSON.parse(errorBody) as Record<string, unknown>
      const error = parsed.error as Record<string, unknown> | undefined
      if (!error) return null

      if (error.type !== "usage_limit_reached") return null

      // Check resets_at (Unix timestamp)
      const resetsAt = error.resets_at as number | undefined
      if (resetsAt && resetsAt > 0) {
        const now = Math.floor(Date.now() / 1000)
        if (resetsAt > now) {
          return resetsAt - now
        }
      }

      // Check resets_in_seconds
      const resetsInSeconds = error.resets_in_seconds as number | undefined
      if (resetsInSeconds && resetsInSeconds > 0) {
        return resetsInSeconds
      }
    } catch {
      // Ignore parse errors
    }

    return null
  }

  private summarizeErrorBody(errorBody: string): string {
    const trimmed = errorBody.trim()
    if (!trimmed) {
      return ""
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const error =
        parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : undefined
      const message =
        (typeof error?.message === "string" && error.message.trim()) ||
        (typeof parsed.message === "string" && parsed.message.trim()) ||
        trimmed

      return message.slice(0, 200)
    } catch {
      return trimmed.slice(0, 200)
    }
  }

  private extractErrorCode(errorBody: string): string | null {
    const trimmed = errorBody.trim()
    if (!trimmed) {
      return null
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const detail =
        parsed.detail && typeof parsed.detail === "object"
          ? (parsed.detail as Record<string, unknown>)
          : undefined
      const error =
        parsed.error && typeof parsed.error === "object"
          ? (parsed.error as Record<string, unknown>)
          : undefined

      const code = detail?.code ?? error?.code
      return typeof code === "string" && code.trim() ? code.trim() : null
    } catch {
      return null
    }
  }

  private isDeactivatedWorkspaceError(errorBody: string): boolean {
    return this.extractErrorCode(errorBody) === "deactivated_workspace"
  }

  private createCodexApiError(
    statusCode: number,
    errorBody: string
  ): CodexApiError {
    const retryAfter = this.parseRetryAfter(statusCode, errorBody)
    const details = this.summarizeErrorBody(errorBody)

    if (retryAfter != null) {
      const suffix = details ? ` ${details}` : ""
      return new CodexApiError(
        statusCode,
        `Codex rate limited. Retry after ${retryAfter} seconds.${suffix}`,
        retryAfter
      )
    }

    const message = details
      ? `Codex API error ${statusCode}: ${details}`
      : `Codex API error ${statusCode}`

    return new CodexApiError(statusCode, message)
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
  }

  private parseCodexSsePayload(line: string): Record<string, unknown> | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) {
      return null
    }

    const jsonStr = trimmed.slice(5).trim()
    if (!jsonStr || jsonStr === "[DONE]") {
      return null
    }

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }

  private logCodexUsage(
    transport: "http" | "websocket",
    modelName: string,
    cacheId: string,
    slot: CodexAccountSlot,
    event: Record<string, unknown> | null,
    requestStartedAt?: number
  ): void {
    if (!event || event.type !== "response.completed") {
      return
    }

    const response =
      event.response && typeof event.response === "object"
        ? (event.response as Record<string, unknown>)
        : null
    const usage =
      response?.usage && typeof response.usage === "object"
        ? (response.usage as Record<string, unknown>)
        : null

    const totalInputTokens = this.toNumber(usage?.input_tokens)
    const outputTokens = this.toNumber(usage?.output_tokens)
    const cachedTokens =
      usage?.input_tokens_details &&
      typeof usage.input_tokens_details === "object"
        ? this.toNumber(
            (usage.input_tokens_details as Record<string, unknown>)
              .cached_tokens
          )
        : 0
    const cacheCreationTokens =
      typeof usage?.cache_creation_input_tokens === "number"
        ? this.toNumber(usage.cache_creation_input_tokens)
        : 0
    const webSearchRequests =
      usage?.server_tool_use &&
      typeof usage.server_tool_use === "object" &&
      typeof (usage.server_tool_use as Record<string, unknown>)
        .web_search_requests === "number"
        ? this.toNumber(
            (usage.server_tool_use as Record<string, unknown>)
              .web_search_requests
          )
        : 0
    const inputTokens = Math.max(0, totalInputTokens - cachedTokens)
    const durationMs =
      typeof requestStartedAt === "number"
        ? Math.max(0, Date.now() - requestStartedAt)
        : 0

    const message =
      `[Codex][Cache] transport=${transport} model=${modelName} ` +
      `cache=${cacheId || "(none)"} input=${inputTokens} ` +
      `cached=${cachedTokens} cacheWrite=${cacheCreationTokens} ` +
      `output=${outputTokens} duration=${durationMs}ms`

    this.usageStats.recordCodexUsage({
      transport,
      modelName,
      accountKey: this.getSlotStickyKey(slot),
      accountLabel: this.getAccountLabel(slot),
      inputTokens,
      cachedInputTokens: cachedTokens,
      cacheCreationInputTokens: cacheCreationTokens,
      outputTokens,
      webSearchRequests,
      durationMs,
    })

    if (cachedTokens > 0) {
      this.logger.log(message)
      return
    }

    this.logger.debug(message)
  }

  private summarizeCodexRequestForLogs(
    codexRequest: Record<string, unknown>
  ): string {
    const inputItems = Array.isArray(codexRequest.input)
      ? (codexRequest.input as Array<Record<string, unknown>>)
      : []
    const inputTypeCounts = new Map<string, number>()
    const callIds: string[] = []

    for (const item of inputItems) {
      const type =
        typeof item?.type === "string" && item.type.trim().length > 0
          ? item.type
          : "unknown"
      inputTypeCounts.set(type, (inputTypeCounts.get(type) || 0) + 1)

      const callId =
        typeof item?.call_id === "string" ? item.call_id.trim() : ""
      if (callId) {
        callIds.push(callId)
      }
    }

    const inputSummary =
      Array.from(inputTypeCounts.entries())
        .map(([type, count]) => `${type}:${count}`)
        .join(", ") || "none"
    const toolsCount = Array.isArray(codexRequest.tools)
      ? codexRequest.tools.length
      : 0
    const previousResponseId =
      typeof codexRequest.previous_response_id === "string" &&
      codexRequest.previous_response_id.trim().length > 0
        ? codexRequest.previous_response_id.trim()
        : ""
    const sampleCallIds =
      callIds.length > 0 ? callIds.slice(0, 4).join(",") : "-"

    return (
      `previous_response_id=${previousResponseId || "none"} ` +
      `input_items=${inputItems.length} [${inputSummary}] ` +
      `tools=${toolsCount} ` +
      `call_ids=${sampleCallIds}`
    )
  }

  /**
   * Build the Codex request URL.
   * Uses the selected slot's baseUrl.
   */
  private buildUrl(
    slot: CodexAccountSlot,
    endpoint: string = "responses"
  ): string {
    const baseUrl = slot.baseUrl || DEFAULT_BASE_URL
    return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`
  }

  /**
   * Get cache ID for the current request.
   */
  private getCacheId(
    request: Pick<
      CodexExecutionRequest,
      "cacheUserId" | "conversationId" | "model" | "pendingToolUseIds"
    >,
    slot: CodexAccountSlot
  ): string {
    this.pruneCodexRuntimeCaches()
    const conversationIdRaw = this.getConversationId(request)
    const useStableInitialCacheIdentity =
      !this.hasConversationContinuationState(
        conversationIdRaw,
        slot,
        request.model
      )
    const conversationId = useStableInitialCacheIdentity
      ? ""
      : this.getConversationId(request)
    if (conversationId) {
      return conversationId
    }

    const userId = request.cacheUserId?.trim()

    if (userId) {
      return this.cacheService.getOrCreateCacheId(request.model, userId)
    }

    if (slot.apiKey) {
      return this.cacheService.getCacheIdFromApiKey(slot.apiKey)
    }

    return this.cacheService.getCacheIdFromIdentity(
      this.getOAuthCacheIdentity(request, slot, {
        includeConversationId: !useStableInitialCacheIdentity,
      })
    )
  }

  private createAllAccountsRateLimitedError(modelName: string): CodexApiError {
    const now = Date.now()
    const normalizedModelName = modelName.toLowerCase().trim()
    let earliestRecovery = Infinity

    for (const slot of this.accounts) {
      const slotRecovery = this.getSlotRecoveryTimeForModel(
        slot,
        normalizedModelName,
        now
      )
      if (slotRecovery != null) {
        earliestRecovery = Math.min(earliestRecovery, slotRecovery)
      }
    }

    const retryAfterMs = Number.isFinite(earliestRecovery)
      ? Math.max(0, earliestRecovery - now)
      : 0
    const retrySeconds = retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 60
    return new CodexApiError(
      429,
      `All Codex accounts are rate-limited for model ${modelName}. ` +
        `Retry after ${retrySeconds} seconds.`,
      retrySeconds
    )
  }

  private findNextAvailableAccount(
    model: string
  ): { slot: CodexAccountSlot; index: number } | null {
    const now = Date.now()
    const normalized = model.toLowerCase().trim()

    for (let offset = 0; offset < this.accounts.length; offset++) {
      const index = (this.accountIndex + offset) % this.accounts.length
      const slot = this.accounts[index]!

      if (!this.isModelSupportedBySlot(slot, normalized)) {
        continue
      }

      if (this.isSlotAvailableForModel(slot, normalized, now)) {
        return { slot, index }
      }
    }

    return null
  }

  private findWarmPoolAccount(
    model: string
  ): { slot: CodexAccountSlot; index: number } | null {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return null
    }

    const now = Date.now()
    const normalized = model.toLowerCase().trim()

    for (let offset = 0; offset < this.accounts.length; offset++) {
      const index = (this.accountIndex + offset) % this.accounts.length
      const slot = this.accounts[index]!

      if (!this.isModelSupportedBySlot(slot, normalized)) {
        continue
      }

      if (!this.isSlotAvailableForModel(slot, normalized, now)) {
        continue
      }

      const wsUrl = this.wsService.buildWebSocketUrl(
        this.buildUrl(slot, "responses")
      )
      // Check cachedWsSessions or wsService for an available connection
      const cacheKey = this.getCachedWsKey(slot, normalized)
      const cached = this.cachedWsSessions.get(cacheKey)
      if (
        cached &&
        this.wsService.hasOpenSessionConnection(cached.wsSessionId, wsUrl)
      ) {
        return { slot, index }
      }
      // Also check connections keyed by cacheKey itself (created by startup warmup)
      if (this.wsService.hasOpenSessionConnection(cacheKey, wsUrl)) {
        return { slot, index }
      }
    }

    return null
  }

  private pickWarmPoolAccount(model: string): CodexAccountSlot | null {
    const candidate = this.findWarmPoolAccount(model)
    if (!candidate) {
      return null
    }

    this.accountIndex = (candidate.index + 1) % this.accounts.length
    return candidate.slot
  }

  private selectWarmupSlot(
    modelName: string,
    conversationId?: string
  ): CodexAccountSlot {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    if (!this.hasSupportingAccount(modelName)) {
      throw new CodexApiError(
        400,
        `Model ${modelName} is not supported by the configured Codex account(s).`
      )
    }

    if (conversationId) {
      const stickySlot = this.getStickyConversationSlot(
        conversationId,
        modelName
      )
      if (stickySlot) {
        return stickySlot
      }
    }

    const warmedSlot = this.findWarmPoolAccount(modelName)
    if (warmedSlot) {
      return warmedSlot.slot
    }

    const candidate = this.findNextAvailableAccount(modelName)
    if (!candidate) {
      throw this.createAllAccountsRateLimitedError(modelName)
    }

    return candidate.slot
  }

  private selectRequestSlot(
    modelName: string,
    conversationId?: string,
    options?: {
      preferWarmPool?: boolean
    }
  ): CodexAccountSlot {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    if (!this.hasSupportingAccount(modelName)) {
      throw new CodexApiError(
        400,
        `Model ${modelName} is not supported by the configured Codex account(s).`
      )
    }

    if (conversationId) {
      const stickySlot = this.getStickyConversationSlot(
        conversationId,
        modelName
      )
      if (stickySlot) {
        return stickySlot
      }
    }

    if (options?.preferWarmPool) {
      const warmPoolSlot = this.pickWarmPoolAccount(modelName)
      if (warmPoolSlot) {
        return warmPoolSlot
      }
    }

    const slot = this.pickNextAvailableAccount(modelName)
    if (!slot) {
      throw this.createAllAccountsRateLimitedError(modelName)
    }
    return slot
  }

  // ── Non-streaming ────────────────────────────────────────────────────

  /**
   * Send a non-streaming message through Codex.
   */
  async sendMessage(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    this.onLiveRequestStart()
    try {
      return await this.executeWithCooldownRetry(request, forwardHeaders, 1)
    } finally {
      this.onLiveRequestEnd()
    }
  }

  async sendClaudeMessage(
    dto: CreateMessageDto,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    return this.sendMessage(
      createCodexExecutionRequestFromClaude(dto),
      forwardHeaders
    )
  }

  async compactConversationHistory(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<CodexReplacementHistoryItem[]> {
    this.onLiveRequestStart()
    try {
      return await this.compactConversationHistoryWithRetry(
        request,
        forwardHeaders,
        1
      )
    } finally {
      this.onLiveRequestEnd()
    }
  }

  private async compactConversationHistoryWithRetry(
    request: CodexExecutionRequest,
    forwardHeaders: CodexForwardHeaders | undefined,
    attempt: number,
    slot?: CodexAccountSlot
  ): Promise<CodexReplacementHistoryItem[]> {
    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    const modelName = request.model
    const conversationId =
      this.getConversationId(request) || `compact-${crypto.randomUUID()}`
    const requestSlot =
      slot ||
      this.selectRequestSlot(modelName, conversationId, {
        preferWarmPool: false,
      })
    const token = await this.getBearerToken(requestSlot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(conversationId, requestSlot)

    const codexRequest = buildCodexRequest(
      { ...request, conversationId },
      modelName
    )
    const payload: Record<string, unknown> = {
      model: codexRequest.model,
      input: codexRequest.input,
      instructions: codexRequest.instructions,
      tools: codexRequest.tools || [],
      parallel_tool_calls: codexRequest.parallel_tool_calls !== false,
      reasoning: codexRequest.reasoning,
      text: codexRequest.text,
    }
    const url = this.buildUrl(requestSlot, "responses/compact")
    const headers = this.buildHeaders(requestSlot, token, false, undefined, {
      conversationId,
      forwardHeaders,
    })
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    }
    const dispatcher = this.buildProxyDispatcher(requestSlot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)
    try {
      if (!response.ok) {
        const errorBody = await response.text()
        throw this.createCodexApiError(response.status, errorBody)
      }
      this.captureCodexRateLimitHeaders(
        response.headers,
        requestSlot,
        modelName,
        "request"
      )
      markAccountSuccess(requestSlot, modelName)

      const parsed = (await response.json()) as { output?: unknown }
      if (!Array.isArray(parsed.output)) {
        throw new CodexApiError(
          502,
          "Codex compact response did not include output history."
        )
      }
      return parsed.output.flatMap((item) =>
        item && typeof item === "object"
          ? [{ ...(item as Record<string, unknown>) }]
          : []
      )
    } catch (error) {
      if (error instanceof CodexApiError) {
        const statusCode = error.getStatus()
        if (
          (statusCode === 401 || statusCode === 403) &&
          attempt === 1 &&
          !this.isApiKeyMode(requestSlot)
        ) {
          const newToken = await this.tryRefreshSlotToken(
            requestSlot,
            `${statusCode} compact`
          )
          if (newToken) {
            return this.compactConversationHistoryWithRetry(
              request,
              forwardHeaders,
              attempt + 1,
              requestSlot
            )
          }
        }

        const retryAfterHeader = error.retryAfterSeconds?.toString()
        markAccountCooldown(
          requestSlot,
          statusCode,
          modelName,
          retryAfterHeader,
          this.getAccountLabel(requestSlot)
        )

        if (
          (statusCode === 401 || statusCode === 403 || statusCode === 429) &&
          attempt < this.accounts.length
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== requestSlot) {
            this.logger.log(
              `[Codex] compact ${statusCode} on ${this.getAccountLabel(requestSlot)}, retrying with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.compactConversationHistoryWithRetry(
              request,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
          }
        }
      }
      throw error
    }
  }

  /**
   * Execute a one-shot web search via the Codex Responses API server-side
   * `web_search` tool. The model is asked a single user question that wraps
   * the supplied query, the server runs `web_search_call` items end-to-end,
   * and we collect every `url_citation` annotation plus any final assistant
   * text into the same shape the Google backend returns from
   * `executeWebSearch()` — so callers can stay backend-agnostic.
   */
  async executeWebSearch(input: {
    query: string
    model?: string
    conversationId?: string
    signal?: AbortSignal
  }): Promise<{
    text: string
    references: Array<{ title: string; url: string; chunk: string }>
  }> {
    const query = input.query.trim()
    if (!query) {
      return { text: "", references: [] }
    }

    if (this.accounts.length === 0) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const requestedModel = input.model?.trim() || ""
    const modelName =
      requestedModel && this.hasSupportingAccount(requestedModel)
        ? requestedModel
        : DEFAULT_CODEX_RATE_LIMIT_MODEL
    const conversationId =
      input.conversationId || `web-search-${crypto.randomUUID()}`
    const slot = this.selectRequestSlot(modelName, conversationId, {
      preferWarmPool: false,
    })
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const codexRequest = buildCodexRequest(
      {
        model: modelName,
        conversationId,
        messages: [
          {
            role: "user",
            content:
              "Use the web_search tool to find authoritative, recent results " +
              "for the following query, then summarize the findings in a few " +
              "sentences and list the sources you used.\n\n" +
              `Query: ${query}`,
          },
        ],
        tools: [
          {
            type: "web_search",
            name: "web_search",
            description: "Server-side web search backed by the Codex backend.",
            external_web_access: true,
          },
        ],
        parallelToolCalls: false,
        textVerbosity: "low",
      },
      modelName
    ) as Record<string, unknown>

    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, undefined, {
      conversationId,
    })
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(codexRequest),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)])
        : AbortSignal.timeout(300_000),
    }
    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      const errorBody = await response.text()
      throw this.createCodexApiError(response.status, errorBody)
    }
    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )

    if (!response.body) {
      throw new Error("Codex response has no body")
    }

    const summaryParts: string[] = []
    const references: Array<{ title: string; url: string; chunk: string }> = []
    const seenUrls = new Set<string>()

    const collectFromContentBlock = (block: unknown): void => {
      if (!block || typeof block !== "object") return
      const record = block as Record<string, unknown>
      if (typeof record.text === "string" && record.text.trim()) {
        summaryParts.push(record.text)
      }
      const annotations = record.annotations
      if (Array.isArray(annotations)) {
        for (const ann of annotations) {
          if (!ann || typeof ann !== "object") continue
          const a = ann as Record<string, unknown>
          if (a.type !== "url_citation" && a.type !== "web_search_citation") {
            continue
          }
          const refUrl = typeof a.url === "string" ? a.url.trim() : ""
          if (!refUrl || seenUrls.has(refUrl)) continue
          seenUrls.add(refUrl)
          references.push({
            title: (typeof a.title === "string" && a.title.trim()) || refUrl,
            url: refUrl,
            chunk:
              typeof a.quote === "string"
                ? a.quote
                : typeof a.text === "string"
                  ? a.text
                  : "",
          })
        }
      }
    }

    const collectFromOutputItem = (item: unknown): void => {
      if (!item || typeof item !== "object") return
      const record = item as Record<string, unknown>
      const itemType = record.type
      if (itemType === "message") {
        const content = record.content
        if (Array.isArray(content)) {
          for (const block of content) {
            collectFromContentBlock(block)
          }
        }
      }
      // web_search_call items can carry sources / queries on completion.
      if (itemType === "web_search_call") {
        const action = record.action
        if (action && typeof action === "object") {
          const sources = (action as Record<string, unknown>).sources
          if (Array.isArray(sources)) {
            for (const src of sources) {
              if (!src || typeof src !== "object") continue
              const s = src as Record<string, unknown>
              const srcUrl = typeof s.url === "string" ? s.url.trim() : ""
              if (!srcUrl || seenUrls.has(srcUrl)) continue
              seenUrls.add(srcUrl)
              references.push({
                title:
                  (typeof s.title === "string" && s.title.trim()) || srcUrl,
                url: srcUrl,
                chunk:
                  typeof s.snippet === "string"
                    ? s.snippet
                    : typeof s.text === "string"
                      ? s.text
                      : "",
              })
            }
          }
        }
      }
    }

    const processPayload = (payload: Record<string, unknown>): boolean => {
      if (payload.type === "response.output_item.done" && payload.item) {
        collectFromOutputItem(payload.item)
      }

      if (
        payload.type === "response.completed" &&
        payload.response &&
        typeof payload.response === "object"
      ) {
        const responseOutput = (payload.response as Record<string, unknown>)
          .output
        if (Array.isArray(responseOutput)) {
          for (const outputItem of responseOutput) {
            collectFromOutputItem(outputItem)
          }
        }
        return true
      }

      return false
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let completed = false

    try {
      while (!completed) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          const payload = this.parseCodexSsePayload(line.trim())
          if (payload && processPayload(payload)) {
            completed = true
            break
          }
        }
      }

      const tail = buffer.trim()
      if (!completed && tail) {
        const payload = this.parseCodexSsePayload(tail)
        if (payload) {
          processPayload(payload)
        }
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }

    markAccountSuccess(slot, modelName)

    const text = summaryParts.length > 0 ? summaryParts.join("\n").trim() : ""
    return { text, references }
  }

  async generateImage(input: {
    prompt: string
    model?: string
    conversationId?: string
    outputFormat?: string
  }): Promise<{
    imageData: string
    revisedPrompt?: string
    status?: string
  }> {
    const prompt = input.prompt.trim()
    if (!prompt) {
      throw new Error("Image generation prompt is required")
    }

    const requestedModel = input.model?.trim() || ""
    const modelName =
      requestedModel && this.hasSupportingAccount(requestedModel)
        ? requestedModel
        : DEFAULT_CODEX_RATE_LIMIT_MODEL
    const conversationId =
      input.conversationId || `image-${crypto.randomUUID()}`
    const slot = this.selectRequestSlot(modelName, conversationId, {
      preferWarmPool: false,
    })
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    const codexRequest = buildCodexRequest(
      {
        model: modelName,
        conversationId,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        tools: [
          {
            type: "image_generation",
            name: "image_generation",
            description: "Generate an image from the user prompt.",
            output_format: input.outputFormat?.trim() || "png",
          },
        ],
        parallelToolCalls: false,
        textVerbosity: "low",
      },
      modelName
    ) as Record<string, unknown>

    const url = this.buildUrl(slot, "responses")
    const headers = this.buildHeaders(slot, token, true, undefined, {
      conversationId,
    })
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: JSON.stringify(codexRequest),
      signal: AbortSignal.timeout(600_000),
    }
    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)
    if (!response.ok) {
      const errorBody = await response.text()
      throw this.createCodexApiError(response.status, errorBody)
    }

    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )
    const fullBody = await response.text()
    let imageData = ""
    let revisedPrompt: string | undefined
    let status: string | undefined

    for (const line of fullBody.split("\n")) {
      const payload = this.parseCodexSsePayload(line.trim())
      const item =
        payload?.type === "response.output_item.done" &&
        payload.item &&
        typeof payload.item === "object"
          ? (payload.item as Record<string, unknown>)
          : undefined
      if (item?.type === "image_generation_call") {
        if (typeof item.result === "string" && item.result.trim()) {
          imageData = item.result.trim()
        }
        if (typeof item.revised_prompt === "string") {
          revisedPrompt = item.revised_prompt
        }
        if (typeof item.status === "string") {
          status = item.status
        }
      }

      const responseOutput =
        payload?.type === "response.completed" &&
        payload.response &&
        typeof payload.response === "object"
          ? (payload.response as Record<string, unknown>).output
          : undefined
      if (Array.isArray(responseOutput)) {
        for (const outputItem of responseOutput) {
          if (
            outputItem &&
            typeof outputItem === "object" &&
            (outputItem as Record<string, unknown>).type ===
              "image_generation_call"
          ) {
            const record = outputItem as Record<string, unknown>
            if (typeof record.result === "string" && record.result.trim()) {
              imageData = record.result.trim()
            }
            if (typeof record.revised_prompt === "string") {
              revisedPrompt = record.revised_prompt
            }
            if (typeof record.status === "string") {
              status = record.status
            }
          }
        }
      }
    }

    if (!imageData) {
      throw new Error("Codex image_generation completed without image data")
    }

    markAccountSuccess(slot, modelName)
    return { imageData, revisedPrompt, status }
  }

  /**
   * Core execution logic with cooldown-aware account selection and
   * automatic retry on 429 (switches to next available account).
   */
  private async executeWithCooldownRetry(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders,
    attempt: number = 1,
    slot: CodexAccountSlot = this.selectRequestSlot(
      request.model,
      this.getConversationId(request),
      {
        preferWarmPool: !this.hasConversationContinuationState(
          this.getConversationId(request)
        ),
      }
    )
  ): Promise<AnthropicResponse> {
    const modelName = request.model
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getConversationId(request), slot)

    const reverseToolMap = buildReverseMapFromClaudeTools(request.tools)
    let codexRequest = buildCodexRequest(request, modelName) as Record<
      string,
      unknown
    >

    const cacheId = this.getCacheId(request, slot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    try {
      let result: AnthropicResponse

      // Try WebSocket transport first when enabled.
      if (this.useWebSocket && this.wsService.isWebSocketAvailable()) {
        try {
          result = await this.sendViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            request,
            forwardHeaders
          )
        } catch (e) {
          if (e instanceof CodexWebSocketUpgradeError) {
            if (
              !this.isApiKeyMode(slot) &&
              this.isDeactivatedWorkspaceError(e.body)
            ) {
              this.logger.warn(
                `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}, retrying over HTTP without Chatgpt-Account-Id`
              )
              result = await this.sendViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                this.getConversationId(request),
                true,
                forwardHeaders
              )
            } else if (e.shouldFallbackToHttp()) {
              this.logger.warn(
                "WebSocket upgrade rejected, falling back to HTTP"
              )
              result = await this.sendViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                this.getConversationId(request),
                false,
                forwardHeaders
              )
            } else {
              throw this.createCodexApiError(
                e.statusCode || 502,
                e.body || e.message
              )
            }
          } else if (this.shouldFallbackToHttpAfterWebSocketError(e)) {
            this.logger.warn(
              `[Codex] WebSocket transport unavailable, falling back to HTTP: ${e instanceof Error ? e.message : String(e)}`
            )
            result = await this.sendViaHttp(
              slot,
              token,
              codexRequest,
              modelName,
              reverseToolMap,
              cacheId,
              this.getConversationId(request),
              false,
              forwardHeaders
            )
          } else {
            throw e
          }
        }
      } else {
        result = await this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId,
          this.getConversationId(request),
          false,
          forwardHeaders
        )
      }

      // Success — clear any cooldown on this slot
      markAccountSuccess(slot, modelName)
      return result
    } catch (e) {
      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()

        // 401/403: 尝试 refresh token 后用同一 slot 重试一次，避免直接 cooldown
        if (
          (statusCode === 401 || statusCode === 403) &&
          attempt === 1 &&
          !this.isApiKeyMode(slot)
        ) {
          const newToken = await this.tryRefreshSlotToken(
            slot,
            `${statusCode} non-stream retry`
          )
          if (newToken) {
            return this.executeWithCooldownRetry(
              request,
              forwardHeaders,
              attempt + 1,
              slot
            )
          }
        }

        const retryAfterHeader = e.retryAfterSeconds?.toString()
        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          retryAfterHeader,
          this.getAccountLabel(slot)
        )

        // 401/403: refresh 失败后，尝试用下一个可用账号重试（跨 slot 故障转移）
        if (
          (statusCode === 401 || statusCode === 403) &&
          attempt < this.accounts.length
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] ${statusCode} on ${this.getAccountLabel(slot)}, ` +
                `falling over to ${this.getAccountLabel(nextSlot)} ` +
                `(attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.executeWithCooldownRetry(
              request,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
          }
        }

        // Auto-retry on 429 if another account is available
        if (statusCode === 429 && attempt < this.accounts.length) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            return this.executeWithCooldownRetry(
              request,
              forwardHeaders,
              attempt + 1,
              nextSlot
            )
          }
        }
      }
      throw e
    }
  }

  /**
   * Send non-streaming via HTTP.
   */
  private async sendViaHttp(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    conversationId?: string,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl(slot, "responses")
    const cacheHeaders = this.cacheService.buildHttpCacheHeaders(cacheId)
    const headers = this.buildHeaders(slot, token, true, cacheHeaders, {
      conversationId,
      omitAccountId,
      forwardHeaders,
    })

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=http omitAccountId=${omitAccountId} accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(headers["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(headers["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] Non-stream request: model=${modelName}, url=${url}, reasoning=${JSON.stringify((codexRequest as { reasoning?: unknown }).reasoning ?? null)}, service_tier=${JSON.stringify((codexRequest as { service_tier?: unknown }).service_tier ?? null)}`
    )

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(300_000),
    }

    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const response = await fetch(url, fetchOptions)

    if (!response.ok) {
      const errorBody = await response.text()
      this.logger.error(
        `[Codex] Request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
      )

      if (
        !omitAccountId &&
        !this.isApiKeyMode(slot) &&
        this.isDeactivatedWorkspaceError(errorBody)
      ) {
        this.logger.warn(
          `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}, retrying without Chatgpt-Account-Id`
        )
        return this.sendViaHttp(
          slot,
          token,
          codexRequest,
          modelName,
          reverseToolMap,
          cacheId,
          conversationId,
          true,
          forwardHeaders
        )
      }

      throw this.createCodexApiError(response.status, errorBody)
    }

    // Read the full SSE stream and find response.completed
    this.captureCodexRateLimitHeaders(
      response.headers,
      slot,
      modelName,
      "request"
    )
    const fullBody = await response.text()
    const lines = fullBody.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue

      const jsonStr = trimmed.slice(5).trim()
      if (!jsonStr || jsonStr === "[DONE]") continue

      try {
        const event = JSON.parse(jsonStr) as Record<string, unknown>
        if (event.type === "response.completed") {
          this.logCodexUsage(
            "http",
            modelName,
            cacheId,
            slot,
            event,
            requestStartedAt
          )
          const result = translateCodexToClaudeNonStream(event, reverseToolMap)
          if (result) {
            this.logger.log(
              `[Codex] Non-stream response: model=${result.model}, stop=${result.stop_reason}`
            )
            return result
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    throw new Error("Codex stream ended without response.completed event")
  }

  /**
   * Send non-streaming via WebSocket.
   */
  private async sendViaWebSocket(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    request: Pick<
      CodexExecutionRequest,
      "conversationId" | "model" | "pendingToolUseIds"
    >,
    forwardHeaders?: CodexForwardHeaders
  ): Promise<AnthropicResponse> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const cacheHeaders = this.cacheService.buildWebSocketCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      this.getConversationId(request),
      this.getSlotAccountId(slot),
      slot.workspaceId,
      cacheHeaders,
      forwardHeaders
    )
    const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)
    const conversationIdForSession = this.getConversationId(request)
    const sessionId =
      conversationIdForSession || this.getCachedWsKey(slot, request.model)
    const conversationId = this.getConversationId(request)

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=websocket omitAccountId=false accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(wsHeaders["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(wsHeaders["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] WebSocket non-stream request: model=${modelName}, url=${wsUrl}`
    )
    this.logger.debug(
      `[Codex][WS Request] ${this.summarizeCodexRequestForLogs(wsBody)}`
    )
    if (sessionId && conversationId && sessionId !== conversationId) {
      this.logger.debug(
        `[Codex] Reusing warm WebSocket pool session ${sessionId} for initial request conversation=${conversationId}`
      )
    }

    const executeRequest = async (
      ws: WebSocket
    ): Promise<AnthropicResponse> => {
      const completedEvent = await this.wsService.sendViaWebSocket(ws, wsBody)
      this.logCodexUsage(
        "websocket",
        modelName,
        cacheId,
        slot,
        completedEvent as Record<string, unknown>,
        requestStartedAt
      )

      const result = translateCodexToClaudeNonStream(
        completedEvent as Record<string, unknown>,
        reverseToolMap
      )
      if (!result) {
        throw new Error("WebSocket response did not contain valid completion")
      }

      this.logger.log(
        `[Codex] WebSocket non-stream response: model=${result.model}, stop=${result.stop_reason}`
      )
      return result
    }

    if (!sessionId) {
      this.logger.log(
        `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=websocket-stream omitAccountId=false accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(wsHeaders["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(wsHeaders["Chatgpt-Account-Id"] || null)}`
      )
      this.logger.log(
        `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
      )
      this.logger.debug(
        `[Codex][WS Request] ${this.summarizeCodexRequestForLogs(
          this.wsService.buildWebSocketRequestBody(codexRequest)
        )}`
      )
      const ws = await this.wsService.connect(
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      try {
        return await executeRequest(ws)
      } finally {
        ws.close()
      }
    }

    const { release } = await this.wsService.acquireSession(sessionId)
    try {
      let ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )

      try {
        return await executeRequest(ws)
      } catch (error) {
        if (!this.shouldRetrySessionWebSocketError(error)) {
          throw error
        }

        this.logger.warn(
          `[Codex] Reconnecting stale WebSocket session ${sessionId} before retry`
        )
        this.wsService.invalidateSessionConnection(sessionId, ws)
        ws = await this.wsService.ensureSessionConnection(
          sessionId,
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        return executeRequest(ws)
      }
    } finally {
      release()
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────

  /**
   * Send a streaming message through Codex.
   * Returns an async generator yielding Claude SSE event strings.
   */
  async *sendMessageStream(
    request: CodexExecutionRequest,
    forwardHeadersOrAbortSignal?: CodexForwardHeaders | AbortSignal,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const forwardHeaders =
      forwardHeadersOrAbortSignal instanceof AbortSignal
        ? undefined
        : forwardHeadersOrAbortSignal
    const resolvedAbortSignal =
      forwardHeadersOrAbortSignal instanceof AbortSignal
        ? forwardHeadersOrAbortSignal
        : abortSignal

    const conversationId = this.getConversationId(request)
    const releaseConversationLock =
      await this.acquireConversationStreamLock(conversationId)

    this.onLiveRequestStart()
    try {
      yield* this.executeStreamWithCooldownRetry(
        request,
        forwardHeaders,
        resolvedAbortSignal,
        1
      )
    } finally {
      this.onLiveRequestEnd()
      releaseConversationLock()
    }
  }

  async *sendClaudeMessageStream(
    dto: CreateMessageDto,
    forwardHeadersOrAbortSignal?: CodexForwardHeaders | AbortSignal,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    yield* this.sendMessageStream(
      createCodexExecutionRequestFromClaude(dto),
      forwardHeadersOrAbortSignal,
      abortSignal
    )
  }

  async prewarmSessionConnection(
    request: Pick<
      CodexExecutionRequest,
      "model" | "conversationId" | "cacheUserId" | "pendingToolUseIds"
    >,
    options?: {
      forwardHeaders?: CodexForwardHeaders
      reason?: string
      /**
       * 完整的 CodexRequest 请求体（由 buildCodexRequest 构建）。
       * 当提供时，连接建立后会发送 generate:false 的 warmup payload，
       * 对齐官方 Codex CLI（session_startup_prewarm.rs）的 prompt cache 预热行为。
       */
      warmupPayload?: Record<string, unknown>
    }
  ): Promise<void> {
    if (!this.useWebSocket || !this.wsService.isWebSocketAvailable()) {
      return
    }

    let slot: CodexAccountSlot
    let wsUrl: string
    let sessionId: string
    try {
      const modelName = request.model
      const conversationId = this.getConversationId(request)
      slot = this.selectWarmupSlot(modelName, conversationId)
      const httpUrl = this.buildUrl(slot, "responses")
      wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
      const cacheKey = this.getCachedWsKey(
        slot,
        request.model,
        conversationId || undefined
      )
      const cached = this.cachedWsSessions.get(cacheKey)
      sessionId = cached?.wsSessionId || conversationId || cacheKey

      // Warmup 只准备可复用的 connection cache，不创建 active turn context。
      // ConversationCodexSession.active 只属于真实 stream turn，避免 warmup 占用或污染 turn lifecycle。
      if (!cached) {
        this.setCachedWsSession(cacheKey, {
          wsSessionId: sessionId,
          turnKey: undefined,
          turnState: undefined,
          lastResponse: undefined,
          lastRequest: undefined,
          updatedAt: Date.now(),
        })
      }
    } catch (error) {
      this.logger.debug(
        `[Codex][Warmup] reason=${options?.reason?.trim() || "request"} model=${request.model} skipped before dispatch: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }

    const existingWarmup = this.sessionWarmupPromises.get(sessionId)
    if (existingWarmup) {
      return existingWarmup
    }

    const warmupReason = options?.reason?.trim() || "request"
    const warmupPromise = this.runSessionWarmup(
      request,
      slot,
      wsUrl,
      sessionId,
      options?.forwardHeaders,
      warmupReason,
      options?.warmupPayload
    )
      .catch((error) => {
        // Warmup 401 时主动 refresh token，为后续实际请求做准备
        if (
          error instanceof CodexWebSocketUpgradeError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          this.tryRefreshSlotToken(slot, "warmup-401").catch(() => {})
        }
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${request.model} skipped: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (this.sessionWarmupPromises.get(sessionId) === warmupPromise) {
          this.sessionWarmupPromises.delete(sessionId)
        }
      })

    this.sessionWarmupPromises.set(sessionId, warmupPromise)
    return warmupPromise
  }

  private async runSessionWarmup(
    request: Pick<
      CodexExecutionRequest,
      "model" | "conversationId" | "cacheUserId" | "pendingToolUseIds"
    >,
    slot: CodexAccountSlot,
    wsUrl: string,
    sessionId: string,
    forwardHeaders: CodexForwardHeaders | undefined,
    warmupReason: string,
    warmupPayload?: Record<string, unknown>
  ): Promise<void> {
    const modelName = request.model
    const conversationId = this.getConversationId(request)
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }

    this.bindConversationToSlot(conversationId, slot)

    const cacheId = this.getCacheId(request, slot)
    const cacheHeaders = this.cacheService.buildWebSocketCacheHeaders(cacheId)
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      conversationId,
      this.getSlotAccountId(slot),
      slot.workspaceId,
      cacheHeaders,
      forwardHeaders
    )

    const { release } = await this.wsService.acquireSession(sessionId)
    const startedAt = Date.now()
    try {
      const session = this.wsService.getOrCreateSession(sessionId)
      const reusedConnection =
        !!session.conn &&
        session.wsUrl === wsUrl &&
        session.conn.readyState === 1

      const ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )

      // A connection-only warmup may rebuild the transport before the real
      // continuation request reaches streamViaWebSocket(). Do not clear the
      // response chain here; the next real request will validate the strict
      // delta and the stale-response retry path will handle server rejection.

      // Send generate:false warmup payload to prime the server-side prompt cache (mirrors Codex CLI).
      //
      // IMPORTANT: Only send warmup payload for initial-chat warmups (session startup).
      // The official Codex CLI only does prewarm_websocket() when last_request.is_none()
      // (i.e., before the first request in a session). For continuation warmups
      // (shell-continuation, tool-continuation), sending generate:false creates a new
      // response on the server that breaks the previous_response_id chain — the server
      // won't recognize the response_id from the actual request because it belongs to
      // a different chain than the warmup response.
      //
      // Skip conditions:
      // 1. Connection was reused (no new connection to warm up)
      // 2. Conversation already has a cached response_id (would invalidate it)
      // 3. This is a continuation warmup (not initial-chat) — mirrors official CLI behavior
      const isContinuationWarmup =
        warmupReason.includes("continuation") ||
        warmupReason.includes("shell") ||
        warmupReason.includes("tool")
      const cachedEntry = this.cachedWsSessions.get(
        this.getCachedWsKey(slot, modelName, conversationId || undefined)
      )
      const skipWarmupPayload =
        isContinuationWarmup ||
        (!!conversationId &&
          (this.hasActiveTurnContext(conversationId) ||
            !!cachedEntry?.lastResponse?.responseId))
      if (warmupPayload && !reusedConnection && !skipWarmupPayload) {
        let warmupBody = { ...warmupPayload }
        if (cacheId) {
          warmupBody = this.cacheService.injectCacheKey(warmupBody, cacheId)
        }
        const wsBody = this.wsService.buildWarmupRequestBody(warmupBody)

        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} sending generate:false payload`
        )

        try {
          await this.wsService.sendWarmupRequest(ws, wsBody)
          this.logger.debug(
            `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} warmup payload completed duration=${Date.now() - startedAt}ms`
          )
        } catch (warmupError) {
          // warmup payload 失败不应阻塞后续实际请求，连接已建立就够了
          this.logger.warn(
            `[Codex][Warmup] reason=${warmupReason} session=${sessionId} warmup payload failed: ${warmupError instanceof Error ? warmupError.message : String(warmupError)}`
          )
        }
      } else {
        this.logger.debug(
          `[Codex][Warmup] reason=${warmupReason} session=${sessionId} model=${modelName} slot=${this.getAccountLabel(slot)} reused=${reusedConnection} connection-only duration=${Date.now() - startedAt}ms`
        )
      }
    } finally {
      release()
    }
  }

  // ── ProviderAdapter Interface ────────────────────────────────────────

  /**
   * ProviderAdapter.warmup() — fire-and-forget connection prewarming.
   * Translates the provider-agnostic ProviderWarmupHint into the Codex-specific
   * prewarmSessionConnection() call, using the internal warmupPayloadCache.
   */
  warmup(hint: ProviderWarmupHint): void {
    const warmupPayload =
      hint.warmupPayload || this.getWarmupPayloadCache(hint.conversationId)

    void this.prewarmSessionConnection(
      {
        model: hint.model,
        conversationId: hint.conversationId,
        pendingToolUseIds:
          hint.pendingToolUseIds && hint.pendingToolUseIds.length > 0
            ? hint.pendingToolUseIds
            : undefined,
      },
      {
        reason: hint.reason,
        warmupPayload,
      }
    )
  }

  /**
   * Internal warmup payload cache management.
   * Previously exposed as a ProviderAdapter method and called from the protocol bridge.
   * Now fully internal — auto-cached during executeStreamWithCooldownRetry().
   */
  private cacheWarmupPayload(
    conversationId: string,
    payload: Record<string, unknown>
  ): void {
    this.setWarmupPayloadCache(conversationId, payload)
  }

  /**
   * ProviderAdapter.dispose() — release all resources for a conversation.
   * Returns WS connection to cache (via disposeTurnContext) and clears warmup cache.
   * Called by SessionLifecycleService when a session expires or is deleted.
   */
  dispose(conversationId: string): void {
    const normalized = conversationId.trim()
    if (!normalized) return
    // 一次性清空 ConversationCodexSession（含 active turn + streamTail）。
    // 不需要 disposeTurnContext，因为 conversation 即将销毁，cache 已无意义。
    this.conversationSessions.delete(normalized)
    this.warmupPayloadCache.delete(normalized)
    // 同步清理这个 conversation 维度的 cachedWsSessions 条目。
    for (const [key, entry] of this.cachedWsSessions) {
      if (entry.wsSessionId === normalized) {
        this.cachedWsSessions.delete(key)
      }
    }
  }

  private async *executeStreamWithCooldownRetry(
    request: CodexExecutionRequest,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal,
    attempt: number = 1,
    slot: CodexAccountSlot = this.selectRequestSlot(
      request.model,
      this.getConversationId(request),
      {
        preferWarmPool: !this.hasConversationContinuationState(
          this.getConversationId(request)
        ),
      }
    )
  ): AsyncGenerator<string, void, unknown> {
    const modelName = request.model
    const token = await this.getBearerToken(slot)
    if (!token) {
      throw new Error(
        "Codex backend not configured: no API key or access token"
      )
    }
    this.bindConversationToSlot(this.getConversationId(request), slot)

    const reverseToolMap = buildReverseMapFromClaudeTools(request.tools)
    let codexRequest = buildCodexRequest(request, modelName) as Record<
      string,
      unknown
    >

    // Auto-cache warmup payload for future continuation warmups.
    // This replaces the external cacheWarmupPayload() call from the protocol bridge,
    // ensuring the adapter always has an up-to-date warmup snapshot.
    const conversationId = this.getConversationId(request)
    if (conversationId) {
      this.setWarmupPayloadCache(
        conversationId,
        extractWarmupPayload(codexRequest as CodexRequest)
      )
    }

    const cacheId = this.getCacheId(request, slot)
    if (cacheId) {
      codexRequest = this.cacheService.injectCacheKey(codexRequest, cacheId)
    }

    // ── Turn-scoped context management ─────────────────────────────────
    // Each executeStreamWithCooldownRetry() call = one turn.
    // Create a fresh turn context at entry; dispose in finally.
    // This matches the official Codex CLI ModelClientSession lifecycle:
    //   client.new_session() → turn → Drop → store_cached_websocket_session
    const turnKey = this.getCodexTurnKey(codexRequest)
    if (conversationId) {
      this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
    }

    let emittedEvents = false

    try {
      // Try WebSocket transport first when enabled.
      if (this.useWebSocket && this.wsService.isWebSocketAvailable()) {
        try {
          for await (const event of this.streamViaWebSocket(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            request,
            forwardHeaders,
            abortSignal
          )) {
            emittedEvents = true
            yield event
          }
          markAccountSuccess(slot, modelName)
          return
        } catch (e) {
          const abortedError = toUpstreamRequestAbortedError(
            e,
            abortSignal,
            "Codex WebSocket stream aborted"
          )
          if (abortedError) {
            throw abortedError
          }

          if (e instanceof CodexWebSocketUpgradeError) {
            if (
              !this.isApiKeyMode(slot) &&
              this.isDeactivatedWorkspaceError(e.body)
            ) {
              this.logger.warn(
                `[Codex] WebSocket returned deactivated_workspace for ${this.getAccountLabel(slot)}, retrying stream over HTTP without Chatgpt-Account-Id`
              )
              for await (const event of this.streamViaHttp(
                slot,
                token,
                codexRequest,
                modelName,
                reverseToolMap,
                cacheId,
                this.getConversationId(request),
                true,
                forwardHeaders,
                abortSignal
              )) {
                emittedEvents = true
                yield event
              }
              markAccountSuccess(slot, modelName)
              return
            }

            if (e.shouldFallbackToHttp()) {
              this.logger.warn(
                "WebSocket upgrade rejected, falling back to HTTP for streaming"
              )
            } else {
              throw this.createCodexApiError(
                e.statusCode || 502,
                e.body || e.message
              )
            }
          } else if (
            !emittedEvents &&
            this.shouldFallbackToHttpAfterWebSocketError(e)
          ) {
            this.logger.warn(
              `[Codex] WebSocket streaming unavailable, falling back to HTTP: ${e instanceof Error ? e.message : String(e)}`
            )
          } else {
            throw e
          }
        }
      }

      for await (const event of this.streamViaHttp(
        slot,
        token,
        codexRequest,
        modelName,
        reverseToolMap,
        cacheId,
        this.getConversationId(request),
        false,
        forwardHeaders,
        abortSignal
      )) {
        emittedEvents = true
        yield event
      }
      markAccountSuccess(slot, modelName)
    } catch (e) {
      const abortedError = toUpstreamRequestAbortedError(
        e,
        abortSignal,
        "Codex stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }

      if (e instanceof CodexApiError) {
        const statusCode = e.getStatus()

        // 401/403: 尚未输出任何 event 时，尝试 refresh token 后用同一 slot 重试
        if (
          (statusCode === 401 || statusCode === 403) &&
          attempt === 1 &&
          !emittedEvents &&
          !this.isApiKeyMode(slot)
        ) {
          const newToken = await this.tryRefreshSlotToken(
            slot,
            `${statusCode} stream retry`
          )
          if (newToken) {
            // Dispose current turn context before retry so the inner call gets a fresh one
            if (conversationId) {
              this.disposeTurnContext(conversationId, slot, modelName)
            }
            yield* this.executeStreamWithCooldownRetry(
              request,
              forwardHeaders,
              abortSignal,
              attempt + 1,
              slot
            )
            return
          }
        }

        // 网关瞬时错误（502 / 503 / 504）：常见于 "upstream connect error" 或
        // "reset reason: connection termination" —— 上游边缘代理把 TCP 连接掐
        // 断，并不代表账号不可用。立即 markAccountCooldown 会让单账号场景
        // 1 分钟内完全失活、整个 turn 直接 fail（参见 bridge 日志中
        // delete_file -> PostToolContinuation 的 503 中断）。
        // 策略：第一次失败时先在同一 slot 上短暂 backoff 后重试一次；
        // 仍然失败再走原有的 cooldown + 跨账号故障转移路径。
        const isGatewayTransient =
          statusCode === 502 || statusCode === 503 || statusCode === 504
        if (isGatewayTransient && !emittedEvents && attempt === 1) {
          this.logger.warn(
            `[Codex] ${statusCode} transient gateway error on ${this.getAccountLabel(slot)} ` +
              `(${e.message}); retrying same slot once before cooldown`
          )
          if (conversationId) {
            this.disposeTurnContext(conversationId, slot, modelName)
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
          yield* this.executeStreamWithCooldownRetry(
            request,
            forwardHeaders,
            abortSignal,
            attempt + 1,
            slot
          )
          return
        }

        markAccountCooldown(
          slot,
          statusCode,
          modelName,
          e.retryAfterSeconds?.toString(),
          this.getAccountLabel(slot)
        )

        // 网关瞬时错误：同 slot 重试已经失败，如果还有其它可用账号就跨 slot
        // 故障转移；只剩一个账号时就直接落到下面的 throw 让上层处理
        if (
          isGatewayTransient &&
          !emittedEvents &&
          attempt < this.accounts.length
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] ${statusCode} persisted on ${this.getAccountLabel(slot)}, ` +
                `failing over to ${this.getAccountLabel(nextSlot)} ` +
                `(attempt ${attempt + 1}/${this.accounts.length})`
            )
            if (conversationId) {
              this.disposeTurnContext(conversationId, slot, modelName)
            }
            yield* this.executeStreamWithCooldownRetry(
              request,
              forwardHeaders,
              abortSignal,
              attempt + 1,
              nextSlot
            )
            return
          }
        }

        // 401/403: refresh 失败后，尝试用下一个可用账号重试（跨 slot 故障转移）
        if (
          (statusCode === 401 || statusCode === 403) &&
          !emittedEvents &&
          attempt < this.accounts.length
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] ${statusCode} on ${this.getAccountLabel(slot)}, ` +
                `falling over to ${this.getAccountLabel(nextSlot)} ` +
                `(attempt ${attempt + 1}/${this.accounts.length})`
            )
            // Dispose current turn context before failover to different slot
            if (conversationId) {
              this.disposeTurnContext(conversationId, slot, modelName)
            }
            yield* this.executeStreamWithCooldownRetry(
              request,
              forwardHeaders,
              abortSignal,
              attempt + 1,
              nextSlot
            )
            return
          }
        }

        // Auto-retry on 429 if another account is available
        if (
          statusCode === 429 &&
          attempt < this.accounts.length &&
          !emittedEvents
        ) {
          const nextSlot = this.pickNextAvailableAccount(modelName)
          if (nextSlot && nextSlot !== slot) {
            this.logger.log(
              `[Codex] 429 on ${this.getAccountLabel(slot)}, retrying streamed request with ${this.getAccountLabel(nextSlot)} (attempt ${attempt + 1}/${this.accounts.length})`
            )
            // Dispose current turn context before failover to different slot
            if (conversationId) {
              this.disposeTurnContext(conversationId, slot, modelName)
            }
            yield* this.executeStreamWithCooldownRetry(
              request,
              forwardHeaders,
              abortSignal,
              attempt + 1,
              nextSlot
            )
            return
          }
        }
      }
      throw e
    } finally {
      // ── Turn end: return WS connection to cache ──────────────────────
      // Mirrors Drop for ModelClientSession → store_cached_websocket_session.
      // The connection is returned to cachedWsSessions for reuse by the next turn.
      if (conversationId) {
        this.disposeTurnContext(conversationId, slot, modelName)
      }
    }
  }

  /**
   * Stream via HTTP SSE transport.
   */
  private async *streamViaHttp(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    conversationId?: string,
    omitAccountId: boolean = false,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const requestBody = JSON.stringify(codexRequest)
    const url = this.buildUrl(slot, "responses")
    const cacheHeaders = this.cacheService.buildHttpCacheHeaders(cacheId)
    const headers = this.buildHeaders(slot, token, true, cacheHeaders, {
      conversationId,
      omitAccountId,
      forwardHeaders,
    })

    this.logger.log(
      `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=http-stream omitAccountId=${omitAccountId} accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(headers["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(headers["Chatgpt-Account-Id"] || null)}`
    )
    this.logger.log(
      `[Codex] Stream request: model=${modelName}, url=${url}, reasoning=${JSON.stringify((codexRequest as { reasoning?: unknown }).reasoning ?? null)}, service_tier=${JSON.stringify((codexRequest as { service_tier?: unknown }).service_tier ?? null)}`
    )

    const requestSignal = createAbortSignalWithTimeout(600_000, abortSignal)
    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers,
      body: requestBody,
      signal: requestSignal.signal,
    }

    const dispatcher = this.buildProxyDispatcher(slot)
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher
    }

    const state = createStreamState()
    let firstUpstreamMs: number | undefined
    let firstContentMs: number | undefined
    let firstContentType: string | undefined

    try {
      const response = await fetch(url, fetchOptions)

      if (!response.ok) {
        const errorBody = await response.text()
        this.logger.error(
          `[Codex] Stream request failed: status=${response.status}, body=${errorBody.slice(0, 500)}`
        )

        if (
          !omitAccountId &&
          !this.isApiKeyMode(slot) &&
          this.isDeactivatedWorkspaceError(errorBody)
        ) {
          this.logger.warn(
            `[Codex] deactivated_workspace for ${this.getAccountLabel(slot)}, retrying stream without Chatgpt-Account-Id`
          )
          yield* this.streamViaHttp(
            slot,
            token,
            codexRequest,
            modelName,
            reverseToolMap,
            cacheId,
            conversationId,
            true,
            forwardHeaders,
            abortSignal
          )
          return
        }

        throw this.createCodexApiError(response.status, errorBody)
      }

      if (!response.body) {
        throw new Error("Codex response has no body")
      }

      // Capture rate-limit headers from successful response
      this.captureCodexRateLimitHeaders(
        response.headers,
        slot,
        modelName,
        "request"
      )

      // Stream SSE events
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      try {
        while (true) {
          const externalAbort = createAbortPromise(
            abortSignal,
            "Codex HTTP stream aborted"
          )
          try {
            const { done, value } = await Promise.race([
              reader.read(),
              ...(externalAbort.promise ? [externalAbort.promise] : []),
            ])
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              const payload = this.parseCodexSsePayload(trimmed)

              if (
                firstUpstreamMs === undefined &&
                typeof payload?.type === "string"
              ) {
                firstUpstreamMs = Date.now() - requestStartedAt
                this.logger.debug(
                  `[Codex] First upstream HTTP event after ${firstUpstreamMs}ms: type=${payload.type}`
                )
              }
              if (
                firstContentMs === undefined &&
                (payload?.type === "response.output_text.delta" ||
                  payload?.type === "response.reasoning_summary_text.delta" ||
                  payload?.type === "response.function_call_arguments.delta")
              ) {
                firstContentMs = Date.now() - requestStartedAt
                firstContentType = String(payload.type)
                this.logger.debug(
                  `[Codex] First content HTTP event after ${firstContentMs}ms: type=${firstContentType}`
                )
              }

              this.logCodexUsage(
                "http",
                modelName,
                cacheId,
                slot,
                payload,
                requestStartedAt
              )

              const claudeEvents = translateCodexSseEvent(
                trimmed,
                state,
                reverseToolMap
              )
              for (const event of claudeEvents) {
                yield event
              }
            }
          } finally {
            externalAbort.cleanup()
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          const payload = this.parseCodexSsePayload(buffer.trim())
          if (
            firstUpstreamMs === undefined &&
            typeof payload?.type === "string"
          ) {
            firstUpstreamMs = Date.now() - requestStartedAt
            this.logger.debug(
              `[Codex] First upstream HTTP event after ${firstUpstreamMs}ms: type=${payload.type}`
            )
          }
          if (
            firstContentMs === undefined &&
            (payload?.type === "response.output_text.delta" ||
              payload?.type === "response.reasoning_summary_text.delta" ||
              payload?.type === "response.function_call_arguments.delta")
          ) {
            firstContentMs = Date.now() - requestStartedAt
            firstContentType = String(payload.type)
            this.logger.debug(
              `[Codex] First content HTTP event after ${firstContentMs}ms: type=${firstContentType}`
            )
          }
          this.logCodexUsage(
            "http",
            modelName,
            cacheId,
            slot,
            payload,
            requestStartedAt
          )
          const claudeEvents = translateCodexSseEvent(
            buffer.trim(),
            state,
            reverseToolMap
          )
          for (const event of claudeEvents) {
            yield event
          }
        }
      } finally {
        reader.releaseLock()
      }
    } catch (error) {
      if (requestSignal.didTimeout()) {
        throw new Error(
          "Codex stream timed out waiting for upstream response after 600000ms"
        )
      }
      const abortedError = toUpstreamRequestAbortedError(
        error,
        abortSignal,
        "Codex HTTP stream aborted"
      )
      if (abortedError) {
        throw abortedError
      }
      throw error
    } finally {
      requestSignal.cleanup()
    }

    this.logger.log(
      `[Codex] Stream completed: model=${modelName}, blocks=${state.blockIndex}, hasToolCall=${state.hasToolCall}`
    )
    const totalMs = Date.now() - requestStartedAt
    this.logger.log(
      `[Codex][TurnTiming] conv=${conversationId || "none"} ` +
        `transport=http model=${modelName} ` +
        `firstFrameMs=${firstUpstreamMs ?? -1} ` +
        `firstContentMs=${firstContentMs ?? -1} ` +
        `firstContentType=${firstContentType || "none"} ` +
        `totalMs=${totalMs} completed=true ` +
        `blocks=${state.blockIndex} hasToolCall=${state.hasToolCall} ` +
        `slot=${this.getAccountLabel(slot)}`
    )
  }

  /**
   * Stream via WebSocket transport.
   * Converts WebSocket JSON messages to SSE-formatted lines for the
   * existing response translator.
   */
  private async *streamViaWebSocket(
    slot: CodexAccountSlot,
    token: string,
    codexRequest: Record<string, unknown>,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    request: Pick<
      CodexExecutionRequest,
      "conversationId" | "model" | "pendingToolUseIds"
    >,
    forwardHeaders?: CodexForwardHeaders,
    abortSignal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const requestStartedAt = Date.now()
    const httpUrl = this.buildUrl(slot, "responses")
    const wsUrl = this.wsService.buildWebSocketUrl(httpUrl)
    const conversationId = this.getConversationId(request)
    const cacheHeaders = this.cacheService.buildWebSocketCacheHeaders(cacheId)
    const turnKey = this.getCodexTurnKey(codexRequest)
    // Use CodexTurnContext to obtain session ID (eliminates warm pool promotion)
    const turnContext = conversationId
      ? this.getOrCreateTurnContext(conversationId, slot, modelName, turnKey)
      : undefined
    const wsHeaders = this.wsService.buildWebSocketHeaders(
      token,
      this.isApiKeyMode(slot),
      conversationId,
      this.getSlotAccountId(slot),
      slot.workspaceId,
      cacheHeaders,
      forwardHeaders
    )
    this.applyCodexTurnStateHeader(wsHeaders, turnContext)
    const sessionId = turnContext?.wsSessionId || ""
    // P0.3 prewarm 配置：每个 turn 完成后用它在 turn 间隙异步起新连接，下个
    // turn 进入 ensureSessionConnection 时直接命中 OPEN 连接、零握手。
    // streamViaWebSocketConnection 内部用 (responseCompleted && sessionId)
    // 守卫，无 sessionId 路径自然不会触发 prewarm。
    const prewarmConfig = {
      wsUrl,
      wsHeaders,
      proxyUrl: slot.proxyUrl || undefined,
    }

    if (!sessionId) {
      const ws = await this.wsService.connect(
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      this.captureCodexTurnStateFromConnection(turnContext, ws)
      yield* this.streamViaWebSocketConnection(
        ws,
        slot,
        modelName,
        reverseToolMap,
        cacheId,
        codexRequest,
        requestStartedAt,
        "",
        abortSignal,
        conversationId,
        prewarmConfig
      )
      return
    }

    const { release } = await this.wsService.acquireSession(sessionId)
    try {
      // Check if the previous connection is still alive BEFORE ensureSessionConnection
      const sessionState = this.wsService.getOrCreateSession(sessionId)
      const hadOpenConnection =
        !!sessionState.conn &&
        sessionState.wsUrl === wsUrl &&
        sessionState.conn.readyState === 1 // WebSocket.OPEN

      let ws = await this.wsService.ensureSessionConnection(
        sessionId,
        wsUrl,
        wsHeaders,
        slot.proxyUrl || undefined
      )
      this.captureCodexTurnStateFromConnection(turnContext, ws)

      if (!hadOpenConnection && turnContext && conversationId) {
        const previousResponseId = turnContext.lastResponse?.responseId
        this.resetTurnContextResponseState(
          conversationId,
          "WebSocket connection was rebuilt before request"
        )
        this.logger.debug(
          previousResponseId
            ? `[Codex][TurnContext] Connection was rebuilt before stream request for ${conversationId}; cleared previous_response_id=${previousResponseId}`
            : `[Codex][TurnContext] Connection was rebuilt before stream request for ${conversationId}; no previous_response_id`
        )
      }

      // NOW inject previous_response_id — only after we know the connection is valid.
      // Mirrors prepare_websocket_request() + get_incremental_items().
      const originalCodexRequest = codexRequest
      if (turnContext && conversationId) {
        codexRequest = this.prepareRequestWithTurnContext(
          codexRequest,
          turnContext,
          conversationId
        )
      }

      try {
        this.logger.log(
          `[Codex][Dispatch] slot=${this.getAccountLabel(slot)} model=${modelName} transport=websocket-stream omitAccountId=false accountId=${JSON.stringify(this.getSlotAccountId(slot) || null)} workspaceId=${JSON.stringify(slot.workspaceId || null)} orgHeader=${JSON.stringify(wsHeaders["OpenAI-Organization"] || null)} accountHeader=${JSON.stringify(wsHeaders["Chatgpt-Account-Id"] || null)}`
        )
        this.logger.log(
          `[Codex] WebSocket stream request: model=${modelName}, url=${wsUrl}`
        )
        this.logger.debug(
          `[Codex][WS Request] ${this.summarizeCodexRequestForLogs(
            this.wsService.buildWebSocketRequestBody(codexRequest)
          )}`
        )

        yield* this.streamViaWebSocketConnection(
          ws,
          slot,
          modelName,
          reverseToolMap,
          cacheId,
          codexRequest,
          requestStartedAt,
          sessionId,
          abortSignal,
          conversationId,
          prewarmConfig
        )
        return
      } catch (error) {
        // Handle "Previous response with id ... not found" — the server evicted
        // the response from its cache. Clear turn context and retry with the full
        // input (no previous_response_id). This commonly happens when parallel
        // tool calls take long enough for the server-side session to expire.
        if (
          conversationId &&
          this.isStaleResponseIdError(error) &&
          codexRequest !== originalCodexRequest
        ) {
          this.logger.warn(
            `[Codex] Previous response_id rejected by server for ${conversationId}, ` +
              `retrying without previous_response_id (full input)`
          )
          this.resetTurnContextResponseState(
            conversationId,
            "Server rejected stale previous_response_id"
          )
          codexRequest = originalCodexRequest
          // 协议级错误：若 ws 仍 OPEN，streamViaSessionWebSocket 已通过
          // preserveConnection 保留它，直接复用，跳过 invalidate+ensure 的额外 RTT。
          const wsStillUsable = ws.readyState === WebSocket.OPEN
          if (wsStillUsable) {
            this.logger.debug(
              `[Codex][TurnContext] Reusing live WebSocket session=${sessionId} after prev_resp rejection`
            )
          } else {
            this.wsService.invalidateSessionConnection(sessionId, ws)
            this.applyCodexTurnStateHeader(wsHeaders, turnContext)
            ws = await this.wsService.ensureSessionConnection(
              sessionId,
              wsUrl,
              wsHeaders,
              slot.proxyUrl || undefined
            )
            this.captureCodexTurnStateFromConnection(turnContext, ws)
          }
          yield* this.streamViaWebSocketConnection(
            ws,
            slot,
            modelName,
            reverseToolMap,
            cacheId,
            codexRequest,
            Date.now(),
            sessionId,
            abortSignal,
            conversationId,
            prewarmConfig
          )
          return
        }

        if (!this.shouldRetrySessionWebSocketError(error)) {
          throw error
        }

        this.logger.warn(
          `[Codex] Reconnecting stale WebSocket session ${sessionId} before streamed retry`
        )
        this.wsService.invalidateSessionConnection(sessionId, ws)
        if (conversationId && turnContext) {
          const previousResponseId = turnContext.lastResponse?.responseId
          this.resetTurnContextResponseState(
            conversationId,
            "WebSocket connection was rebuilt before streamed retry"
          )
          if (previousResponseId) {
            this.logger.debug(
              `[Codex][TurnContext] Connection was rebuilt for streamed retry for ${conversationId}; cleared previous_response_id=${previousResponseId}`
            )
          }
        }
        codexRequest = originalCodexRequest
        this.applyCodexTurnStateHeader(wsHeaders, turnContext)
        ws = await this.wsService.ensureSessionConnection(
          sessionId,
          wsUrl,
          wsHeaders,
          slot.proxyUrl || undefined
        )
        this.captureCodexTurnStateFromConnection(turnContext, ws)
        yield* this.streamViaWebSocketConnection(
          ws,
          slot,
          modelName,
          reverseToolMap,
          cacheId,
          codexRequest,
          requestStartedAt,
          sessionId,
          abortSignal,
          conversationId,
          prewarmConfig
        )
      }
    } finally {
      release()
    }
  }

  private async *streamViaWebSocketConnection(
    ws: WebSocket,
    slot: CodexAccountSlot,
    modelName: string,
    reverseToolMap: Map<string, string>,
    cacheId: string,
    codexRequest: Record<string, unknown>,
    requestStartedAt: number,
    sessionId: string,
    abortSignal?: AbortSignal,
    conversationId?: string,
    prewarm?: {
      wsUrl: string
      wsHeaders: Record<string, string>
      proxyUrl?: string
    }
  ): AsyncGenerator<string, void, unknown> {
    const state = createStreamState()
    const itemsAdded: CodexInputItem[] = []
    let firstUpstreamMs: number | undefined
    let firstContentMs: number | undefined
    let firstContentType: string | undefined
    let responseCompleted = false
    const onAbort = () => {
      if (sessionId) {
        this.wsService.invalidateSessionConnection(sessionId, ws)
      } else {
        ws.close()
      }
    }

    try {
      if (abortSignal?.aborted) {
        throw new UpstreamRequestAbortedError(
          abortSignal.reason instanceof Error
            ? abortSignal.reason.message
            : "Codex WebSocket stream aborted"
        )
      }

      abortSignal?.addEventListener("abort", onAbort, { once: true })
      const wsBody = this.wsService.buildWebSocketRequestBody(codexRequest)

      for await (const msg of this.wsService.streamViaWebSocket(ws, wsBody)) {
        if (msg.type === "response.output_item.done") {
          const item = this.convertResponseOutputItemToInputItem(
            (msg as Record<string, unknown>).item as
              | Record<string, unknown>
              | undefined
          )
          if (item) {
            itemsAdded.push(item)
          }
        }

        if (msg.type === "response.completed") {
          responseCompleted = true
          // Mirrors map_response_stream() ResponseEvent::Completed → LastResponse.
          if (conversationId && sessionId) {
            const response = (msg as Record<string, unknown>).response as
              | Record<string, unknown>
              | undefined
            const capturedId =
              typeof response?.id === "string" ? response.id : ""
            if (capturedId) {
              this.captureResponseInTurnContext(
                conversationId,
                capturedId,
                itemsAdded
              )
            }
          }
        }
        if (firstUpstreamMs === undefined && msg.type) {
          firstUpstreamMs = Date.now() - requestStartedAt
          this.logger.debug(
            `[Codex] First upstream WebSocket event after ${firstUpstreamMs}ms: type=${msg.type}`
          )
        }
        if (
          firstContentMs === undefined &&
          (msg.type === "response.output_text.delta" ||
            msg.type === "response.reasoning_summary_text.delta" ||
            msg.type === "response.function_call_arguments.delta")
        ) {
          firstContentMs = Date.now() - requestStartedAt
          firstContentType = msg.type
          this.logger.debug(
            `[Codex] First content WebSocket event after ${firstContentMs}ms: type=${msg.type}`
          )
        }
        this.logCodexUsage(
          "websocket",
          modelName,
          cacheId,
          slot,
          msg as Record<string, unknown>,
          requestStartedAt
        )

        // Convert WebSocket message to SSE line for the translator
        const sseLine = `data: ${JSON.stringify(msg)}`
        const claudeEvents = translateCodexSseEvent(
          sseLine,
          state,
          reverseToolMap
        )
        for (const event of claudeEvents) {
          yield event
        }
      }

      if (abortSignal?.aborted) {
        throw new UpstreamRequestAbortedError(
          abortSignal.reason instanceof Error
            ? abortSignal.reason.message
            : "Codex WebSocket stream aborted"
        )
      }
    } finally {
      abortSignal?.removeEventListener("abort", onAbort)
      if (sessionId) {
        if (!responseCompleted) {
          this.wsService.invalidateSessionConnection(sessionId, ws)
        }
      } else {
        ws.close()
      }
    }

    // P0.3 prewarm：response.completed 之后服务端通常以 code=1005 关连接，下个
    // turn 必须重新握手（约 1s）。在 turn 结束的"间隙"异步起一条新 WS 挂回 session，
    // 下个 turn 进入 ensureSessionConnection 时直接命中 OPEN 连接、零握手。
    // 仅在 responseCompleted 且仍持有 sessionId / prewarm 配置时触发。
    if (responseCompleted && sessionId && prewarm) {
      void this.wsService.schedulePrewarmConnection(
        sessionId,
        prewarm.wsUrl,
        prewarm.wsHeaders,
        prewarm.proxyUrl,
        ws
      )
    }

    const totalMs = Date.now() - requestStartedAt
    // 结构化 turn timing：grep '[Codex][TurnTiming]' 即可拉出每个 turn 的耗时分布
    this.logger.log(
      `[Codex][TurnTiming] conv=${conversationId || "none"} ` +
        `transport=ws model=${modelName} ` +
        `firstFrameMs=${firstUpstreamMs ?? -1} ` +
        `firstContentMs=${firstContentMs ?? -1} ` +
        `firstContentType=${firstContentType || "none"} ` +
        `totalMs=${totalMs} ` +
        `completed=${responseCompleted} ` +
        `blocks=${state.blockIndex} hasToolCall=${state.hasToolCall} ` +
        `slot=${this.getAccountLabel(slot)}`
    )
  }

  // ── Rate Limit Header Parsing ───────────────────────────────────────

  /**
   * Parse x-codex-* rate limit headers from Codex API responses.
   * Headers follow the pattern:
   *   x-codex-primary-used-percent / x-codex-primary-window-minutes / x-codex-primary-reset-at
   *   x-codex-secondary-used-percent / x-codex-secondary-window-minutes / x-codex-secondary-reset-at
   */
  private captureCodexRateLimitHeaders(
    headers: Headers,
    slot: CodexAccountSlot,
    modelName: string,
    source: CodexRateLimitSource
  ): void {
    try {
      const primary = this.parseRateLimitWindow(headers, "primary")
      const secondary = this.parseRateLimitWindow(headers, "secondary")

      if (!primary && !secondary) {
        return
      }

      const normalizedModel = this.normalizeCodexModelName(modelName)
      const snapshot: CodexRateLimitSnapshot = {
        model: normalizedModel,
        displayModel: this.getCodexDisplayModel(normalizedModel),
        source,
        updatedAt: Date.now(),
      }
      if (primary) {
        snapshot.primary = primary
      }
      if (secondary) {
        snapshot.secondary = secondary
      }

      this.setRateLimitSnapshot(slot, snapshot)

      const label = this.getAccountLabel(slot)
      const parts: string[] = []
      if (primary) {
        parts.push(this.formatRateLimitWindow("primary", primary))
      }
      if (secondary) {
        parts.push(this.formatRateLimitWindow("secondary", secondary))
      }
      const sourceLabel = source === "request" ? "live" : "healthcheck"
      const message = `[Codex][RateLimit] ${label}: model=${normalizedModel}, source=${sourceLabel}, ${parts.join(", ")}`
      if (
        source === "request" ||
        (source === "probe" &&
          normalizedModel === DEFAULT_CODEX_RATE_LIMIT_MODEL)
      ) {
        this.logger.log(message)
      } else {
        this.logger.debug(message)
      }
    } catch {
      // Non-critical: silently ignore parse failures
    }
  }

  private formatRateLimitWindow(
    tier: "primary" | "secondary",
    window: CodexRateLimitWindow
  ): string {
    const left = Math.max(0, 100 - window.usedPercent).toFixed(0)
    const windowMinutes =
      typeof window.windowMinutes === "number" &&
      Number.isFinite(window.windowMinutes)
        ? `${window.windowMinutes}m`
        : "unknown"
    const resetAt =
      typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
        ? new Date(window.resetsAt * 1000).toISOString()
        : "unknown"

    return `${tier}=${left}% left (window=${windowMinutes}, resetAt=${resetAt})`
  }

  private parseRateLimitWindow(
    headers: Headers,
    tier: "primary" | "secondary"
  ): CodexRateLimitWindow | null {
    const usedPercentStr = headers.get(`x-codex-${tier}-used-percent`)
    if (!usedPercentStr) {
      return null
    }

    const usedPercent = parseFloat(usedPercentStr)
    if (!Number.isFinite(usedPercent)) {
      return null
    }

    const windowMinutesStr = headers.get(`x-codex-${tier}-window-minutes`)
    const windowMinutes = windowMinutesStr
      ? parseInt(windowMinutesStr, 10)
      : null

    const resetsAtStr = headers.get(`x-codex-${tier}-reset-at`)
    const resetsAt = resetsAtStr ? parseInt(resetsAtStr, 10) : null

    return {
      usedPercent,
      windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    }
  }

  // ── Availability ─────────────────────────────────────────────────────

  /**
   * Check if the Codex backend is reachable.
   */
  checkAvailability(): Promise<boolean> {
    return Promise.resolve(this.isAvailable())
  }

  // ── Rate Limit Probing ────────────────────────────────────────────────

  /**
   * Probe rate limits for accounts.
   * When force=false (default), only probes accounts without existing data.
   * When force=true, re-probes all non-disabled accounts to refresh data.
   *
   * Sends a lightweight completions request with max_output_tokens=1 and
   * immediately aborts the stream to capture x-codex-* rate limit headers.
   */
  async probeRateLimits(force = false): Promise<number> {
    if (this.rateLimitProbePromise) {
      return this.rateLimitProbePromise
    }

    this.rateLimitProbePromise = this.runRateLimitProbe(force)
    try {
      return await this.rateLimitProbePromise
    } finally {
      this.rateLimitProbePromise = null
    }
  }

  private async runRateLimitProbe(force = false): Promise<number> {
    const supportedModels = new Set(
      getCodexModelIdsForTier(this.getModelTier())
    )
    const probeModels = supportedModels.has(DEFAULT_CODEX_RATE_LIMIT_MODEL)
      ? [DEFAULT_CODEX_RATE_LIMIT_MODEL]
      : Array.from(supportedModels)
    const slotsToProbe = this.accounts.filter(
      (slot) =>
        (force || !this.hasRateLimitData(slot)) && !isAccountDisabled(slot)
    )

    if (slotsToProbe.length === 0) {
      return 0
    }

    this.logger.log(
      `[Codex] Probing rate limits for ${slotsToProbe.length} account(s) across ${probeModels.length} model(s)...`
    )

    let probed = 0

    // Probe sequentially to avoid parallel token refresh races
    for (const slot of slotsToProbe) {
      if (!force && this.activeLiveRequests > 0) {
        this.logger.log(
          "[Codex] Rate limit probe paused while live requests are active"
        )
        break
      }

      const label = this.getAccountLabel(slot)
      try {
        let token = await this.getBearerToken(slot)
        if (!token) {
          this.logger.warn(
            `[Codex] Probe skipped for ${label}: no bearer token`
          )
          continue
        }

        // Send the smallest valid streaming responses request we can. The
        // ChatGPT Codex backend rejects max_output_tokens on this endpoint, but
        // it still returns x-codex-* headers on the initial 200 response.
        // Abort immediately after headers are captured to avoid spending quota.
        const dispatcher = this.buildProxyDispatcher(slot)

        const doProbe = async (
          bearerToken: string,
          probeModel: string
        ): Promise<Response> => {
          const abortController = new AbortController()
          this.activeRateLimitProbeAbortController = abortController
          const timeout = setTimeout(() => abortController.abort(), 15_000)
          try {
            const url = this.buildUrl(slot, "responses")
            const headers = this.buildHeaders(slot, bearerToken, true)
            const fetchOptions: RequestInit & { dispatcher?: unknown } = {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: probeModel,
                instructions: "",
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "." }],
                  },
                ],
                stream: true,
                store: false,
                parallel_tool_calls: false,
                reasoning: { effort: "low", summary: "auto" },
              }),
              signal: abortController.signal,
            }
            if (dispatcher) {
              fetchOptions.dispatcher = dispatcher
            }
            const resp = await fetch(url, fetchOptions)
            // Capture rate limit headers BEFORE aborting the stream
            this.captureCodexRateLimitHeaders(
              resp.headers,
              slot,
              probeModel,
              "probe"
            )
            // Now abort the stream to avoid generating output
            abortController.abort()
            return resp
          } finally {
            clearTimeout(timeout)
            if (this.activeRateLimitProbeAbortController === abortController) {
              this.activeRateLimitProbeAbortController = null
            }
          }
        }

        for (const probeModel of probeModels) {
          const response = await doProbe(token, probeModel)

          // 401/403: 复用 tryRefreshSlotToken 统一 refresh 逻辑（含旋转竞态保护）
          if (response.status === 401 || response.status === 403) {
            const refreshedToken = await this.tryRefreshSlotToken(
              slot,
              `Probe ${label} HTTP ${response.status}`
            )
            if (refreshedToken) {
              token = refreshedToken
              await doProbe(token, probeModel)
            }
          }

          const summary = this.getRateLimitModelSummary(slot, probeModel)
          if (summary?.probe) {
            this.logger.log(
              `[Codex] Probe ${label}: rate limits captured for model=${probeModel}`
            )
          } else {
            this.logger.warn(
              `[Codex] Probe ${label}: no x-codex-* headers in response for model=${probeModel} (HTTP ${response.status})`
            )
          }
        }
        probed++
      } catch (err) {
        if (
          !force &&
          this.activeLiveRequests > 0 &&
          err instanceof Error &&
          err.name === "AbortError"
        ) {
          this.logger.log(
            "[Codex] Rate limit probe aborted to prioritize a live request"
          )
          break
        }
        this.logger.warn(
          `[Codex] Rate limit probe failed for ${label}: ${(err as Error).message}`
        )
      }
    }

    this.logger.log(`[Codex] Rate limit probe completed: ${probed} account(s)`)
    return probed
  }
}
