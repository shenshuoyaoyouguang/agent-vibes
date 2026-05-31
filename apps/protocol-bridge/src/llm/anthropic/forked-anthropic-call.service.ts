import { Injectable, Logger } from "@nestjs/common"
import {
  AnthropicApiService,
  ClaudeApiClientMode,
} from "./anthropic-api.service"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import type { AnthropicForwardHeaders } from "./anthropic-api.service"
import type { AnthropicResponse } from "../../shared/anthropic"
import { KiroService } from "../aws/kiro.service"
import { GoogleService } from "../google/google.service"
import { CodexService } from "../openai/codex.service"
import { OpenaiCompatService } from "../openai/openai-compat.service"
import {
  ModelRouterService,
  type BackendType,
} from "../shared/model-router.service"

/**
 * Cache-safe params copied verbatim from the parent request. Kept in a
 * dedicated shape so callers cannot accidentally pass mutated fields:
 * the cache prefix the upstream sees on the fork must be byte-identical
 * to what the parent saw, otherwise prompt cache is invalidated.
 *
 * Mirror of cc's `runForkedAgent` cacheSafeParams contract:
 * claude-code/src/services/AgentSummary/agentSummary.ts.
 */
export interface ForkCacheSafeParams {
  model: string
  /** System prompt (string or array form). Cache_control already applied. */
  system: CreateMessageDto["system"]
  /** Tools schema array. Cache_control already applied. */
  tools?: CreateMessageDto["tools"]
  /** Sorted/deduped beta tokens captured at parent send time. */
  betas?: string[]
  /** Thinking config; preserved verbatim because it is part of the cache key. */
  thinking?: CreateMessageDto["thinking"]
  /** Output config (effort etc.); preserved verbatim. */
  output_config?: CreateMessageDto["output_config"]
  /** Service tier hint; preserved verbatim. */
  service_tier?: string
}

export interface ForkedCallParams {
  /**
   * Cache-safe parent snapshot. Required because the bridge does not
   * memoize a "last outbound shape" per SessionRecord — caller passes
   * what it just sent (or is about to send) to the parent.
   */
  cacheSafeParams: ForkCacheSafeParams
  /**
   * Messages to put on the wire. Typically: parent's projected message
   * prefix followed by a single new user prompt. Caller is responsible
   * for keeping the prefix identical to the parent's last outbound
   * messages so the upstream prompt cache hits.
   */
  promptMessages: CreateMessageDto["messages"]
  /** Tracking id reused for telemetry attribution. Parent SessionRecord.conversationId. */
  parentSessionId?: string
  /** Sub-agent context, if the fork is on behalf of a sub-agent. */
  agentId?: string
  /** Linked to the parent's AbortController so user cancellation propagates. */
  abortSignal?: AbortSignal
  /**
   * Hard ceiling on output tokens. Required by the Anthropic API; the
   * cache_key impact is documented in cc agentSummary.ts — keeping this
   * value fixed across forked calls is the caller's responsibility.
   */
  maxOutputTokens: number
  /**
   * Forwarded headers for the upstream request. Defaults to no extra
   * headers; usually fine because account-level headers carry auth.
   */
  forwardHeaders?: AnthropicForwardHeaders
  /** Optional override for the small-fast-model variant (haiku-class). */
  smallFastModel?: string
  /**
   * Backend that served the parent turn.  When provided, the fork is
   * dispatched to the same backend so users who only have one Claude-
   * serving backend configured (e.g. Kiro-only, no Anthropic API key)
   * still get a usable haiku route.  When omitted, the fork falls
   * through to Anthropic API — the historical default.
   *
   * Backends that cannot serve Claude haiku (`codex`, `openai-compat`)
   * cause the small-fast variant to short-circuit to `null` rather than
   * silently misroute to Claude API and fail when no Claude account is
   * configured.
   */
  parentBackend?: BackendType
}

export interface ForkedCallResult {
  /** Concatenated text from all assistant text blocks. */
  text: string
  /** Raw upstream response for callers that need block-level access. */
  raw: AnthropicResponse
}

/**
 * Helper that derives a one-shot Anthropic call from a parent request's
 * cache-safe shape. Used by ToolUseSummaryService and AgentSummaryService
 * to issue secondary LLM calls (short labels, periodic progress updates,
 * structured agent summaries) without busting the parent's prompt cache.
 *
 * Design parity:
 *   - cc `runForkedAgent` (claude-code/src/services/AgentSummary/agentSummary.ts):
 *     same cache-safe contract — system / tools / betas / thinking are
 *     copied verbatim from the parent, only `messages` and a fixed
 *     `max_tokens` differ.
 *   - cc `runQueryHaiku` (claude-code/src/services/api/queryHaiku.ts):
 *     same small-fast-model selection pattern; we expose it via
 *     `runForkedSmallFastCall`.
 *
 * Bridge-specific concerns:
 *   - The fork goes through `AnthropicApiService.sendClaudeMessage` so
 *     the existing cooldown/retry, oauth, rate-limit, and prompt-caching
 *     machinery are reused. The fork is therefore subject to the same
 *     account routing as the parent.
 *   - PromptCacheBreakDetection tracking is intentionally NOT propagated
 *     into the fork: forked calls have their own cache lifetime and
 *     would otherwise inject false-positive break events into the
 *     parent's tracking key.
 *   - Failures are surfaced as thrown errors. ToolUseSummary /
 *     AgentSummary callers wrap in try/catch and downgrade to null /
 *     legacy fallback so a fork failure never breaks the parent turn.
 */
