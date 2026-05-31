import { Body, Controller, Get, Logger, Post } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { createHash, randomUUID } from "crypto"
import { AnthropicApiService } from "../../../llm/anthropic/anthropic-api.service"
import {
  connectClaudeCli,
  disconnectClaudeCli,
  getClaudeCliIntegrationStatus,
} from "../../../llm/anthropic/cc-cli-integration"
import { KiroService } from "../../../llm/aws/kiro.service"
import { AntigravityIdeSyncService } from "../antigravity-ide-sync.service"
import { CursorAuthService } from "../cursor-auth.service"

interface CursorGainRequest {
  token?: string
  [key: string]: unknown
}

interface CursorIdentity {
  id: string
  email: string
  membershipType: string
  subscriptionStatus: string
}

@Controller("api")
export class AuthController {
  private readonly logger = new Logger(AuthController.name)
  private readonly tokenSalt = randomUUID()

  constructor(
    private readonly configService: ConfigService,
    private readonly cursorAuthService: CursorAuthService,
    private readonly antigravityIdeSyncService: AntigravityIdeSyncService,
    private readonly kiroService: KiroService,
    private readonly anthropicApiService: AnthropicApiService
  ) {}

  private getCursorIdentity(): CursorIdentity {
    const configuredId =
      this.configService.get<string>("CURSOR_AUTH_USER_ID") || ""
    const configuredEmail =
      this.configService.get<string>("CURSOR_AUTH_EMAIL") || ""
    const configuredMembership =
      this.configService.get<string>("CURSOR_AUTH_MEMBERSHIP") || ""

    const localAuth = this.cursorAuthService.getAuthTokens()
    const localUserId =
      localAuth.accessToken &&
      this.cursorAuthService.getUserIdFromToken(localAuth.accessToken)

    return {
      id: configuredId || localUserId || "protocol-bridge",
      email: configuredEmail || localAuth.email || "protocol-bridge@local",
      membershipType:
        configuredMembership || localAuth.membershipType || "ultra",
      subscriptionStatus: localAuth.subscriptionStatus || "active",
    }
  }

  private issueProxyToken(scope: "gain" | "gain-new", inputToken?: string) {
    const seed = `${scope}:${inputToken || ""}:${this.tokenSalt}`
    const digest = createHash("sha256").update(seed).digest("hex")
    return `proxy_${scope}_${digest.slice(0, 40)}`
  }

  @Get("users/whoami")
  whoami() {
    const identity = this.getCursorIdentity()
    return {
      id: identity.id,
      email: identity.email,
      plan: identity.membershipType,
      emailVerified: true,
      membershipType: identity.membershipType,
      subscription: {
        status: identity.subscriptionStatus,
        plan: identity.membershipType,
      },
      usage: {
        requests: 0,
        maxRequests: 999999,
      },
    }
  }

  @Post("cursor/gain")
  gain(@Body() body: CursorGainRequest) {
    const hasInputToken =
      typeof body.token === "string" && body.token.length > 0
    this.logger.log(`Cursor gain request received (hasToken=${hasInputToken})`)
    return {
      token: this.issueProxyToken(
        "gain",
        hasInputToken ? body.token : undefined
      ),
      valid: true,
      globalRateLimit: 999999,
      issuedAt: new Date().toISOString(),
    }
  }

  @Post("cursor/gain-new")
  gainNew(@Body() body: CursorGainRequest) {
    const hasInputToken =
      typeof body.token === "string" && body.token.length > 0
    this.logger.log(
      `Cursor gain-new request received (hasToken=${hasInputToken})`
    )
    return {
      token: this.issueProxyToken(
        "gain-new",
        hasInputToken ? body.token : undefined
      ),
      valid: true,
      issuedAt: new Date().toISOString(),
    }
  }

  // Cursor clients also check this endpoint in startup flow.
  @Get("auth/me")
  me() {
    return this.whoami()
  }

  @Post("antigravity/sync-ide")
  syncAntigravityIdeCredentials() {
    return {
      synced: true,
      ...this.antigravityIdeSyncService.syncCredentialsFromIde(),
    }
  }

  // ── Kiro: one-click sync from local AWS SSO / Kiro IDE caches ──────────

  @Post("kiro/sync-local")
  async syncKiroFromLocalCaches() {
    try {
      const result = await this.kiroService.syncFromLocalCaches()
      this.logger.log(
        `Kiro local sync: imported=${result.imported}, skipped=${result.skipped}, total=${result.accountCount}`
      )
      return result
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Kiro local sync failed"
      this.logger.error(`Kiro local sync error: ${message}`)
      return {
        synced: false,
        imported: 0,
        skipped: 0,
        accountCount: 0,
        path: "",
        sources: [],
        error: message,
      }
    }
  }

