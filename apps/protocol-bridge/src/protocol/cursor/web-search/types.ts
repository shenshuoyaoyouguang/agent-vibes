/**
 * Web search adapter contract for the Cursor protocol bridge.
 *
 * Mirrors the design lifted from Anthropic claude-code's
 * `packages/builtin-tools/src/tools/WebSearchTool/adapters/` —
 * a single adapter is selected per session at dispatch time
 * (build-time selection, not error-time fallback) and is the only
 * thing that talks to a network surface. If the adapter fails, the
 * tool fails; the model decides what to do next. There is no chained
 * "try A then B then C" inside the bridge.
 *
 * This file is the SOURCE OF TRUTH for the search wire shape. The
 * connect-stream layer composes / serializes / projects results, but
 * never reaches around the adapter to tickle a backend directly.
 */

/**
 * One search hit.
 *
 * Shape mirrors claude-code's `SearchResult` exactly so we can later
 * port their adapter unit tests verbatim if we want. `chunk` is our
 * project-specific addition for grounded providers (Google / Anthropic
 * / Codex) that return a quoted snippet alongside the URL.
 */
export interface WebSearchResult {
  /** Page title or, if unavailable, the URL itself. */
  title: string
  /** Absolute URL to the page. */
  url: string
  /** Optional short snippet from the page body. */
  snippet?: string
  /** Optional verbatim quote captured by the grounding provider. */
  chunk?: string
}

/**
 * Adapter input contract.
 *
 * Field set chosen to match the claude-code WebSearchTool input schema
 * (query / allowed_domains / blocked_domains / num_results / livecrawl
 * / search_type / context_max_characters). Adapters MUST tolerate
 * unknown / unsupported options by ignoring them, never by failing.
 */
export interface WebSearchOptions {
  /** Optional list of host suffixes; results from other hosts are dropped. */
  allowedDomains?: string[]
  /** Optional list of host suffixes; results from these hosts are dropped. */
  blockedDomains?: string[]
  /** Cancellation signal; adapters MUST honour this. */
  signal?: AbortSignal
  /** Streaming progress callback (query echoes, result count, …). */
  onProgress?: (progress: WebSearchProgress) => void
  /** Soft cap on the number of results to return. Defaults to 8. */
  numResults?: number
  /**
   * Live-crawl preference for adapters that support cached vs live
   * results (Exa, Brave). `'fallback'` = cached unless missing,
   * `'preferred'` = always live. Default `'fallback'`.
   */
  livecrawl?: "fallback" | "preferred"
  /**
   * Search depth hint for adapters that support multiple modes (Exa).
   * `'auto'` = balanced, `'fast'` = low latency, `'deep'` = exhaustive.
   * Default `'auto'`.
   */
  searchType?: "auto" | "fast" | "deep"
  /**
   * Soft cap on the LLM-context character budget. Adapters use this
   * to size their per-result snippet budget. Default 10_000.
   */
  contextMaxCharacters?: number
  /** Optional caller-provided conversation id, used for telemetry. */
  conversationId?: string
  /** Optional model hint for adapters that need to pick a model. */
  model?: string
  /** Optional domain restriction (folded into the query as `site:`). */
  domain?: string
}

/**
 * Progress event types reported by adapters during search.
 *
 * We intentionally keep this enum small — the connect-stream layer
 * surfaces these as `interactionUpdate` heartbeats, not as a structured
 * progress channel.
 */
export interface WebSearchProgress {
  type: "query_update" | "search_results_received"
  query?: string
  resultCount?: number
}

/**
 * Stable adapter identifiers. New adapters MUST be added here so the
 * factory's exhaustiveness check at the type level is preserved.
 */
export type WebSearchAdapterName =
  | "google-grounding"
  | "anthropic-server-tool"
  | "codex-server-tool"
  | "exa-mcp"
  | "brave-llm"
  | "duckduckgo-html"

/**
 * The single contract every adapter implements.
 */
export interface WebSearchAdapter {
  /**
   * Stable adapter identifier, embedded in result metadata so the
   * connect-stream layer (and protocol traces) can attribute which
   * provider served a given response.
   */
  readonly name: WebSearchAdapterName

  /**
   * Returns true iff the adapter has the credentials / pools / config
   * it needs to serve a search right now. Selection logic uses this as
   * a hard precondition — an adapter that returns false is never
   * picked, and the factory falls through to the next candidate.
   */
  isAvailable(): boolean

  /**
   * Run a single search. MUST honour `options.signal` and propagate
   * `WebSearchAbortError` on cancel. MUST NOT swallow upstream errors
   * silently — if the upstream rejects (quota, 5xx, network, parse
   * failure, …), throw. The caller layer turns the throw into a
   * structured tool failure for the model.
   */
  search(query: string, options: WebSearchOptions): Promise<WebSearchResult[]>
}

/**
 * Aggregated search response handed back to the connect-stream layer.
 * Carries adapter attribution so the protocol surface can render
 * "[web_search via exa-mcp]" instead of unattributed text.
 */
export interface WebSearchResponse {
  adapter: WebSearchAdapterName
  query: string
  results: WebSearchResult[]
}

/**
 * Standard error class adapters throw on cancellation. Connect-stream
 * recognizes this and stops the in-flight tool call without surfacing
 * a "search failed" frame.
 */
export class WebSearchAbortError extends Error {
  constructor(message = "web_search aborted") {
    super(message)
    this.name = "WebSearchAbortError"
  }
}

/**
 * Apply caller-supplied allowed/blocked-domain filters to a result list.
 * Centralized here so every adapter behaves identically (claude-code
 * applies this client-side too — server-side `filters` are
 * provider-specific and unreliable across backends).
 */
export function applyDomainFilters(
  results: WebSearchResult[],
  options: Pick<WebSearchOptions, "allowedDomains" | "blockedDomains">
): WebSearchResult[] {
  const allowed = (options.allowedDomains || []).filter((d) => d.length > 0)
  const blocked = (options.blockedDomains || []).filter((d) => d.length > 0)
  if (allowed.length === 0 && blocked.length === 0) return results

  return results.filter((r) => {
    if (!r.url) return false
    let hostname: string
    try {
      hostname = new URL(r.url).hostname.toLowerCase()
    } catch {
      return false
    }
    if (allowed.length > 0) {
      const ok = allowed.some(
        (d) =>
          hostname === d.toLowerCase() ||
          hostname.endsWith("." + d.toLowerCase())
      )
      if (!ok) return false
    }
    if (blocked.length > 0) {
      const blockedHit = blocked.some(
        (d) =>
          hostname === d.toLowerCase() ||
          hostname.endsWith("." + d.toLowerCase())
      )
      if (blockedHit) return false
    }
    return true
  })
}

/**
 * Convenience: throw `WebSearchAbortError` if the supplied signal has
 * already been aborted, otherwise no-op.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WebSearchAbortError()
  }
}
