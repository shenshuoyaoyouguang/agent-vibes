import { Logger } from "@nestjs/common"

import {
  applyDomainFilters,
  WebSearchAbortError,
  type WebSearchAdapter,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResult,
  throwIfAborted,
} from "../types"

/**
 * Exa AI search via the public, keyless MCP endpoint.
 *
 * This is a near-verbatim port of claude-code's `ExaSearchAdapter`
 * (`packages/builtin-tools/src/tools/WebSearchTool/adapters/
 * exaAdapter.ts`). Important property: the endpoint at
 * `https://mcp.exa.ai/mcp` does NOT require an API key — Exa
 * publishes it as a free MCP server for agents. That makes this
 * adapter the right default for backends that have no first-party
 * search surface (Kiro, generic openai-compat, anything we don't
 * recognize), without forcing the agent to silently borrow Google
 * Cloud Code quota.
 *
 * Wire format: JSON-RPC 2.0 `tools/call` invoking `web_search_exa`.
 * Response is SSE; the only frame we care about is the one with
 * `result.content[0].text` carrying the structured search payload.
 *
 * If the SSE stream is malformed or the response carries zero
 * parseable hits, we throw rather than fabricate an empty success.
 */
const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const EXA_MCP_TIMEOUT_MS = 25_000

export class ExaMcpAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(ExaMcpAdapter.name)
  readonly name: WebSearchAdapterName = "exa-mcp"

  isAvailable(): boolean {
    // Keyless / public — always available as long as the bridge has
    // network egress. The factory will fall through to a different
    // adapter if a 5xx / network failure surfaces at runtime, but
    // there is no static configuration to gate on.
    return true
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const numResults = options.numResults ?? 8
    const livecrawl = options.livecrawl ?? "fallback"
    const searchType = options.searchType ?? "auto"
    const contextMaxCharacters = options.contextMaxCharacters ?? 10_000

    const composedQuery = options.domain
      ? `${query} site:${options.domain}`
      : query

    const requestPayload = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/call" as const,
      params: {
        name: "web_search_exa",
        arguments: {
          query: composedQuery,
          type: searchType,
          numResults,
          livecrawl,
          contextMaxCharacters,
        },
      },
    }

    // Combine caller-supplied AbortSignal with our own timeout. We use
    // a private controller so the timeout fires independently of the
    // caller's lifecycle, and so the caller's signal cancels the fetch
    // even if the timeout is still pending.
    const controller = new AbortController()
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error("exa-mcp timeout")),
      EXA_MCP_TIMEOUT_MS
    )
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutHandle)
        throw new WebSearchAbortError()
      }
      options.signal.addEventListener(
        "abort",
        () => {
          controller.abort(new WebSearchAbortError())
        },
        { once: true }
      )
    }

    let bodyText: string
    try {
      const response = await fetch(EXA_MCP_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": "agent-vibes-bridge/web-search-exa-mcp",
        },
        body: JSON.stringify(requestPayload),
      })
      if (!response.ok) {
        const snippet = (await response.text()).slice(0, 500)
        throw new Error(
          `exa-mcp HTTP ${response.status}: ${snippet || "(empty body)"}`
        )
      }
      bodyText = await response.text()
    } catch (err) {
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof WebSearchAbortError
      ) {
        throw controller.signal.reason
      }
      if (options.signal?.aborted) {
        throw new WebSearchAbortError()
      }
      throw err
    } finally {
      clearTimeout(timeoutHandle)
    }

    throwIfAborted(options.signal)

    const payloadText = parseExaSse(bodyText)
    if (!payloadText) {
      this.logger.warn(
        `[exa-mcp] no parseable SSE payload (query="${query.slice(0, 80)}")`
      )
      throw new Error("exa-mcp response did not carry a parseable payload")
    }

    const raw = parseExaResults(payloadText)
    const filtered = applyDomainFilters(raw, options)
    const trimmed =
      Number.isFinite(numResults) && numResults > 0
        ? filtered.slice(0, numResults)
        : filtered

    options.onProgress?.({
      type: "search_results_received",
      query,
      resultCount: trimmed.length,
    })

    if (trimmed.length === 0) {
      throw new Error("exa-mcp returned no parseable results")
    }

    return trimmed
  }
}