  // ── Kiro: AWS Builder ID OAuth device flow ─────────────────────────────

  @Post("kiro/login/start")
  async startKiroBuilderIdLogin(
    @Body() body: { region?: string; proxyUrl?: string } = {}
  ) {
    const session = await this.kiroService.startBuilderIdLogin({
      region: body.region,
      proxyUrl: body.proxyUrl,
    })
    return session
  }

  @Post("kiro/login/poll")
  async pollKiroBuilderIdLogin(
    @Body() body: { sessionId?: string; proxyUrl?: string } = {}
  ) {
    const sessionId = (body.sessionId || "").trim()
    if (!sessionId) {
      return { status: "expired" as const, message: "missing sessionId" }
    }
    return this.kiroService.pollBuilderIdLogin(sessionId, {
      proxyUrl: body.proxyUrl,
    })
  }

  @Post("kiro/login/cancel")
  cancelKiroBuilderIdLogin(@Body() body: { sessionId?: string } = {}) {
    const sessionId = (body.sessionId || "").trim()
    return {
      cancelled: sessionId
        ? this.kiroService.cancelBuilderIdLogin(sessionId)
        : false,
    }
  }

  // ── Kiro: force an existing pool account into local Kiro IDE ────────

  @Post("kiro/force-ide-login")
  async forceKiroIdeLogin(
    @Body()
    body: {
      authMethod?: string
      region?: string
      refreshToken?: string
      accessToken?: string
      clientId?: string
      kiroApiKey?: string
      label?: string
    } = {}
  ) {
    return this.kiroService.forceLoginToKiroIde(body)
  }

  @Post("kiro/force-cli-login")
  async forceKiroCliLogin(
    @Body()
    body: {
      authMethod?: string
      region?: string
      refreshToken?: string
      accessToken?: string
      clientId?: string
      kiroApiKey?: string
      label?: string
    } = {}
  ) {
    return this.kiroService.forceLoginToKiroCli(body)
  }

  // ── Kiro: manual JSON paste fallback ───────────────────────────────────

  @Post("kiro/import")
  importKiroFromJson(@Body() body: { raw?: string } = {}) {
    const raw = (body.raw || "").trim()
    if (!raw) {
      return {
        imported: 0,
        skipped: 0,
        accountCount: 0,
        path: "",
        error: "empty payload",
      }
    }
    try {
      return this.kiroService.importFromRawJson(raw)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Kiro import failed"
      return {
        imported: 0,
        skipped: 0,
        accountCount: 0,
        path: "",
        error: message,
      }
    }
  }

  // ── Claude Code CLI: Anthropic OAuth + PKCE redirect flow ──────────────

  @Post("claude/login/start")
  startClaudeOAuthLogin() {
    return this.anthropicApiService.startOAuthLogin()
  }

  @Post("claude/login/poll")
  pollClaudeOAuthLogin(@Body() body: { sessionId?: string } = {}) {
    const sessionId = (body.sessionId || "").trim()
    if (!sessionId) {
      return Promise.resolve({
        status: "expired" as const,
        message: "missing sessionId",
      })
    }
    return this.anthropicApiService.pollOAuthLogin(sessionId)
  }

  @Post("claude/login/cancel")
  cancelClaudeOAuthLogin(@Body() body: { sessionId?: string } = {}) {
    const sessionId = (body.sessionId || "").trim()
    return {
      cancelled: sessionId
        ? this.anthropicApiService.cancelOAuthLogin(sessionId)
        : false,
    }
  }

  // ── Claude Code CLI: bridge integration (settings.json wiring) ─────────

  @Get("claude/integration/status")
  getClaudeCliIntegrationStatus() {
    const bridgeApiKey = this.configService.get<string>("PROXY_API_KEY")
    return getClaudeCliIntegrationStatus(bridgeApiKey)
  }

  /**
   * Reveal the bridge's runtime PROXY_API_KEY.
   *
   * Loopback-only by design: the API tab's diagnostics panel can call
   * this to compare the bridge's expected key against what's stored in
   * `~/.claude/settings.json` and copy the correct value to the
   * clipboard. The reply never includes the key when no PROXY_API_KEY
   * is configured (loopback no-auth mode), so the panel can render
   * "no guard" instead of leaking a placeholder.
   */
  @Post("claude/integration/reveal-key")
  revealBridgeApiKey() {
    const raw = this.configService.get<string>("PROXY_API_KEY")
    const trimmed = typeof raw === "string" ? raw.trim() : ""
    if (!trimmed) {
      return { configured: false as const }
    }
    return { configured: true as const, apiKey: trimmed }
  }

