import { Injectable, Logger } from "@nestjs/common"

import { AnthropicApiService } from "../../../llm/anthropic/anthropic-api.service"
import { GoogleService } from "../../../llm/google/google.service"
import { CodexService } from "../../../llm/openai/codex.service"
import type { BackendType } from "../../../llm/shared/model-router.service"

import { AnthropicServerToolAdapter } from "./adapters/anthropic-server-tool.adapter"
import { BraveLlmAdapter } from "./adapters/brave-llm.adapter"
import { CodexServerToolAdapter } from "./adapters/codex-server-tool.adapter"
import { DuckDuckGoHtmlAdapter } from "./adapters/duckduckgo-html.adapter"
import { ExaMcpAdapter } from "./adapters/exa-mcp.adapter"
import { GoogleGroundingAdapter } from "./adapters/google-grounding.adapter"
import type { WebSearchAdapter, WebSearchAdapterName } from "./types"

/**
 * Adapter selection follows claude-code's WebSearchTool model:
 * **build-time selection, not error-time fallback**. For a given
 * session we pick exactly one adapter and stick with it; if that
 * adapter throws at runtime, the tool fails and the model decides
 * what to do next (retry with different params, switch to web_fetch,
 * give up, …).
 *
 * The factory is deterministic and side-effect free — its only
 * inputs are the active session's backend and the operator's env
 * overrides. There is no in-flight provider chain, no error
 * fingerprint matcher, no quota-driven re-routing inside the bridge.
 *
 * Selection rules (first match wins):
 *
 *  1. Explicit `WEB_SEARCH_ADAPTER=<name>` env override. The named
 *     adapter MUST be available; if not, the factory throws so the
 *     misconfiguration is loud rather than silently masked.
 *  2. Backend-driven default:
 *       - `google` / `google-claude` → `google-grounding`
 *       - `claude-api`               → `anthropic-server-tool`
 *       - `codex` / `openai-compat`  → `codex-server-tool`
 *       - `kiro`                     → keyless fallback chain (Brave
 *                                       if key configured, else Exa
 *                                       MCP, else DuckDuckGo HTML)
 *       - unknown backend            → keyless fallback chain
 *  3. If the backend-default adapter reports `isAvailable() === false`
 *     (e.g. user routed to `claude-api` but no key is mounted), the
 *     factory falls through to the keyless chain rather than failing
 *     up-front. This is the only "fall through" allowed and it is
 *     resolved at selection time, not at error time.
 *
 *  For posterity: the previous bridge implementation routed every
 *  backend without first-party search to Google grounding, which is
 *  why "Google quota exhausted" surfaces broke web_search across
 *  unrelated sessions. The new policy never silently borrows quota
 *  from a backend the agent did not opt into.
 */
@Injectable()
export class WebSearchAdapterFactory {
  private readonly logger = new Logger(WebSearchAdapterFactory.name)

  private readonly googleAdapter: GoogleGroundingAdapter
  private readonly anthropicAdapter: AnthropicServerToolAdapter
  private readonly codexAdapter: CodexServerToolAdapter
  private readonly braveAdapter: BraveLlmAdapter
  private readonly exaAdapter: ExaMcpAdapter
  private readonly duckduckgoAdapter: DuckDuckGoHtmlAdapter

  constructor(
    private readonly google: GoogleService,
    private readonly anthropic: AnthropicApiService,
    private readonly codex: CodexService
  ) {
    this.googleAdapter = new GoogleGroundingAdapter(this.google)
    this.anthropicAdapter = new AnthropicServerToolAdapter(this.anthropic)
    this.codexAdapter = new CodexServerToolAdapter(this.codex)
    this.braveAdapter = new BraveLlmAdapter()
    this.exaAdapter = new ExaMcpAdapter()
    this.duckduckgoAdapter = new DuckDuckGoHtmlAdapter()
  }

