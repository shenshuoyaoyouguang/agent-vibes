/**
 * Anthropic OAuth 2.0 + PKCE login flow used by Claude Code CLI.
 *
 * Aligned with the official Claude Code v2.1.142 binary
 * (`/opt/homebrew/bin/claude`). Endpoints are the prod values exported
 * from `getOauthConfig()` in the upstream binary: Claude.ai authorize
 * URL bounces through `claude.com/cai/*` for attribution, and the token
 * endpoint moved from `api.anthropic.com` to `platform.claude.com`.
 *
 * Surface:
 *   - `startAnthropicLogin(opts)` opens a local HTTP listener on an
 *     OS-allocated ephemeral port (matches CC's `server.listen(0)`),
 *     returns the auth URL the user must visit, the dynamic
 *     `redirectUri` that callers must pass back to
 *     `exchangeAuthorizationCode`, and a promise that resolves when the
 *     callback fires with `code` + `state`.
 *   - `exchangeAuthorizationCode({ code, verifier, redirectUri })` swaps
 *     `code` for `access_token` + `refresh_token`. The `redirectUri`
 *     MUST be byte-identical to the one used at authorize time.
 *   - `refreshAnthropicTokens({ refreshToken })` rotates an expiring
 *     access token. Throws on permanent failure (HTTP 401/403/400
 *     `invalid_grant`); call sites should disable the credential.
 */

import { createHash, randomBytes } from "crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http"

// Claude.ai sign-in path (for Pro / Max / Team / Enterprise subscribers).
// Matches `getOauthConfig().CLAUDE_AI_AUTHORIZE_URL` in v2.1.142.
const AUTH_URL = "https://claude.com/cai/oauth/authorize"
// Token endpoint moved to platform.claude.com in 2026.
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
// Order matters for fingerprinting: `ALL_OAUTH_SCOPES` in v2.1.142 is
// `[org:create_api_key, user:profile, user:inference,
//   user:sessions:claude_code, user:mcp_servers, user:file_upload]`.
// Real CC always asks for the union when logging in.
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

/**
 * Path the local listener accepts. Real CC also uses `/callback`. The
 * port is allocated by the OS at `listen(0)` time; see
 * `startAnthropicLogin`.
 */
const REDIRECT_PATH = "/callback"

const DEFAULT_LISTEN_TIMEOUT_MS = 10 * 60_000

export interface PkceCodes {
  codeVerifier: string
  codeChallenge: string
}

export interface AnthropicOAuthLoginSession {
  /** URL the user must visit in a browser. */
  authUrl: string
  /**
   * Redirect URI the local listener registered with the OAuth server,
   * including the OS-allocated ephemeral port. Callers MUST pass this
   * verbatim into `exchangeAuthorizationCode` — the OAuth token
   * endpoint rejects mismatches.
   */
  redirectUri: string
  /** State parameter the callback must echo back (CSRF protection). */
  state: string
  /** PKCE codes; pass `codeVerifier` to `exchangeAuthorizationCode`. */
  pkce: PkceCodes
  /** Promise resolved once the user completes the redirect. */
  awaitCallback: () => Promise<{ code: string; state: string }>
  /**
   * Non-blocking peek at the current session state. Returns `pending`
   * until the user completes the redirect; once the listener captures
   * the callback this resolves to `completed`. After a permanent error
   * (cancel, listener crash, state mismatch, timeout) returns `failed`.
   *
   * Designed for the dashboard webview which polls a bridge endpoint
   * rather than awaiting a long-lived promise.
   */
  peek: () =>
    | { status: "pending" }
    | { status: "completed"; code: string; state: string }
    | { status: "failed"; message: string }
  /** Cancel the local listener early without resolving the promise. */
  cancel: () => void
  /** Wall-clock millisecond when the listener will time out. */
  expiresAt: number
}

export interface AnthropicTokenBundle {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
  tokenType?: string
  account?: { uuid?: string; email?: string }
  organization?: { uuid?: string; name?: string }
}

export interface AnthropicLoginOptions {
  /** Override the listen timeout. Defaults to 10 minutes. */
  listenTimeoutMs?: number
}

export interface AnthropicCallbackParams {
  code: string
  state: string
}

export interface ExchangeCodeOptions {
  code: string
  state: string
  expectedState: string
  verifier: string
  /**
   * The redirect URI used when the user authorized the request. MUST
   * match the value bound to the local listener at authorize time
   * (see `AnthropicOAuthLoginSession.redirectUri`) — the OAuth token
   * endpoint rejects mismatches with HTTP 400.
   */
  redirectUri: string
}

export interface RefreshOptions {
  refreshToken: string
}

export class AnthropicOAuthError extends Error {
  readonly status?: number
  readonly retryable: boolean

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean } = {}
  ) {
    super(message)
    this.name = "AnthropicOAuthError"
    this.status = options.status
    this.retryable = options.retryable ?? false
  }
}

