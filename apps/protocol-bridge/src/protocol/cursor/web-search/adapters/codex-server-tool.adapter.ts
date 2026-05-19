import { Logger } from "@nestjs/common"

import { CodexService } from "../../../../llm/openai/codex.service"
import {
  applyDomainFilters,
  type WebSearchAdapter,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResult,
  throwIfAborted,
} from "../types"

/**
 * OpenAI Codex Responses-API `web_search` server-tool adapter.
 *
 * Mirrors the wire-shape used inside codex-rs proper: the Responses
 * API exposes `web_search` as a top-level entry in `tools[]`, the
 * model emits `web_search_call` items, and the SSE stream carries
 * `url_citation` annotations alongside the assistant text. The
 * existing `CodexService.executeWebSearch` does exactly that and
 * hands us back `{ text, references }`.
 *
 * Selected for the `codex` and `openai-compat` backends by default.
 * Available iff `CodexService` reports configured account credentials.
 */
export class CodexServerToolAdapter implements WebSearchAdapter {
  private readonly logger = new Logger(CodexServerToolAdapter.name)
  readonly name: WebSearchAdapterName = "codex-server-tool"

  constructor(private readonly codex: CodexService) {}

  isAvailable(): boolean {
    return this.codex.isAvailable()
  }

  async search(
    query: string,
    options: WebSearchOptions
  ): Promise<WebSearchResult[]> {
    throwIfAborted(options.signal)
    options.onProgress?.({ type: "query_update", query })

    const grounded = await this.codex.executeWebSearch({
      query,
      model: options.model,
      conversationId: options.conversationId,
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
        `[codex-server-tool] empty result (query="${query.slice(0, 80)}")`
      )
      throw new Error(
        "codex-server-tool returned no results (empty web_search_call response)"
      )
    }

    return trimmed
  }
}