@Injectable()
export class ForkedAnthropicCallService {
  private readonly logger = new Logger(ForkedAnthropicCallService.name)

  constructor(
    private readonly anthropicApi: AnthropicApiService,
    private readonly kiro: KiroService,
    private readonly google: GoogleService,
    private readonly codex: CodexService,
    private readonly openaiCompat: OpenaiCompatService,
    private readonly modelRouter: ModelRouterService
  ) {}

  /**
   * Run a one-shot Claude call using the parent's exact cache-safe
   * params.  The upstream prompt cache should hit on the system + tools
   * prefix as long as the caller passes the parent's projected message
   * history before the new prompt unchanged.
   *
   * Routes to whichever backend served the parent turn when
   * `parentBackend` is provided (Kiro, Google, Claude API).  When
   * absent, falls back to Claude API for backwards compatibility.
   *
   * Returns `null` when the parent backend cannot serve a Claude fork
   * (`codex` / `openai-compat`).  Callers are best-effort and should
   * treat null the same as a thrown error: skip the secondary call,
   * keep the parent turn going.
   */
  async runForkedCall(
    params: ForkedCallParams
  ): Promise<ForkedCallResult | null> {
    if (!this.canDispatchClaudeFork(params.parentBackend)) {
      return null
    }
    const dto = this.buildForkedDto(
      params.cacheSafeParams.model,
      params,
      params.forwardHeaders ? "generic" : "claude-code-cli"
    )
    const response = await this.dispatchClaudeFork(dto, params)
    return { text: this.extractText(response), raw: response }
  }

  /**
   * Same as `runForkedCall` but for the helper / "small-fast" slot.
   *
   * The model selection follows Cursor's `subagent_model_overrides`
   * three-state semantics:
   *
   *   - `smallFastModel` set:        a concrete pin from the
   *     subagent override map. Routed through ModelRouterService so
   *     non-Claude models (GPT-5.5, Gemini 3.x, Sonnet, ...) all
   *     dispatch to the right backend regardless of what served the
   *     parent.
   *   - `smallFastModel` undefined:  inherit-from-parent. The fork
   *     reuses the parent model verbatim and lands on the parent
   *     backend so the upstream prompt cache hits. This replaces the
   *     legacy hard-coded `claude-haiku-4-5` fallback that ignored the
   *     user's parent model selection.
   *
   * Returns `null` when the resolved backend cannot serve the fork
   * (e.g. parent ran on `codex` and the inherit branch tries to issue
   * a Claude DTO call on a GPT backend).  Callers — `ToolUseSummaryService`
   * — are best-effort and should treat null the same as a thrown error:
   * skip the helper, keep the parent turn.
   */
  async runForkedSmallFastCall(
    params: ForkedCallParams
  ): Promise<ForkedCallResult | null> {
    // Concrete pin path (user selected a specific model in the
    // settings UI). Route via ModelRouterService so we honour their
    // pick across families.
    if (params.smallFastModel) {
      const targetModel = params.smallFastModel
      let route: ReturnType<ModelRouterService["resolveModel"]>
      try {
        route = this.modelRouter.resolveModel(targetModel)
      } catch (error) {
        this.logger.debug(
          `[fork] Cannot route small-fast model ${targetModel}; ` +
            `dropping helper call: ${String(error)}`
        )
        return null
      }
      const dto = this.buildForkedDto(
        route.model,
        params,
        params.forwardHeaders ? "generic" : "claude-code-cli"
      )
      const response = await this.dispatchByBackend(route.backend, dto, params)
      if (!response) return null
      return { text: this.extractText(response), raw: response }
    }

    // Inherit-from-parent path: reuse parent model + parent backend.
    // Yields a true cache hit because the DTO model field, system
    // prefix, and tools all stay identical to the parent's last
    // outbound shape.
    if (!this.canDispatchClaudeFork(params.parentBackend)) {
      // Parent ran on codex / openai-compat (GPT family). The fork
      // shape is Anthropic-DTO-shaped and the cache-safe params come
      // from a Claude prefix, so we have no compatible inherit target.
      // Returning null lets the caller drop the helper silently —
      // matching the historical behaviour for that case.
      return null
    }
    const targetModel = params.cacheSafeParams.model
    const dto = this.buildForkedDto(
      targetModel,
      params,
      params.forwardHeaders ? "generic" : "claude-code-cli"
    )
    const response = await this.dispatchClaudeFork(dto, params)
    return { text: this.extractText(response), raw: response }
  }

