/**
 * AWS Builder ID OAuth 2.0 device authorization flow for Kiro.
 *
 * Mirrors `auth/builderid.go` from the upstream Kiro-Go reference, but stays
 * server-side: the Agent Vibes bridge initiates the flow, returns the
 * verification URL (with the user_code embedded) to the dashboard, and polls
 * the OIDC `/token` endpoint until the user completes the browser approval.
 *
 * Reference: https://docs.aws.amazon.com/sdkref/latest/guide/feature-sso-credentials.html#feature-sso-credentials-section-oidc-device-grant
 */

import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"

const KIRO_BUILDER_ID_START_URL = "https://view.awsapps.com/start"
const KIRO_BUILDER_ID_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
]

const REGISTER_CLIENT_NAME = "Kiro"
const DEVICE_CODE_DEFAULT_INTERVAL_SECONDS = 5
const DEVICE_CODE_DEFAULT_EXPIRES_IN_SECONDS = 600

export interface KiroDeviceAuthSession {
  sessionId: string
  region: string
  clientId: string
  clientSecret: string
  registrationExpiresAt?: number
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  intervalMs: number
  expiresAt: number
}

export interface KiroDevicePollSuccess {
  status: "completed"
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId: string
  clientSecret: string
  registrationExpiresAt?: number
  region: string
}

export type KiroDevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | KiroDevicePollSuccess

function buildProxyDispatcher(proxyUrl?: string): unknown {
  if (!proxyUrl) return undefined
  const trimmed = proxyUrl.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (
      url.protocol === "socks:" ||
      url.protocol === "socks4:" ||
      url.protocol === "socks5:"
    ) {
      return new SocksProxyAgent(trimmed)
    }
    if (url.protocol === "http:") return new HttpProxyAgent(trimmed)
    if (url.protocol === "https:") return new HttpsProxyAgent(trimmed)
  } catch {
    // ignore malformed proxy URL
  }
  return undefined
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  proxyUrl?: string
): Promise<{ status: number; data: T | null; raw: string }> {
  const init: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }
  const dispatcher = buildProxyDispatcher(proxyUrl)
  if (dispatcher) init.dispatcher = dispatcher

  const response = await fetch(url, init)
  const raw = await response.text()
  let data: T | null = null
  try {
    data = raw ? (JSON.parse(raw) as T) : null
  } catch {
    data = null
  }
  return { status: response.status, data, raw }
}

/**
 * Kick off a Builder ID device auth flow.  Returns enough state for the
 * dashboard to open the browser and for the bridge to poll later.
 */
