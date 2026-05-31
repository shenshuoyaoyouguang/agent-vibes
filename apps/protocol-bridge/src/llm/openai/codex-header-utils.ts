export type CodexForwardHeaders = Record<string, string>

/**
 * Identity values mirroring what the upstream openai/codex CLI sends. Use
 * `CodexClientIdentityService` to resolve a fresh instance at boot and pass
 * it to the header builders below — there is no module-level fallback here
 * by design, so missing wiring fails loudly at the type checker rather than
 * silently spoofing a stale version.
 */
export interface CodexClientIdentity {
  /** Sent in the `version` header (and `Version` alias). */
  version: string
  /** Full User-Agent string. */
  userAgent: string
  /** Sent in the `Originator` header for OAuth (non-API-key) requests. */
  originator: string
}

export const CODEX_WS_BETA_HEADER = "responses_websockets=2026-02-06"

interface BuildCodexHttpHeadersParams {
  token: string
  isApiKey: boolean
  stream: boolean
  identity: CodexClientIdentity
  conversationId?: string
  accountId?: string
  workspaceId?: string
  cacheHeaders?: Record<string, string>
  forwardHeaders?: CodexForwardHeaders
  omitAccountId?: boolean
}

interface BuildCodexWebSocketHeadersParams {
  token: string
  isApiKey: boolean
  identity: CodexClientIdentity
  conversationId?: string
  accountId?: string
  workspaceId?: string
  cacheHeaders?: Record<string, string>
  forwardHeaders?: CodexForwardHeaders
  omitAccountId?: boolean
}

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase()
}

function getForwardHeader(
  headers: CodexForwardHeaders | undefined,
  ...keys: string[]
): string {
  if (!headers) {
    return ""
  }

  const normalizedEntries: Array<[string, string]> = Object.entries(
    headers
  ).map(([key, value]) => [normalizeHeaderKey(key), value])

  for (const key of keys) {
    const normalizedKey = normalizeHeaderKey(key)
    const match = normalizedEntries.find(
      ([candidateKey]) => candidateKey === normalizedKey
    )
    if (match && match[1].trim() !== "") {
      return match[1].trim()
    }
  }

  return ""
}

function getExistingHeader(
  headers: Record<string, string>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const normalizedKey = normalizeHeaderKey(key)
    for (const [candidateKey, candidateValue] of Object.entries(headers)) {
      if (
        normalizeHeaderKey(candidateKey) === normalizedKey &&
        candidateValue.trim() !== ""
      ) {
        return candidateValue.trim()
      }
    }
  }

  return ""
}

function ensureHeader(
  target: Record<string, string>,
  source: CodexForwardHeaders | undefined,
  key: string,
  defaultValue: string,
  aliases: string[] = []
): void {
  const sourceValue = getForwardHeader(source, key, ...aliases)
  if (sourceValue) {
    target[key] = sourceValue
    return
  }

  if (getExistingHeader(target, key, ...aliases)) {
    return
  }

  const trimmedDefault = defaultValue.trim()
  if (trimmedDefault) {
    target[key] = trimmedDefault
  }
}

function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => typeof value === "string" && value.trim() !== ""
    )
  )
}

export function buildCodexHttpHeaders(
  params: BuildCodexHttpHeadersParams
): Record<string, string> {
  const normalizedConversationId = params.conversationId?.trim() || ""
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${params.token}`,
    Accept: params.stream ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive",
    ...(params.cacheHeaders || {}),
  }

  const betaFeatures = getForwardHeader(
    params.forwardHeaders,
    "x-codex-beta-features"
  )
  if (betaFeatures) {
    headers["X-Codex-Beta-Features"] = betaFeatures
  }

  ensureHeader(
    headers,
    params.forwardHeaders,
    "version",
    params.identity.version,
    ["Version"]
  )
  ensureHeader(headers, params.forwardHeaders, "X-Codex-Turn-Metadata", "", [
    "x-codex-turn-metadata",
  ])
  ensureHeader(
    headers,
    params.forwardHeaders,
    "X-Client-Request-Id",
    normalizedConversationId,
    ["x-client-request-id"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "User-Agent",
    params.identity.userAgent,
    ["user-agent"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "session_id",
    normalizedConversationId || crypto.randomUUID(),
    ["session_id", "session-id"]
  )

  if (!params.isApiKey) {
    ensureHeader(
      headers,
      params.forwardHeaders,
      "Originator",
      params.identity.originator,
      ["originator"]
    )
    const accountId = params.omitAccountId ? "" : params.accountId?.trim() || ""
    if (accountId) {
      headers["Chatgpt-Account-Id"] = accountId
    }
    const workspaceId = params.workspaceId?.trim() || ""
    if (workspaceId) {
      headers["OpenAI-Organization"] = workspaceId
    }
  }

  return sanitizeHeaders(headers)
}

export function buildCodexWebSocketHeaders(
  params: BuildCodexWebSocketHeadersParams
): Record<string, string> {
  const normalizedConversationId = params.conversationId?.trim() || ""
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
    ...(params.cacheHeaders || {}),
  }

  const betaFeatures = getForwardHeader(
    params.forwardHeaders,
    "x-codex-beta-features"
  )
  if (betaFeatures) {
    headers["x-codex-beta-features"] = betaFeatures
  }

  ensureHeader(headers, params.forwardHeaders, "x-codex-turn-state", "", [
    "x-codex-turn-state",
  ])
  ensureHeader(headers, params.forwardHeaders, "x-codex-turn-metadata", "", [
    "x-codex-turn-metadata",
  ])
  ensureHeader(
    headers,
    params.forwardHeaders,
    "x-client-request-id",
    normalizedConversationId,
    ["x-client-request-id"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "x-responsesapi-include-timing-metrics",
    "",
    ["x-responsesapi-include-timing-metrics"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "version",
    params.identity.version,
    ["Version"]
  )
  // The WebSocket upgrade request strips User-Agent before send (see the
  // explicit `delete headers["User-Agent"]` below), but we still register it
  // here so any forwardHeaders override would be honored if WebSocket
  // semantics change. Keep User-Agent identity in sync with HTTP.
  ensureHeader(
    headers,
    params.forwardHeaders,
    "User-Agent",
    params.identity.userAgent,
    ["user-agent"]
  )

  const openAiBeta = getForwardHeader(params.forwardHeaders, "openai-beta")
  headers["OpenAI-Beta"] =
    openAiBeta && openAiBeta.includes("responses_websockets=")
      ? openAiBeta
      : CODEX_WS_BETA_HEADER

  ensureHeader(
    headers,
    params.forwardHeaders,
    "session_id",
    normalizedConversationId || crypto.randomUUID(),
    ["session_id", "session-id"]
  )
  delete headers["User-Agent"]

  if (!params.isApiKey) {
    ensureHeader(
      headers,
      params.forwardHeaders,
      "Originator",
      params.identity.originator,
      ["originator"]
    )
    const accountId = params.omitAccountId ? "" : params.accountId?.trim() || ""
    if (accountId) {
      headers["Chatgpt-Account-Id"] = accountId
    }
    const workspaceId = params.workspaceId?.trim() || ""
    if (workspaceId) {
      headers["OpenAI-Organization"] = workspaceId
    }
  }

  return sanitizeHeaders(headers)
}
