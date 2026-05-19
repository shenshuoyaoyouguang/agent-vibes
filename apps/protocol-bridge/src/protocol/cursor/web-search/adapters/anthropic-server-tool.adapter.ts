import { Logger } from "@nestjs/common"

import { AnthropicApiService } from "../../../../llm/anthropic/anthropic-api.service"
import {
  applyDomainFilters,
  type WebSearchAdapter,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResult,
  throwIfAborted,
} from "../types"

/**
 * Anthropic `web_search_20250305` server-tool adapter.
 *
 * Mirrors the wire-shape used by claude-code's `ApiSearchAdapter`:
 * we hand the Messages API a synthesized turn that wraps the user
 * query and lists `{ type: "web_search_20250305", … }` in `tools[]`.
 * The Anthropic backend executes the search server-side, streams
 * back `server_tool_use` + `web_search_tool_result` blocks, and the
 * existing `AnthropicApiService.executeWebSearch` extractor returns
 * `{ text, references }` for us to project into `WebSearchResult[]`.
 *
 * Selected for the `claude-api` backend by default. Available iff
 * `AnthropicApiService` reports configured account credentials.
 */
export class AnthropicServerToolAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(AnthropicServerToolAdapter.name)
  readonly name: WebSearchAdapterName = "anthropic-server-tool"

  constructor(private readonly anthropic: AnthropicApiService) {}

  isAvailable(): boolean {
    return this.anthropic.isAvailable()
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const grounded = await this.anthropic.executeWebSearch({
      query,
      model: options.model,
      // Anthropic charges per `web_search_20250305` use, capped per
      // session. The claude-code default is 5; we expose
      // `options.numResults` as the agent-facing knob and forward it
      // straight through.
      maxUses:
        Number.isFinite(options.numResults) &&
        (options.numResults as number) > 0
          ? options.numResults
          : undefined,
    })

    throwIfAborted(options.signal)

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
      this.logger.warn(
        `[anthropic-server-tool] empty result (query="${query.slice(0, 80)}")`
      )
      throw new Error(
        "anthropic-server-tool returned no results (empty server_tool_use response)"
      )
    }

    return trimmed
  }
}
