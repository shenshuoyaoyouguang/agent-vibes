/**
 * Public surface for the Cursor protocol bridge's web_search module.
 *
 * Consumers (the connect-stream layer) only ever import from this
 * file — they never reach into adapters/ directly. This keeps the
 * factory + service boundary clean and lets us swap adapter
 * implementations without ripple-changing the upstream code.
 */

export { WebSearchService } from "./web-search.service"
export { WebSearchAdapterFactory } from "./web-search.factory"
export type {
  WebSearchAdapter,
  WebSearchAdapterName,
  WebSearchOptions,
  WebSearchProgress,
  WebSearchResponse,
  WebSearchResult,
} from "./types"
export { WebSearchAbortError } from "./types"
