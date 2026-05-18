/**
 * Kiro OAuth/OIDC token refresh.
 *
 * Two refresh paths exist depending on how the source account was authorized:
 *
 *   - "idc" / "builderid": AWS OIDC token endpoint — needs clientId+clientSecret
 *   - "social"           : Kiro-hosted refreshToken endpoint (GitHub / Google)
 *
 * The function returns the refreshed credentials plus the (optional)
 * profileArn, mirroring the upstream Go implementation.
 */

import { HttpProxyAgent } from "http-proxy-agent"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"

export type KiroAuthMethod = "idc" | "social" | "api_key"

export interface KiroRefreshInput {
  authMethod: KiroAuthMethod
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  proxyUrl?: string
}

export interface KiroRefreshResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  profileArn?: string
}

interface OidcTokenResponse {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  profileArn?: string
}

const SOCIAL_REFRESH_URL =
  "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"

function buildProxyAgent(proxyUrl?: string): unknown {
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

async function fetchOidc(
  url: string,
  payload: Record<string, string>,
  proxyUrl?: string
): Promise<OidcTokenResponse> {
  const init: RequestInit & { dispatcher?: unknown } = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  }
  const dispatcher = buildProxyAgent(proxyUrl)
  if (dispatcher) {
    init.dispatcher = dispatcher
  }

  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Kiro token refresh failed: HTTP ${response.status} ${text.slice(0, 240)}`
    )
  }
  try {
    return JSON.parse(text) as OidcTokenResponse
  } catch (error) {
    throw new Error(
      `Kiro token refresh returned non-JSON body: ${(error as Error).message} | ${text.slice(0, 240)}`
    )
  }
}

export async function refreshKiroToken(
  input: KiroRefreshInput
): Promise<KiroRefreshResult> {
  const refreshToken = input.refreshToken?.trim()
  if (!refreshToken) {
    throw new Error("Kiro refresh token is empty")
  }

  if (input.authMethod === "social") {
    const result = await fetchOidc(
      SOCIAL_REFRESH_URL,
      { refreshToken },
      input.proxyUrl
    )
    return finalizeRefresh(result, refreshToken)
  }

  const clientId = input.clientId?.trim()
  const clientSecret = input.clientSecret?.trim()
  if (!clientId || !clientSecret) {
    throw new Error(
      "Kiro IdC/Builder ID refresh requires clientId and clientSecret"
    )
  }

  const region = input.region?.trim() || "us-east-1"
  const url = `https://oidc.${region}.amazonaws.com/token`
  const result = await fetchOidc(
    url,
    {
      clientId,
      clientSecret,
      refreshToken,
      grantType: "refresh_token",
    },
    input.proxyUrl
  )
  return finalizeRefresh(result, refreshToken)
}

function finalizeRefresh(
  result: OidcTokenResponse,
  fallbackRefreshToken: string
): KiroRefreshResult {
  const accessToken = (result.accessToken || "").trim()
  if (!accessToken) {
    throw new Error("Kiro token refresh response missing accessToken")
  }
  const expiresIn =
    typeof result.expiresIn === "number" && result.expiresIn > 0
      ? result.expiresIn
      : 3600
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn
  return {
    accessToken,
    refreshToken: (result.refreshToken || "").trim() || fallbackRefreshToken,
    expiresAt,
    profileArn: result.profileArn?.trim() || undefined,
  }
}