  /**
   * Whether `parentBackend` (or the Anthropic-API default) can serve a
   * Claude-shaped fork at all.  Used by the inherit-from-parent path
   * of `runForkedSmallFastCall` and by `runForkedCall` (which always
   * sticks to the parent backend, since its purpose is reusing the
   * parent prompt cache).
   *
   * `codex` and `openai-compat` are excluded because their parents
   * speak GPT-family / generic OpenAI-compatible protocols.  Trying
   * to inherit a Claude DTO into them would synthesize a response
   * shape mismatch.
   */
  private canDispatchClaudeFork(backend: BackendType | undefined): boolean {
    switch (backend) {
      case undefined:
      case "claude-api":
      case "kiro":
      case "google-claude":
      case "google":
        return true
      case "codex":
      case "openai-compat":
        return false
      default: {
        // Exhaustiveness check: future BackendType additions force a
        // compile error here so we do not silently route forks to a new
        // backend that may not implement Claude haiku.
        const _exhaustive: never = backend
        void _exhaustive
        return false
      }
    }
  }

  private buildForkedDto(
    model: string,
    params: ForkedCallParams,
    clientMode: ClaudeApiClientMode
  ): CreateMessageDto {
    void clientMode
    const dto: CreateMessageDto = {
      model,
      messages: params.promptMessages,
      max_tokens: params.maxOutputTokens,
      system: params.cacheSafeParams.system,
      tools: params.cacheSafeParams.tools,
      thinking: params.cacheSafeParams.thinking,
      output_config: params.cacheSafeParams.output_config,
      service_tier: params.cacheSafeParams.service_tier,
      stream: false,
      betas: params.cacheSafeParams.betas,
    }
    return dto
  }

  /**
   * Inherit-from-parent dispatch path. `parentBackend` is the source
   * of truth — when omitted we use Claude API for backwards compat.
   *
   * Forks deliberately do NOT pass parent sessionId/agentId so that
   * their cache-read drops are not attributed to the parent's
   * PromptCacheBreakDetection key.
   */
  private async dispatchClaudeFork(
    dto: CreateMessageDto,
    params: ForkedCallParams
  ): Promise<AnthropicResponse> {
    const backend = params.parentBackend
    switch (backend) {
      case "kiro":
        return this.kiro.sendClaudeMessage(dto)
      case "google":
      case "google-claude":
        return this.google.sendClaudeMessage(dto)
      case "claude-api":
      case undefined:
        return this.anthropicApi.sendClaudeMessage(dto, {
          clientMode: "generic",
          forwardHeaders: params.forwardHeaders,
          abortSignal: params.abortSignal,
        })
      case "codex":
      case "openai-compat":
        // canDispatchClaudeFork() guards against this — both
        // runForkedCall and runForkedSmallFastCall short-circuit before
        // reaching the dispatcher.  Throwing keeps the contract
        // explicit instead of silently fanning out to Claude API.
        throw new Error(`Backend ${backend} cannot serve Claude fork calls`)
      default: {
        const _exhaustive: never = backend
        void _exhaustive
        throw new Error(
          `Unknown parent backend for fork dispatch: ${String(backend)}`
        )
      }
    }
  }

  /**
   * Pinned-model dispatch path. Used when the user's
   * `subagent_model_overrides` entry specifies a concrete model (which
   * may be from any family — Claude, GPT, Gemini). The backend is
   * decided by ModelRouterService rather than by the parent's
   * lastAssistantBackend.
   *
   * Returns `null` when the resolved backend cannot accept a Claude-
   * DTO-shaped helper call. In practice all six configured backends
   * implement `sendClaudeMessage`, so this is purely a guard against a
   * hypothetical future BackendType that doesn't.
   */
  private async dispatchByBackend(
    backend: BackendType,
    dto: CreateMessageDto,
    params: ForkedCallParams
  ): Promise<AnthropicResponse | null> {
    switch (backend) {
      case "kiro":
        return this.kiro.sendClaudeMessage(dto)
      case "google":
      case "google-claude":
        return this.google.sendClaudeMessage(dto)
      case "claude-api":
        return this.anthropicApi.sendClaudeMessage(dto, {
          clientMode: "generic",
          forwardHeaders: params.forwardHeaders,
          abortSignal: params.abortSignal,
        })
      case "codex":
        return this.codex.sendClaudeMessage(dto)
      case "openai-compat":
        return this.openaiCompat.sendClaudeMessage(dto)
      default: {
        const _exhaustive: never = backend
        void _exhaustive
        return null
      }
    }
  }

  private extractText(response: AnthropicResponse): string {
    const blocks = response?.content ?? []
    const out: string[] = []
    for (const block of blocks) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        out.push((block as { text: string }).text)
      }
    }
    return out.join("").trim()
  }
}