/**
 * Generate a fresh `(code_verifier, code_challenge)` pair. The verifier is
 * 64 random bytes, base64url-encoded, then SHA-256 hashed and re-encoded
 * for the challenge. Matches CLIProxyAPI's `GeneratePKCECodes`.
 */
export function generatePkceCodes(): PkceCodes {
  const codeVerifier = base64UrlEncode(randomBytes(32))
  const challenge = createHash("sha256").update(codeVerifier).digest()
  const codeChallenge = base64UrlEncode(challenge)
  return { codeVerifier, codeChallenge }
}

export function generateOAuthState(): string {
  return base64UrlEncode(randomBytes(16))
}

export function buildAuthorizationUrl(
  state: string,
  pkce: PkceCodes,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

/**
 * Spin up a one-shot local HTTP server on an OS-allocated ephemeral
 * port (matching real CC's `server.listen(0)`), generate PKCE codes,
 * and return a session handle the caller can use to direct the user to
 * Anthropic's authorize endpoint and await the callback.
 *
 * Allocating the port via `listen(0)` rather than pinning means
 * concurrent IDE instances no longer collide on a fixed port —
 * previously every second login attempt failed with `EADDRINUSE`.
 *
 * The server self-terminates once the callback fires or the timeout
 * elapses. Callers must invoke `awaitCallback()` exactly once and pass
 * the returned `redirectUri` into `exchangeAuthorizationCode`.
 */
export function startAnthropicLogin(
  options: AnthropicLoginOptions = {}
): AnthropicOAuthLoginSession {
  const pkce = generatePkceCodes()
  const state = generateOAuthState()

  const timeoutMs = options.listenTimeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS
  const expiresAt = Date.now() + timeoutMs

  let server: Server | null = null
  let resolved = false
  let resolveCb: ((value: AnthropicCallbackParams) => void) | null = null
  let rejectCb: ((reason: AnthropicOAuthError) => void) | null = null
  let snapshot:
    | { status: "pending" }
    | { status: "completed"; code: string; state: string }
    | { status: "failed"; message: string } = { status: "pending" }

  const callbackPromise = new Promise<AnthropicCallbackParams>(
    (resolve, reject) => {
      resolveCb = resolve
      rejectCb = reject
    }
  )

  const finish = () => {
    if (server && server.listening) {
      server.close()
    }
  }

  const fail = (err: AnthropicOAuthError) => {
    if (resolved) return
    resolved = true
    snapshot = { status: "failed", message: err.message }
    rejectCb?.(err)
    finish()
  }

  const settle = (value: AnthropicCallbackParams) => {
    if (resolved) return
    resolved = true
    snapshot = {
      status: "completed",
      code: value.code,
      state: value.state,
    }
    resolveCb?.(value)
    finish()
  }

  server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400
      res.end("missing url")
      return
    }

    const parsed = parseCallbackUrl(req)
    if (!parsed) {
      res.statusCode = 404
      res.end("not found")
      return
    }

    if (parsed.error) {
      respondHtml(
        res,
        renderHtml(
          "Authentication failed",
          `Anthropic returned an error: ${escapeHtml(parsed.error)}`
        )
      )
      fail(
        new AnthropicOAuthError(`Anthropic OAuth error: ${parsed.error}`, {
          status: 400,
        })
      )
      return
    }

    if (!parsed.code || !parsed.state) {
      res.statusCode = 400
      res.end("missing code/state")
      return
    }

    if (parsed.state !== state) {
      respondHtml(
        res,
        renderHtml(
          "Authentication failed",
          "State mismatch — please retry the login flow."
        )
      )
      fail(new AnthropicOAuthError("OAuth state mismatch", { status: 400 }))
      return
    }

    respondHtml(
      res,
      renderHtml(
        "Authentication successful",
        "You can close this window. Agent Vibes received your credentials."
      )
    )
    settle({ code: parsed.code, state: parsed.state })
  })

  const timer = setTimeout(() => {
    fail(
      new AnthropicOAuthError("Anthropic OAuth callback timed out", {
        retryable: true,
      })
    )
  }, timeoutMs)

  // Stop the timer once the callback resolves or rejects.
  void callbackPromise.finally(() => {
    clearTimeout(timer)
  })

  server.on("error", (err: NodeJS.ErrnoException) => {
    fail(
      new AnthropicOAuthError(
        `Anthropic OAuth listener failed: ${err.message}`,
        { retryable: false }
      )
    )
  })

  // Bind synchronously to port 0 — Node's `listen(0)` returns the bound
  // port through `server.address()` once the OS has assigned one. We
  // build the redirect URI and authorize URL *after* listening so they
  // include the real port. This call is non-blocking; the listener is
  // ready before the user can plausibly visit `authUrl`.
  server.listen(0, "127.0.0.1")
  const address = server.address()
  const port = address && typeof address === "object" ? address.port : 0
  if (!port) {
    fail(
      new AnthropicOAuthError(
        "Anthropic OAuth listener could not bind to an ephemeral port",
        { retryable: true }
      )
    )
  }
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`
  const authUrl = buildAuthorizationUrl(state, pkce, redirectUri)

  return {
    authUrl,
    redirectUri,
    state,
    pkce,
    expiresAt,
    awaitCallback: () => callbackPromise,
    peek: () => snapshot,
    cancel: () => {
      fail(
        new AnthropicOAuthError("Anthropic OAuth cancelled by caller", {
          retryable: false,
        })
      )
    },
  }
}

/**
 * Exchange the authorization code received from the callback for an
 * access + refresh token pair.
 */
export async function exchangeAuthorizationCode(
  opts: ExchangeCodeOptions
): Promise<AnthropicTokenBundle> {
  if (opts.state !== opts.expectedState) {
    throw new AnthropicOAuthError("OAuth state mismatch", { status: 400 })
  }

  // v2.1.142 sends the body as JSON, not form-urlencoded. See
  // `exchangeCodeForTokens` in src/services/oauth/client.ts.
  return await postTokenJson({
    grant_type: "authorization_code",
    code: opts.code,
    state: opts.state,
    client_id: CLIENT_ID,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
  })
}

/**
 * Rotate an existing refresh token for a fresh access + refresh pair.
 */
export async function refreshAnthropicTokens(
  opts: RefreshOptions
): Promise<AnthropicTokenBundle> {
  // Real CC includes the granted scopes on every refresh so the backend's
  // `ALLOWED_SCOPE_EXPANSIONS` path can broaden the issued token. Mirror
  // that behaviour to avoid drifting into the third-party bucket.
  return await postTokenJson({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES,
  })
}

interface AnthropicTokenJson {
  access_token?: unknown
  refresh_token?: unknown
  token_type?: unknown
  expires_in?: unknown
  scope?: unknown
  account?: unknown
  organization?: unknown
}

async function postTokenJson(
  body: Record<string, string>
): Promise<AnthropicTokenBundle> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new AnthropicOAuthError(
      `Anthropic token endpoint network error: ${describeError(err)}`,
      { retryable: true }
    )
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const retryable = response.status >= 500 || response.status === 429
    throw new AnthropicOAuthError(
      `Anthropic token endpoint returned ${response.status}: ${text.slice(
        0,
        500
      )}`,
      { status: response.status, retryable }
    )
  }

  const json = (await response.json()) as AnthropicTokenJson

  const accessToken =
    typeof json.access_token === "string" ? json.access_token : ""
  const refreshToken =
    typeof json.refresh_token === "string" ? json.refresh_token : ""
  if (!accessToken || !refreshToken) {
    throw new AnthropicOAuthError(
      "Anthropic token endpoint returned an incomplete response",
      { status: response.status }
    )
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 0
  const expiresAt = Date.now() + Math.max(60, expiresIn) * 1000
  const tokenType = typeof json.token_type === "string" ? json.token_type : ""
  const scope = typeof json.scope === "string" ? json.scope : ""
  const account = extractInfo(json.account)
  const organization = extractInfo(json.organization)

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope: scope || undefined,
    tokenType: tokenType || undefined,
    account,
    organization,
  }
}

function extractInfo(
  value: unknown
): { uuid?: string; email?: string; name?: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const obj = value as Record<string, unknown>
  const out: { uuid?: string; email?: string; name?: string } = {}
  if (typeof obj.uuid === "string") out.uuid = obj.uuid
  if (typeof obj.email === "string") out.email = obj.email
  if (typeof obj.name === "string") out.name = obj.name
  return Object.keys(out).length > 0 ? out : undefined
}

function parseCallbackUrl(req: IncomingMessage): {
  code?: string
  state?: string
  error?: string
} | null {
  if (!req.url) return null
  const localHost = listeningHost(req) || "127.0.0.1"
  const parsed = new URL(req.url, `http://${localHost}`)
  if (parsed.pathname !== REDIRECT_PATH) return null
  return {
    code: parsed.searchParams.get("code") || undefined,
    state: parsed.searchParams.get("state") || undefined,
    error:
      parsed.searchParams.get("error") ||
      parsed.searchParams.get("error_description") ||
      undefined,
  }
}

function listeningHost(req: IncomingMessage): string | null {
  const sock = req.socket
  const local = (sock as { localAddress?: unknown }).localAddress
  return typeof local === "string" ? local : null
}

function respondHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200
  res.setHeader("content-type", "text/html; charset=utf-8")
  res.end(html)
}

function renderHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.5;">
<h1>${escapeHtml(title)}</h1>
<p>${body}</p>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}
