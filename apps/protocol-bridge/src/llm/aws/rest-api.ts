/**
 * Lightweight wrappers around the Kiro REST API used at boot or refresh time.
 * Currently only `resolveProfileArn` is required by the streaming path.
 */

import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import {
  buildKiroBaseHeaders,
  buildRuntimeHeaderValues,
  type KiroClientConfig,
} from "./headers"
import { KIRO_REST_API_BASE } from "./protocol-types"

export interface KiroRestRequestContext {
  accessToken: string
  machineId?: string
  proxyUrl?: string
  client?: Partial<KiroClientConfig>
  /** When set to "API_KEY", adds a `tokentype: API_KEY` header to requests. */
  tokenType?: "API_KEY"
}

interface ListProfilesResponse {
  profiles?: Array<{ arn?: string }>
}

function buildProxyDispatcher(proxyUrl?: string): unknown {
  if (!proxyUrl) return undefined
  const trimmed = proxyUrl.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (
      url.protocol === "socks:" ||
      url.protocol === "socks5:" ||
      url.protocol === "socks4:"
    ) {
      return new SocksProxyAgent(trimmed)
    }
    if (url.protocol === "http:") {
      return new HttpProxyAgent(trimmed)
    }
    if (url.protocol === "https:") {
      return new HttpsProxyAgent(trimmed)
    }
  } catch {
    // ignore malformed proxy URL
  }
  return undefined
}

async function callKiroRest(
  url: string,
  init: RequestInit,
  ctx: KiroRestRequestContext
): Promise<Response> {
  const headerValues = buildRuntimeHeaderValues({
    machineId: ctx.machineId,
    host: new URL(url).host,
    client: ctx.client,
  })
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
    Accept: "application/json",
    ...buildKiroBaseHeaders({
      accessToken: ctx.accessToken,
      values: headerValues,
    }),
  }
  if (ctx.tokenType) {
    headers["tokentype"] = ctx.tokenType
  }

  const fetchOptions: RequestInit & { dispatcher?: unknown } = {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  }
  const dispatcher = buildProxyDispatcher(ctx.proxyUrl)
  if (dispatcher) fetchOptions.dispatcher = dispatcher

  return fetch(url, fetchOptions)
}

/**
 * Resolve the account profile ARN by calling
 * `POST /ListAvailableProfiles` and returning the first non-empty arn.
 *
 * Returns null when the upstream returns no profiles; the caller may then
 * fall back to refreshing the OIDC token (which also returns profileArn).
 */
export async function listAvailableProfileArn(
  ctx: KiroRestRequestContext
): Promise<string | null> {
  const url = `${KIRO_REST_API_BASE}/ListAvailableProfiles`
  const response = await callKiroRest(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxResults: 10 }),
    },
    ctx
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(
      `ListAvailableProfiles failed: HTTP ${response.status} ${text.slice(0, 240)}`
    )
  }
  const body = (await response.json()) as ListProfilesResponse
  const profile = body.profiles?.find(
    (entry) => typeof entry.arn === "string" && entry.arn.trim() !== ""
  )
  return profile?.arn?.trim() || null
}

// ── Usage / Subscription info ─────────────────────────────────────────

export interface KiroUsageLimitsResponse {
  usageBreakdownList?: Array<{
    resourceType?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    currentOverages?: number
    currentOveragesWithPrecision?: number
    overageCharges?: number
    overageCap?: number
    overageCapWithPrecision?: number
    freeTrialInfo?: {
      currentUsage?: number
      usageLimit?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string | number
    }
  }>
  nextDateReset?: string | number
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

/**
 * Fetch the account's usage limits and subscription info from the Kiro API.
 * Equivalent to Kiro-Go's `GetUsageLimits`.
 */
export async function getKiroUsageLimits(
  ctx: KiroRestRequestContext & { profileArn?: string }
): Promise<KiroUsageLimitsResponse> {
  let url = `${KIRO_REST_API_BASE}/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true`
  if (ctx.profileArn) {
    url += `&profileArn=${encodeURIComponent(ctx.profileArn)}`
  }
  const response = await callKiroRest(url, { method: "GET" }, ctx)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(
      `getUsageLimits failed: HTTP ${response.status} ${text.slice(0, 240)}`
    )
  }
  return (await response.json()) as KiroUsageLimitsResponse
}

// ── Model discovery ───────────────────────────────────────────────────

export interface KiroModelInfo {
  modelId: string
  modelName: string
  description?: string
  rateMultiplier?: number
  rateUnit?: string
  supportedInputTypes?: string[]
  tokenLimits?: {
    maxInputTokens?: number
    maxOutputTokens?: number
  }
  promptCaching?: {
    supportsPromptCaching?: boolean
    minimumTokensPerCacheCheckpoint?: number
    maximumCacheCheckpointsPerRequest?: number
  }
}

interface ListModelsResponse {
  models?: KiroModelInfo[]
  defaultModel?: KiroModelInfo
}

/**
 * Fetch the list of available models from the Kiro API.
 * Equivalent to Kiro-Go's `ListAvailableModels`.
 */
export async function listKiroAvailableModels(
  ctx: KiroRestRequestContext & { profileArn?: string }
): Promise<KiroModelInfo[]> {
  let url = `${KIRO_REST_API_BASE}/ListAvailableModels?origin=AI_EDITOR&maxResults=50`
  if (ctx.profileArn) {
    url += `&profileArn=${encodeURIComponent(ctx.profileArn)}`
  }
  const response = await callKiroRest(url, { method: "GET" }, ctx)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(
      `ListAvailableModels failed: HTTP ${response.status} ${text.slice(0, 240)}`
    )
  }
  const body = (await response.json()) as ListModelsResponse
  return Array.isArray(body.models) ? body.models : []
}
