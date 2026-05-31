import type { BackendType } from "./model-router.service"

/**
 * Backend-level capability matrix for thinking / reasoning continuity.
 *
 * Single source of truth for backend-specific behavior that previously lived
 * as scattered `if (route.backend === "kiro")` branches in:
 *   - cursor-connect-stream.service.ts:3729-3762 (shouldRequestThinkingSummary)
 *   - cursor-connect-stream.service.ts:3753-3762 (applyThinkingIntentToDto disabled)
 *   - kiro.service.ts:1614-1627                  (injectPreviousThinkingPreamble)
 *   - llm/aws/translator.ts:459-468             (drop thinking blocks)
 *   - llm/shared/normalize-for-api.ts:749-756   (stripSignatureBlocks dispatch)
 *
 * Adding a new backend now means adding one row here, not editing five files.
 *
 * `continuityStrategy` is the only field send-time logic should branch on:
 *   - native_signature: backend wire carries thinking blocks with signatures,
 *                       so prior assistant turns already replay reasoning
 *                       state losslessly. No bridge-side preamble needed.
 *   - text_preamble:    wire drops thinking; bridge injects a textual
 *                       `<previous_thinking>` preamble built from
 *                       ReasoningMemoryService.
 *   - none:             model has no reasoning channel; never store, never inject.
 */
export interface BackendCapability {
  /** Wire format carries `thinking` content blocks (Anthropic-shaped). */
  wireSupportsThinkingBlock: boolean
  /**
   * Wire format carries `signature` on thinking blocks. Required for true
   * cross-turn replay; without it, even a backend that accepts thinking
   * blocks on input would refuse to use them as state continuation.
   */
  wireSupportsSignature: boolean
  /**
   * Whether `thinking: { type: "disabled" }` actually suppresses the
   * pre-output reasoning pass on the wire. Kiro currently emits
   * `reasoningContentEvent` frames even when sent disabled; we surface that
   * here so callers don't rely on disabled as a latency optimization.
   * Track via `kiro.thinking.disabled_violation` telemetry to detect
   * upstream drift without code changes.
   */
  disabledIntentRespected: boolean
  /** Cross-turn reasoning continuity strategy. */
  continuityStrategy: "native_signature" | "text_preamble" | "none"
  /**
   * Effective input-token capacity of this backend.
   *
   * `maxInputTokens` is a *token-side* preflight ceiling. Set
   * uniformly to the model's nominal window so the preflight matches
   * what the client expects from the model. Backends that actually
   * reject on a different unit (e.g. Kiro rejects on JSON body size,
   * not token count) declare that via `maxWireBytes` and the wire-byte
   * gate stops oversized requests at the right boundary.
   *
   * `maxWireBytes` is the empirical, *byte-level* ceiling above which
   * the backend rejects with a context-length-exceeded class error.
   * Verified by `scripts/probe/probe-kiro-cap.mjs` for Kiro. Backends
   * without an observed byte limit leave this undefined.
   *
   * `advertisedToCC` is what CC CLI sees via `getContextWindowForModel`
   * (claude-code/src/utils/context.ts:56). When the bridge routes to a
   * backend with `advertisedToCC < maxInputTokens` of Anthropic's
   * default 200K, CC CLI's autoCompactThreshold would otherwise be set
   * for a window the bridge cannot honour, leading to wire-time PTL
   * errors. Surface the smaller window via the model-id alias channel
   * (see messages.controller.ts) so CC CLI's autoCompact triggers at
   * the right moment.
   */
  contextWindow: {
    maxInputTokens: number
    maxWireBytes?: number
    advertisedToCC: number
  }
}

/**
 * Anthropic's default context window in tokens. See
 * claude-code/src/utils/context.ts:10 — MODEL_CONTEXT_WINDOW_DEFAULT.
 */
const ANTHROPIC_DEFAULT_WINDOW = 200_000

