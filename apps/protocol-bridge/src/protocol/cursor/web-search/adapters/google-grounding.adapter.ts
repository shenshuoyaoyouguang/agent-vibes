import { Logger } from "@nestjs/common"

import { GoogleService } from "../../../../llm/google/google.service"
import {
  applyDomainFilters,
  type WebSearchAdapter,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResult,
  throwIfAborted,
} from "../types"

/**
 * Google Cloud Code grounded search.
 *
 * This adapter is the right choice when the active session routes to
 * the `google` or `google-claude` backend — both share the same Cloud
 * Code account pool, so the grounded-search RPC piggybacks on quota
 * already consumed for ordinary inference. It is also the canonical
 * answer for "no first-party search but a Google account is mounted":
 * the factory may pick this for `kiro` / `openai-compat` sessions when
 * an explicit `WEB_SEARCH_ADAPTER=google-grounding` override is set,
 * but it is NOT the default fallback for those backends — the agent
 * should not silently borrow Google quota.
 *
 * Implementation note: every detail of provider rotation, 429 cooldown
 * tables, OAuth refresh, and grounding-metadata extraction lives
 * inside `GoogleService.executeWebSearch`. We deliberately keep this
 * adapter as a thin wrapper so the heavy lifting stays where it is
 * unit-tested and so we don't drift from the bridge's existing
 * Google-side behavior.
 */
export class GoogleGroundingAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(GoogleGroundingAdapter.name)
  readonly name: WebSearchAdapterName = "google-grounding"

  constructor(private readonly google: GoogleService) {}

  isAvailable(): boolean {
    return this.google.isLocallyConfigured()
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const grounded = await this.google.executeWebSearch(query)

    throwIfAborted(options.signal)

    // Cloud Code returns `{ text, references[] }`. We only surface
    // structured references — the prose `text` field is the model's
    // own summary and would double up with what the agent will write
    // anyway. The connect-stream layer keeps `text` separately.
    const raw: WebSearchResult[] = grounded.references.map((ref) => ({
      title: ref.title || ref.url,
      url: ref.url,
      snippet: ref.chunk || undefined,
      chunk: ref.chunk || undefined,
    }))

    const filtered = applyDomainFilters(raw, options)
    const limit = options.numResults ?? 8
    const trimmed =
      Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered

    options.onProgress?.({
      type: "search_results_received",
      query,
      resultCount: trimmed.length,
    })

    if (trimmed.length === 0 && grounded.text.trim().length === 0) {
      // Grounding returned absolutely nothing — neither prose nor refs.
      // Treat as a hard failure so the model gets a real error rather
      // than a fabricated empty success.
      this.logger.warn(
        `[google-grounding] empty result (query="${query.slice(0, 80)}")`
      )
      throw new Error(
        "google-grounding returned no results (empty grounding metadata)"
      )
    }

    return trimmed
  }
}
