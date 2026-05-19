import { Injectable, Logger } from "@nestjs/common"

import type { BackendType } from "../../../llm/shared/model-router.service"

import { WebSearchAdapterFactory } from "./web-search.factory"
import {
  WebSearchAbortError,
  type WebSearchAdapterName,
  type WebSearchOptions,
  type WebSearchResponse,
  type WebSearchResult,
} from "./types"

/**
 * Single entry point for every `web_search` invocation in the bridge.
 *
 * The connect-stream layer no longer talks to GoogleService /
 * AnthropicApiService / CodexService directly for search; it calls
 * `executeSearch(...)`, gets back a `WebSearchResponse`, and projects
 * that into the Cursor-protocol surface.
 *
 * Design contract:
 *   - exactly one adapter per call (chosen by `WebSearchAdapterFactory`);
 *   - if the adapter throws, this service propagates the error after
 *     normalising it into a stable shape;
 *   - if the caller's AbortSignal fires, this service propagates
 *     `WebSearchAbortError`;
 *   - empty results coming back from an otherwise-successful adapter
 *     are reported as a thrown error (an empty list is *never* a
 *     useful tool result for the model);
 *   - response carries `adapter` for telemetry / UI attribution and
 *     `query` for echoing back the (possibly normalised) query.
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name)

  constructor(private readonly factory: WebSearchAdapterFactory) {}

  async executeSearch(
    backend: BackendType | undefined,
    query: string,
    options: WebSearchOptions = {}
  ): Promise<WebSearchResponse> {
    const trimmed = query.trim()
    if (!trimmed) {
      throw new Error("web_search query is empty")
    }

    const adapter = this.factory.selectAdapter(backend)
    let results: WebSearchResult[]
    try {
      results = await adapter.search(trimmed, {
        ...options,
        conversationId: options.conversationId,
      })
    } catch (err) {
      if (err instanceof WebSearchAbortError) {
        // Caller aborted; surface the abort verbatim so connect-stream
        // can short-circuit the in-flight tool call without emitting
        // a "search failed" frame.
        throw err
      }
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(
        `[web-search] adapter=${adapter.name} failed: ${message.slice(0, 240)}`
      )
      // Re-throw with a stable prefix so the connect-stream layer can
      // attribute the failure to a specific provider in trace + UI.
      throw new Error(`web_search via ${adapter.name} failed: ${message}`)
    }

    if (results.length === 0) {
      throw new Error(
        `web_search via ${adapter.name} returned no results for query "${trimmed.slice(0, 80)}"`
      )
    }

    return {
      adapter: adapter.name,
      query: trimmed,
      results,
    }
  }

  /**
   * Pure helper: report which adapter the factory would pick for a
   * given backend right now, without running a search. Useful for
   * startup banners and the `kv_get adapter_state` debug surface.
   */
  describeRoute(backend: BackendType | undefined): WebSearchAdapterName {
    return this.factory.selectAdapter(backend).name
  }
}