/**
 * Pull the JSON-RPC payload out of Exa's SSE stream. Format mirrors
 * the kilocode reference parser cited in claude-code: each SSE event
 * is a line `data: <json>`, and the field we want is
 * `parsed.result.content[0].text`.
 */
function parseExaSse(body: string): string | undefined {
  // Helper: pluck `result.content[0].text` out of a parsed JSON-RPC
  // envelope. Lives here (not at module scope) so the `unknown` cast
  // discipline is local — both callsites below funnel through it so
  // we never let an `any` from `JSON.parse` leak into the rest of the
  // adapter.
  const extractText = (parsed: unknown): string | undefined => {
    if (!parsed || typeof parsed !== "object") return undefined
    const result = (parsed as { result?: unknown }).result
    if (!result || typeof result !== "object") return undefined
    const content = (result as { content?: unknown }).content
    if (!Array.isArray(content) || content.length === 0) return undefined
    // `content` is typed as `unknown[]` by the runtime check above
    // (Array.isArray on `unknown` widens to `any[]` historically, but
    // we explicitly narrow each item below).
    const first: unknown = (content as unknown[])[0]
    if (!first || typeof first !== "object") return undefined
    const text = (first as { text?: unknown }).text
    return typeof text === "string" ? text : undefined
  }

  // Wrap `JSON.parse` so the rest of the function stays typed as
  // `unknown` rather than `any`. eslint flags the `any` returned by
  // `JSON.parse` if we use it directly, even when we cast to
  // `unknown` at the call site.
  const safeParse = (text: string): unknown => {
    return JSON.parse(text) as unknown
  }

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (!data || data === "[DONE]" || data === "null") continue
    try {
      const text = extractText(safeParse(data))
      if (text !== undefined) return text
    } catch {
      /* keep scanning */
    }
  }
  // Some Exa responses are plain JSON, not SSE. Fall back accordingly.
  try {
    const text = extractText(safeParse(body))
    if (text !== undefined) return text
  } catch {
    /* not JSON either */
  }
  return undefined
}

/**
 * Exa returns a structured text payload, blocks separated by `---`,
 * each block carrying `Title:`, `URL:`, and `Content:` fields. Two
 * progressive fallbacks (markdown links → plain URLs) cover the cases
 * where Exa serves a non-standard payload.
 */
function parseExaResults(text: string): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const blocks = text.split(/\n---\n/g)
  for (const block of blocks) {
    const titleMatch = block.match(/^Title:\s*(.+)$/m)
    const urlMatch = block.match(/^URL:\s*(https?:\/\/[^\s]+)$/m)
    const contentMatch = block.match(
      /^Content:\s*([\s\S]+?)(?=\n(?:Title:|URL:|---)|$)/m
    )
    if (urlMatch) {
      const url = urlMatch[1]?.trim()
      if (!url) continue
      const title = titleMatch?.[1]?.trim() || url
      const snippet = contentMatch?.[1]?.trim().slice(0, 300) || undefined
      out.push({ title, url, snippet, chunk: snippet })
    }
  }

  if (out.length === 0) {
    const mdLink = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
    let m: RegExpExecArray | null
    while ((m = mdLink.exec(text)) !== null) {
      const title = m[1]?.trim()
      const url = m[2]?.trim()
      if (!title || !url) continue
      out.push({ title, url })
    }
  }
  if (out.length === 0) {
    const plain = /https?:\/\/[^\s<>"\]]+/g
    let m: RegExpExecArray | null
    while ((m = plain.exec(text)) !== null) {
      const url = m[0]
      if (!url) continue
      out.push({ title: url, url })
    }
  }
  return out
}