/**
 * Empirical Kiro / CodeWhisperer wire-byte reject threshold for
 * claude-opus-4.7, verified by `scripts/probe/probe-kiro-cap.mjs` on
 * 2026-05-28 against `q.us-east-1.amazonaws.com/generateAssistantResponse`.
 *
 * The upstream returns
 *   HTTP 400 {"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}
 * when the JSON request body exceeds ~2.15 MB. The probe found:
 *   - PURE   (no tools, no history): lastPass 2,152,735 / firstFail 2,155,231
 *   - TOOLED (tool defs + history):  lastPass 2,151,124 / firstFail 2,154,244
 * The two scenarios agree within 0.1%, which means the wire reject is
 * driven by raw JSON body size — not by token count, and not by a
 * tools-vs-history split.
 *
 * The byte-side cap is kept ~25 KB below the smallest observed firstFail
 * to absorb encoding variance and SDK overhead.
 */
const KIRO_EFFECTIVE_WIRE_BYTES_CAP = 2_125_000

const NATIVE: Omit<BackendCapability, "contextWindow"> = {
  wireSupportsThinkingBlock: true,
  wireSupportsSignature: true,
  disabledIntentRespected: true,
  continuityStrategy: "native_signature",
}

const TEXT_PREAMBLE: Omit<
  BackendCapability,
  "disabledIntentRespected" | "contextWindow"
> = {
  wireSupportsThinkingBlock: false,
  wireSupportsSignature: false,
  continuityStrategy: "text_preamble",
}

export const BACKEND_CAPABILITY: Record<BackendType, BackendCapability> = {
  "claude-api": {
    ...NATIVE,
    contextWindow: {
      maxInputTokens: ANTHROPIC_DEFAULT_WINDOW,
      advertisedToCC: ANTHROPIC_DEFAULT_WINDOW,
    },
  },
  google: {
    ...NATIVE,
    contextWindow: {
      maxInputTokens: ANTHROPIC_DEFAULT_WINDOW,
      advertisedToCC: ANTHROPIC_DEFAULT_WINDOW,
    },
  },
  "google-claude": {
    ...NATIVE,
    contextWindow: {
      maxInputTokens: ANTHROPIC_DEFAULT_WINDOW,
      advertisedToCC: ANTHROPIC_DEFAULT_WINDOW,
    },
  },
  kiro: {
    ...TEXT_PREAMBLE,
    disabledIntentRespected: false,
    contextWindow: {
      // Kiro upstream advertises 1M for claude-opus-4.7 via
      // ListAvailableModels (`tokenLimits.maxInputTokens`). Respect
      // that — it's the upstream contract, not our heuristic. The
      // wire-byte ceiling below is a *separate* constraint and runs
      // as the second preflight gate.
      maxInputTokens: 1_000_000,
      maxWireBytes: KIRO_EFFECTIVE_WIRE_BYTES_CAP,
      // Advertise the Anthropic default (200K) to CC CLI so its
      // autoCompactThreshold lands somewhere reasonable. Going wider
      // here would let CC CLI accumulate history past the wire-byte
      // cap before its own compaction kicks in.
      advertisedToCC: ANTHROPIC_DEFAULT_WINDOW,
    },
  },
  codex: {
    ...TEXT_PREAMBLE,
    disabledIntentRespected: true,
    contextWindow: {
      maxInputTokens: ANTHROPIC_DEFAULT_WINDOW,
      advertisedToCC: ANTHROPIC_DEFAULT_WINDOW,
    },
  },
  "openai-compat": {
    wireSupportsThinkingBlock: false,
    wireSupportsSignature: false,
    disabledIntentRespected: true,
    continuityStrategy: "none",
    contextWindow: {
      maxInputTokens: ANTHROPIC_DEFAULT_WINDOW,
      advertisedToCC: ANTHROPIC_DEFAULT_WINDOW,
    },
  },
}

export function getBackendCapability(backend: BackendType): BackendCapability {
  return BACKEND_CAPABILITY[backend]
}