  /**
   * Resolve the single adapter that will serve every web_search call
   * on this session.
   *
   * @param backend — Active session's resolved BackendType. May be
   *                  `undefined` when the model router could not
   *                  resolve the session model; in that case we go
   *                  straight to the keyless chain.
   */
  selectAdapter(backend: BackendType | undefined): WebSearchAdapter {
    const override = parseEnvOverride()
    if (override) {
      const explicit = this.adapterByName(override)
      if (!explicit.isAvailable()) {
        throw new Error(
          `WEB_SEARCH_ADAPTER=${override} is set but the adapter is not ` +
            "available right now (missing credentials or upstream config)."
        )
      }
      this.logger.debug(`[web-search] using env override adapter: ${override}`)
      return explicit
    }

    const preferred = this.preferredAdapterForBackend(backend)
    if (preferred && preferred.isAvailable()) {
      this.logger.debug(
        `[web-search] backend=${backend ?? "(unresolved)"} → ${preferred.name}`
      )
      return preferred
    }

    if (preferred) {
      this.logger.warn(
        `[web-search] backend=${backend ?? "(unresolved)"} preferred=${preferred.name} ` +
          "is unavailable; falling through to keyless chain"
      )
    }

    return this.firstAvailableKeylessAdapter()
  }

  /**
   * Internal: map BackendType → first-party adapter, or `undefined`
   * if the backend has no first-party search surface. Backends that
   * historically relied on Google grounding as a "default" (Kiro,
   * generic openai-compat) intentionally return undefined here so
   * that the caller falls through to the keyless chain rather than
   * silently borrowing Google account quota.
   */
  private preferredAdapterForBackend(
    backend: BackendType | undefined
  ): WebSearchAdapter | undefined {
    switch (backend) {
      case "google":
      case "google-claude":
        return this.googleAdapter
      case "claude-api":
        return this.anthropicAdapter
      case "codex":
      case "openai-compat":
        return this.codexAdapter
      case "kiro":
        return undefined
      case undefined:
      default:
        return undefined
    }
  }

  /**
   * Walk the keyless chain in priority order and return the first
   * adapter that reports as available. The chain is:
   *
   *   1. `brave-llm`        — preferred when an API key is configured
   *                           (TOS-clean for agentic use)
   *   2. `exa-mcp`          — keyless, free, public MCP endpoint
   *   3. `duckduckgo-html`  — keyless HTML scrape, always available
   *
   * `duckduckgo-html.isAvailable()` always returns true, so this
   * function is total — it never throws "no adapter available".
   */
  private firstAvailableKeylessAdapter(): WebSearchAdapter {
    if (this.braveAdapter.isAvailable()) return this.braveAdapter
    if (this.exaAdapter.isAvailable()) return this.exaAdapter
    return this.duckduckgoAdapter
  }

  /**
   * Direct accessor used by env-override logic. Throws on unknown
   * names so the env handling stays exhaustive.
   */
  private adapterByName(name: WebSearchAdapterName): WebSearchAdapter {
    switch (name) {
      case "google-grounding":
        return this.googleAdapter
      case "anthropic-server-tool":
        return this.anthropicAdapter
      case "codex-server-tool":
        return this.codexAdapter
      case "exa-mcp":
        return this.exaAdapter
      case "brave-llm":
        return this.braveAdapter
      case "duckduckgo-html":
        return this.duckduckgoAdapter
    }
  }
}

const ADAPTER_NAMES: ReadonlySet<WebSearchAdapterName> = new Set([
  "google-grounding",
  "anthropic-server-tool",
  "codex-server-tool",
  "exa-mcp",
  "brave-llm",
  "duckduckgo-html",
])

function parseEnvOverride(): WebSearchAdapterName | undefined {
  const raw = process.env.WEB_SEARCH_ADAPTER
  if (!raw) return undefined
  const normalized = raw.trim()
  if (!normalized) return undefined
  if (ADAPTER_NAMES.has(normalized as WebSearchAdapterName)) {
    return normalized as WebSearchAdapterName
  }
  // Don't ignore typo'd overrides — log via the factory's NestJS
  // logger so the operator notices in startup logs. Keeping it on the
  // logger (rather than `console.warn`) plays nicely with the bridge
  // log routing and avoids a no-console lint exception.
  const logger = new Logger("WebSearchAdapterFactory")
  logger.warn(
    `WEB_SEARCH_ADAPTER="${raw}" is not a recognized adapter; ` +
      `valid: ${Array.from(ADAPTER_NAMES).join(", ")}. Falling back to default routing.`
  )
  return undefined
}