export async function startKiroBuilderIdDeviceFlow(options?: {
  region?: string
  proxyUrl?: string
  sessionId?: string
}): Promise<KiroDeviceAuthSession> {
  const region = (options?.region || "us-east-1").trim() || "us-east-1"
  const oidcBase = `https://oidc.${region}.amazonaws.com`

  // 1) Register a public OIDC client.
  const register = await postJson<{
    clientId?: string
    clientSecret?: string
    clientSecretExpiresAt?: number
  }>(
    `${oidcBase}/client/register`,
    {
      clientName: REGISTER_CLIENT_NAME,
      clientType: "public",
      scopes: KIRO_BUILDER_ID_SCOPES,
      grantTypes: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      issuerUrl: KIRO_BUILDER_ID_START_URL,
    },
    options?.proxyUrl
  )
  if (
    register.status !== 200 ||
    !register.data?.clientId ||
    !register.data.clientSecret
  ) {
    throw new Error(
      `Builder ID client registration failed (${register.status}): ${register.raw.slice(0, 240)}`
    )
  }

  // 2) Start device authorization.
  const auth = await postJson<{
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    verificationUriComplete?: string
    interval?: number
    expiresIn?: number
  }>(
    `${oidcBase}/device_authorization`,
    {
      clientId: register.data.clientId,
      clientSecret: register.data.clientSecret,
      startUrl: KIRO_BUILDER_ID_START_URL,
    },
    options?.proxyUrl
  )
  if (auth.status !== 200 || !auth.data?.deviceCode || !auth.data?.userCode) {
    throw new Error(
      `Builder ID device authorization failed (${auth.status}): ${auth.raw.slice(0, 240)}`
    )
  }

  const interval =
    typeof auth.data.interval === "number" && auth.data.interval > 0
      ? auth.data.interval
      : DEVICE_CODE_DEFAULT_INTERVAL_SECONDS
  const expiresIn =
    typeof auth.data.expiresIn === "number" && auth.data.expiresIn > 0
      ? auth.data.expiresIn
      : DEVICE_CODE_DEFAULT_EXPIRES_IN_SECONDS

  const verificationUri =
    auth.data.verificationUri || `${KIRO_BUILDER_ID_START_URL}/#/device`
  const verificationUriComplete =
    auth.data.verificationUriComplete ||
    `${verificationUri}?user_code=${encodeURIComponent(auth.data.userCode)}`

  return {
    sessionId: options?.sessionId || cryptoRandomId(),
    region,
    clientId: register.data.clientId,
    clientSecret: register.data.clientSecret,
    registrationExpiresAt:
      typeof register.data.clientSecretExpiresAt === "number" &&
      register.data.clientSecretExpiresAt > 0
        ? register.data.clientSecretExpiresAt
        : undefined,
    deviceCode: auth.data.deviceCode,
    userCode: auth.data.userCode,
    verificationUri,
    verificationUriComplete,
    intervalMs: interval * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * Poll the OIDC `/token` endpoint once.  Caller is responsible for honoring
 * `intervalMs` between attempts; on `slow_down` the caller should grow the
 * interval before the next call.
 */
export async function pollKiroBuilderIdDeviceFlow(
  session: KiroDeviceAuthSession,
  proxyUrl?: string
): Promise<KiroDevicePollResult> {
  if (Date.now() >= session.expiresAt) {
    throw new Error("Builder ID device code expired before user approval")
  }

  const oidcBase = `https://oidc.${session.region}.amazonaws.com`
  const tokenResponse = await postJson<{
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    error?: string
  }>(
    `${oidcBase}/token`,
    {
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
      deviceCode: session.deviceCode,
    },
    proxyUrl
  )

  if (tokenResponse.status === 200) {
    const access = tokenResponse.data?.accessToken
    const refresh = tokenResponse.data?.refreshToken
    if (!access || !refresh) {
      throw new Error(
        `Builder ID token response missing tokens: ${tokenResponse.raw.slice(0, 240)}`
      )
    }
    const expiresIn =
      typeof tokenResponse.data?.expiresIn === "number" &&
      tokenResponse.data.expiresIn > 0
        ? tokenResponse.data.expiresIn
        : 3600
    return {
      status: "completed",
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      registrationExpiresAt: session.registrationExpiresAt,
      region: session.region,
    }
  }

  if (tokenResponse.status === 400) {
    const code = (tokenResponse.data?.error || "").toLowerCase()
    if (code === "authorization_pending") return { status: "pending" }
    if (code === "slow_down") return { status: "slow_down" }
    if (code === "expired_token") {
      throw new Error("Builder ID device code expired")
    }
    if (code === "access_denied") {
      throw new Error("Builder ID authorization denied by user")
    }
    throw new Error(
      `Builder ID token error: ${code || tokenResponse.raw.slice(0, 240)}`
    )
  }

  throw new Error(
    `Builder ID token request unexpected HTTP ${tokenResponse.status}: ${tokenResponse.raw.slice(0, 240)}`
  )
}

function cryptoRandomId(): string {
  // Avoid pulling node:crypto at module top-level for tooling that
  // tree-shakes; require lazily.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto") as typeof import("crypto")
  return crypto.randomBytes(16).toString("hex")
}
