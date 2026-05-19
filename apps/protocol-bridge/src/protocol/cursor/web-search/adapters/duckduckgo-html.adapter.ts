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
 * DuckDuckGo HTML SERP scrape adapter (keyless, last-resort).
 *
 * Mirrors claude-code's `BingSearchAdapter` pattern but targets DDG
 * because:
 *   - DDG's `html.duckduckgo.com` mirror serves a JS-free SERP
 *     deterministically across regions, so a simple regex parse
 *     reliably extracts results;
 *   - it does not require an API key, account, or referral header;
 *   - it does not impose CAPTCHA on a single-shot UA-honest fetch
 *     from a residential or VPN egress.
 *
 * This adapter exists to give the bridge a "something is better than
 * nothing" surface when no first-party search is configured AND the
 * keyless MCP route (`exa-mcp`) is also down. It is NOT auto-selected
 * inside an error chain — the factory only routes here when an
 * explicit `WEB_SEARCH_ADAPTER=duckduckgo-html` override is set, or
 * when it is the only adapter that returns true from `isAvailable()`
 * for the active session.
 *
 * If DDG returns an anti-bot page, an EU consent wall, or zero
 * parseable hits, this adapter throws — there is no further chain.
 */
const DDG_HTML_URL = "https://html.duckduckgo.com/html/"
const DDG_TIMEOUT_MS = 25_000

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
} as const

const ANTI_BOT_MARKERS = [
  "anomaly detected",
  "unusual traffic",
  "captcha",
  "are you a robot",
  "verify you are a human",
  "automated requests",
  "access denied",
] as const

export class DuckDuckGoHtmlAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(DuckDuckGoHtmlAdapter.name)
  readonly name: WebSearchAdapterName = "duckduckgo-html"

  isAvailable(): boolean {
    // Keyless / public; statically always "available". Runtime
    // failures (CAPTCHA, layout shift, 5xx) surface as thrown errors.
    return true
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const composedQuery = options.domain
      ? `${query} site:${options.domain}`
      : query

    // We POST to the html.duckduckgo.com form endpoint rather than GET
    // the duckduckgo.com `/?q=` URL, because the former renders the
    // full SERP without JS while the latter returns a stub that the
    // browser hydrates from JS — useless for a server-side fetch.
    const formBody = new URLSearchParams({
      q: composedQuery,
      kl: "us-en",
    }).toString()

    const controller = new AbortController()
    const timeoutHandle = setTimeout(
      () => controller.abort(new Error("duckduckgo-html timeout")),
      DDG_TIMEOUT_MS
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

    let html: string
    try {
      const response = await fetch(DDG_HTML_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody,
        redirect: "follow",
      })
      if (!response.ok) {
        const snippet = (await response.text()).slice(0, 500)
        throw new Error(
          `duckduckgo-html HTTP ${response.status}: ${snippet || "(empty body)"}`
        )
      }
      html = await response.text()
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

    const lowered = html.toLowerCase()
    if (
      html.length < 200 ||
      ANTI_BOT_MARKERS.some((marker) => lowered.includes(marker))
    ) {
      this.logger.warn(
        `[duckduckgo-html] anti-bot / consent page detected ` +
          `(len=${html.length})`
      )
      throw new Error(
        "duckduckgo-html returned an anti-bot or consent page (no parseable SERP)"
      )
    }

    const raw = extractDuckDuckGoResults(html)
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
      throw new Error("duckduckgo-html returned no parseable results")
    }

    return trimmed
  }
}

/**
 * Extract results from html.duckduckgo.com SERP HTML.
 *
 * The relevant block looks like:
 *   <div class="result results_links results_links_deep web-result">
 *     <div class="result__body">
 *       <h2 class="result__title"><a class="result__a" href="…">Title</a></h2>
 *       <a class="result__snippet" href="…">Snippet text</a>
 *     </div>
 *   </div>
 *
 * The href on `result__a` is wrapped in DDG's redirector
 * (`/l/?uddg=<urlencoded>`); we unwrap it client-side.
 */
function extractDuckDuckGoResults(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = []
  const seen = new Set<string>()

  const blockRegex =
    /<div class="result(?:\s+[^"]*)?">([\s\S]*?)(?=<div class="result(?:\s+[^"]*)?">|<\/div>\s*<\/div>\s*<\/div>\s*$)/g
  // The pattern above is fairly lossy — DDG's HTML can shift block
  // boundaries between deploys. Fall back to a per-anchor scan below.
  let m: RegExpExecArray | null
  while ((m = blockRegex.exec(html)) !== null) {
    const block = m[1] || ""
    const titleMatch = block.match(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    )
    const snippetMatch = block.match(
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i
    )
    if (!titleMatch) continue
    const titleHref = titleMatch[1]
    const titleInner = titleMatch[2] ?? ""
    if (!titleHref) continue
    const url = unwrapDuckDuckGoRedirect(titleHref)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const snippetInner = snippetMatch?.[1] ?? ""
    out.push({
      title: stripHtml(titleInner).trim() || url,
      url,
      snippet: snippetInner
        ? stripHtml(snippetInner).trim() || undefined
        : undefined,
    })
  }

  if (out.length === 0) {
    // Last-ditch: scan every <a class="result__a"> anchor in document
    // order. This happens when DDG ships a layout we don't recognize.
    const anchorRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let a: RegExpExecArray | null
    while ((a = anchorRegex.exec(html)) !== null) {
      const href = a[1]
      const inner = a[2] ?? ""
      if (!href) continue
      const url = unwrapDuckDuckGoRedirect(href)
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push({
        title: stripHtml(inner).trim() || url,
        url,
      })
    }
  }

  return out
}

function unwrapDuckDuckGoRedirect(href: string): string | undefined {
  if (!href) return undefined
  // DDG wraps target URLs as `/l/?uddg=<urlencoded>` (sometimes with
  // a leading `//duckduckgo.com`). Unwrap so downstream consumers see
  // the actual destination.
  try {
    const candidate = href.startsWith("//")
      ? `https:${href}`
      : href.startsWith("/")
        ? `https://duckduckgo.com${href}`
        : href
    const u = new URL(candidate)
    const uddg = u.searchParams.get("uddg")
    if (uddg) {
      return decodeURIComponent(uddg)
    }
    if (/^https?:$/i.test(u.protocol)) {
      return u.toString()
    }
  } catch {
    /* swallow; treat as unparseable */
  }
  return undefined
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
}