  /**
   * Generic in-process probe for the API tab's "Test" button.
   *
   * Why a server-side probe instead of having the extension fire its
   * own HTTPS request: keeps the test honest about what the bridge
   * currently accepts (same TLS context, same auth guard) and lets us
   * surface end-to-end timing without round-tripping through the
   * webview's strict CSP. Inputs are constrained to bridge-relative
   * paths and a small allow-list of methods.
   */
  @Post("claude/integration/probe")
  async probeBridgeEndpoint(
    @Body()
    body: {
      path?: string
      method?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    } = {}
  ) {
    const rawPath = (body.path || "").trim()
    if (!rawPath || !rawPath.startsWith("/")) {
      return {
        ok: false as const,
        error: "path must be an absolute bridge-relative URL (start with /)",
      }
    }

    const method = (body.method || "GET").toUpperCase()
    const allowedMethods = new Set(["GET", "POST", "HEAD", "OPTIONS"])
    if (!allowedMethods.has(method)) {
      return {
        ok: false as const,
        error: `unsupported method: ${method}`,
      }
    }

    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || 8_000, 1_000),
      30_000
    )

    const httpsModule = await import("https")
    const httpModule = await import("http")
    const port = Number(this.configService.get<string>("PORT") || 2026)

    // The bridge listens on HTTPS when certs are present (the SEA build
    // mounts both); fall through to HTTP only if HTTPS handshake fails.
    return new Promise<{
      ok: boolean
      status?: number
      durationMs?: number
      bodyPreview?: string
      contentType?: string
      error?: string
    }>((resolve) => {
      const start = Date.now()
      const headers: Record<string, string> = {
        host: `localhost:${port}`,
        accept: "application/json,text/plain;q=0.8,*/*;q=0.5",
        "user-agent": "agent-vibes-bridge-probe/1",
        ...(body.headers || {}),
      }

      const payload =
        method === "POST" && typeof body.body === "string" ? body.body : ""
      if (payload.length > 0 && !headers["content-type"]) {
        headers["content-type"] = "application/json"
      }
      if (payload.length > 0) {
        headers["content-length"] = String(Buffer.byteLength(payload))
      }

      const tryRequest = (
        client: typeof httpsModule | typeof httpModule,
        rejectUnauthorized: boolean
      ) => {
        const req = client.request(
          {
            hostname: "127.0.0.1",
            port,
            path: rawPath,
            method,
            headers,
            ...(client === httpsModule ? { rejectUnauthorized } : {}),
          },
          (res) => {
            const chunks: Buffer[] = []
            let total = 0
            const cap = 1024
            res.on("data", (chunk: Buffer) => {
              if (total < cap) {
                chunks.push(chunk)
                total += chunk.length
              }
            })
            res.on("end", () => {
              const merged = Buffer.concat(chunks)
                .slice(0, cap)
                .toString("utf8")
              resolve({
                ok: true,
                status: res.statusCode ?? 0,
                durationMs: Date.now() - start,
                bodyPreview: merged,
                contentType:
                  typeof res.headers["content-type"] === "string"
                    ? res.headers["content-type"]
                    : undefined,
              })
            })
          }
        )
        req.on("error", (err) => {
          // First failure on HTTPS: retry over plain HTTP in case the
          // bridge is running unencrypted (test fixtures, no certs).
          if (client === httpsModule) {
            tryRequest(httpModule, rejectUnauthorized)
            return
          }
          resolve({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - start,
          })
        })
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`probe timed out after ${timeoutMs}ms`))
        })
        if (payload.length > 0) {
          req.write(payload)
        }
        req.end()
      }

      tryRequest(httpsModule, false)
    })
  }

  @Post("claude/integration/connect")
  connectClaudeCliToBridge(
    @Body()
    body: {
      bridgeUrl?: string
      apiKey?: string
      caCertPath?: string
    } = {}
  ) {
    const bridgeUrl = (body.bridgeUrl || "").trim()
    if (!bridgeUrl) {
      return Promise.resolve({
        error: "missing bridgeUrl",
      } as const)
    }
    return connectClaudeCli({
      bridgeUrl,
      apiKey: body.apiKey?.trim() || undefined,
      caCertPath: body.caCertPath?.trim() || undefined,
    })
  }

  @Post("claude/integration/disconnect")
  disconnectClaudeCliFromBridge() {
    return disconnectClaudeCli()
  }
}
