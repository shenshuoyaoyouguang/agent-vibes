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
 * Brave Search "LLM Context" adapter.
 *
 * Direct port of claude-code's `BraveSearchAdapter`. Hits the
 * `https://api.search.brave.com/res/v1/llm/context` endpoint, which
 * returns a small JSON payload optimized for grounding (`grounding`
 * field with `generic`, `map`, `poi` arrays). The endpoint is gated
 * behind an API key; if no key is configured this adapter is
 * unavailable and the factory will skip it.
 *
 * Two env vars are accepted, in priority order:
 *   1. `BRAVE_SEARCH_API_KEY`
 *   2. `BRAVE_API_KEY`
 *
 * Selected explicitly via `WEB_SEARCH_ADAPTER=brave-llm` or implicitly
 * when the active backend has no first-party search and the operator
 * has provisioned a Brave key (preferred over the keyless Exa MCP for
 * legal-cleanliness reasons — Brave's TOS explicitly permits agentic
 * use, Exa's free tier is undocumented territory).
 */
const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context"
const BRAVE_TIMEOUT_MS = 30_000
const BRAVE_API_KEY_ENV_VARS = [
  "BRAVE_SEARCH_API_KEY",
  "BRAVE_API_KEY",
] as const

interface BraveGroundingResult {
  title?: string
  url?: string
  snippets?: string[]
}

interface BraveLlmContextResponse {
  grounding?: {
    generic?: BraveGroundingResult[]
    map?: BraveGroundingResult[]
    poi?: BraveGroundingResult | null
  }
}

export class BraveLlmAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(BraveLlmAdapter.name)
  readonly name: WebSearchAdapterName = "brave-llm"

  isAvailable(): boolean {
    return getBraveApiKey() !== undefined
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const apiKey = getBraveApiKey()
    if (!apiKey) {
      throw new Error(
        "brave-llm adapter is not configured (missing BRAVE_SEARCH_API_KEY)"
      )
    }

    const composedQuery = options.domain
      ? `${query} site:${options.domain}`
      : query

    const controller = new AbortController()
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error("brave-llm timeout")),
      BRAVE_TIMEOUT_MS
    )
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutHandle)
        throw new WebSearchAbortError()
      }
      options.signal.addEventListener(
        "abort",
        () => controller.abort(new WebSearchAbortError()),
        { once: true }
      )
    }

    let payload: BraveLlmContextResponse
    try {
      const response = await fetch(
        `${BRAVE_LLM_CONTEXT_URL}?q=${encodeURIComponent(composedQuery)}`,
        {
          method: "GET",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
            "User-Agent": "agent-vibes-bridge/web-search-brave-llm",
          },
        }
      )
      if (!response.ok) {
        const snippet = (await response.text()).slice(0, 500)
        throw new Error(
          `brave-llm HTTP ${response.status}: ${snippet || "(empty body)"}`
        )
      }
      payload = (await response.json()) as BraveLlmContextResponse
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

    const raw = extractBraveResults(payload)
    const filtered = applyDomainFilters(raw, options)
    const limit = options.numResults ?? 8
    const trimmed =
      Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered

    options.onProgress?.({
      type: "search_results_received",
      query,
      resultCount: trimmed.length,
    })

    if (trimmed.length === 0) {
      this.logger.warn(
        `[brave-llm] empty result (query="${query.slice(0, 80)}")`
      )
      throw new Error("brave-llm returned no results")
    }

    return trimmed
  }
}

function getBraveApiKey(): string | undefined {
  for (const envVar of BRAVE_API_KEY_ENV_VARS) {
    const value = process.env[envVar]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function extractBraveResults(
  payload: BraveLlmContextResponse
): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const seen = new Set<string>()
  const grounding = payload.grounding

  const consume = (entry: BraveGroundingResult | undefined | null): void => {
    if (!entry?.url) return
    const url = entry.url.trim()
    if (!url || seen.has(url)) return
    seen.add(url)
    const snippet = entry.snippets?.find((s) => s && s.trim().length > 0)
    out.push({
      title: entry.title?.trim() || url,
      url,
      snippet: snippet || undefined,
      chunk: snippet || undefined,
    })
  }

  for (const entry of grounding?.generic ?? []) consume(entry)
  for (const entry of grounding?.map ?? []) consume(entry)
  consume(grounding?.poi ?? undefined)
  return out
}
