/**
 * Unified taxonomy for backend errors across all provider services.
 *
 * Why this exists:
 *
 * Each backend has its own error wire format:
 *   - Kiro:        HTTP 400 + JSON `{message, reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`
 *   - Anthropic:   HTTP 400 + `{error: {type: "invalid_request_error", message: "prompt is too long: N tokens > M maximum"}}`
 *   - OpenAI/Codex: HTTP 400 + `{error: {code: "context_length_exceeded", ...}}`
 *   - Google:      HTTP 400 + various message strings
 *
 * Without a unified enum, every retry / fallback / error-render decision
 * point ends up matching strings across these formats, which:
 *   1. Misses errors when an upstream rephrases its message (Kiro's
 *      "Input is too long" was missed by a regex tuned for Anthropic's
 *      "prompt is too long" — see services/api/errors.ts:564 in
 *      claude-code for the exact phrase CC CLI checks).
 *   2. Drifts silently when an upstream changes its wire shape.
 *   3. Distributes the wire knowledge across many call sites instead of
 *      keeping it where the wire shape is decoded.
 *
 * Design:
 *   - Each backend service owns a `classifyBackendError(status, body)`
 *     that reads its native wire shape (status code + structured fields,
 *     not message regex) and returns a BackendErrorClass.
 *   - Downstream decisions (retry policy, cross-backend fallback,
 *     Anthropic-envelope rendering) consume only the class — never the
 *     raw upstream message.
 *   - Adding a new backend means writing one classify function; the
 *     decision tables here apply unchanged.
 */

import type { BackendType } from "./model-router.service"

export type BackendErrorClass =
  /**
   * Request body or messages array exceeded the backend's input cap.
   * Caller should attempt cross-backend fallback (a larger-window
   * backend) or trigger reactive compaction; never simply retry the
   * same request on the same backend.
   */
  | "context_length_exceeded"
  /** HTTP 429 / quota exhausted / per-account cooldown. */
  | "rate_limited"
  /** 401 / 403 / token expired / account disabled. */
  | "auth_failed"
  /** Tool definition / JSON schema invalid; same payload always fails. */
  | "tool_schema_invalid"
  /** Other 4xx that are not recoverable on the same backend. */
  | "request_shape_invalid"
  /**
   * Network / DNS / socket / abort-by-supersede. Bridge-internal
   * recovery (re-warmup, retry on the same backend) is appropriate.
   */
  | "transient_network"
  /** 5xx upstream failure; retryable with backoff, then cross-backend. */
  | "transient_5xx"
  /**
   * Caller-initiated cancellation (AbortController). Never retried;
   * never falls back. Distinct from transient_network because the
   * abort is intentional.
   */
  | "client_aborted"
  /** Could not classify; default to safe (no retry, no fallback). */
  | "unknown"

export interface BackendErrorRetryPolicy {
  /**
   * Whether retrying the *same* (backend, request body) makes sense.
   * `false` for shape errors and PTL — the body would have to change
   * for a retry to succeed.
   */
  retryableSameRequest: boolean
  /**
   * Whether the same backend with a *different* account / endpoint is
   * worth trying. Account rotation only helps for credential-bound
   * failures (auth_failed, rate_limited per-account quota). PTL fails
   * on every account because the wire body is identical.
   */
  retryableDifferentAccount: boolean
  /**
   * Whether the model router should be invited to switch to a
   * different backend (kiro → claude-api / google-claude). The
   * router still applies its own model-class compatibility rules.
   */
  fallbackAcrossBackend: boolean
  /**
   * Default retry budget when `retryableSameRequest` is true. Caller
   * may apply additional caps (cooldown windows, per-account budgets).
   */
  maxRetries: number
}

/**
 * Decision table consumed by every retry / fallback decision point.
 * Single source of truth.
 */
export const RETRY_POLICY: Record<BackendErrorClass, BackendErrorRetryPolicy> =
  {
    context_length_exceeded: {
      retryableSameRequest: false,
      retryableDifferentAccount: false,
      fallbackAcrossBackend: true,
      maxRetries: 0,
    },
    rate_limited: {
      retryableSameRequest: false,
      retryableDifferentAccount: true,
      fallbackAcrossBackend: true,
      maxRetries: 3,
    },
    auth_failed: {
      retryableSameRequest: false,
      retryableDifferentAccount: true,
      fallbackAcrossBackend: true,
      maxRetries: 1,
    },
    tool_schema_invalid: {
      retryableSameRequest: false,
      retryableDifferentAccount: false,
      fallbackAcrossBackend: false,
      maxRetries: 0,
    },
    request_shape_invalid: {
      retryableSameRequest: false,
      retryableDifferentAccount: false,
      fallbackAcrossBackend: false,
      maxRetries: 0,
    },
    transient_network: {
      retryableSameRequest: true,
      retryableDifferentAccount: true,
      fallbackAcrossBackend: true,
      maxRetries: 2,
    },
    transient_5xx: {
      retryableSameRequest: true,
      retryableDifferentAccount: true,
      fallbackAcrossBackend: true,
      maxRetries: 2,
    },
    client_aborted: {
      retryableSameRequest: false,
      retryableDifferentAccount: false,
      fallbackAcrossBackend: false,
      maxRetries: 0,
    },
    unknown: {
      retryableSameRequest: false,
      retryableDifferentAccount: false,
      fallbackAcrossBackend: false,
      maxRetries: 0,
    },
  }

/**
 * Map a BackendErrorClass to the canonical Anthropic API error
 * `error.type` and a default human-readable message. The message is
 * spec-compliant (matches what real Anthropic returns) so client-side
 * detectors like CC CLI's `error.message.includes('prompt is too long')`
 * (services/api/errors.ts:564) match unconditionally.
 *
 * Concrete numeric details (actual / max tokens) are filled in by
 * `renderAnthropicError` from the `BackendErrorContext` extra fields.
 */
export const ANTHROPIC_ERROR_FOR_CLASS: Record<
  BackendErrorClass,
  { type: string; status: number; message: string }
> = {
  context_length_exceeded: {
    type: "invalid_request_error",
    status: 400,
    message: "prompt is too long",
  },
  rate_limited: {
    type: "rate_limit_error",
    status: 429,
    message: "rate limit exceeded",
  },
  auth_failed: {
    type: "authentication_error",
    status: 401,
    message: "authentication failed",
  },
  tool_schema_invalid: {
    type: "invalid_request_error",
    status: 400,
    message: "tool definition is invalid",
  },
  request_shape_invalid: {
    type: "invalid_request_error",
    status: 400,
    message: "request shape is invalid",
  },
  transient_network: {
    type: "api_error",
    status: 502,
    message: "upstream network error",
  },
  transient_5xx: {
    type: "api_error",
    status: 502,
    message: "upstream returned a server error",
  },
  client_aborted: {
    type: "request_canceled",
    status: 499,
    message: "request canceled by client",
  },
  unknown: {
    type: "api_error",
    status: 500,
    message: "internal upstream error",
  },
}

/**
 * Optional structured details a backend service can attach when
 * classifying an error, to be incorporated into the rendered Anthropic
 * envelope. Examples:
 *   - `{ class: "context_length_exceeded", actualTokens, maxTokens }`
 *     yields the canonical `prompt is too long: N tokens > M maximum`
 *     message that matches the regex CC CLI parses (errors.ts:90).
 *   - `{ class: "rate_limited", retryAfterSeconds }` populates the
 *     `retry-after` channel on the envelope.
 */
export interface BackendErrorContext {
  class: BackendErrorClass
  backend?: BackendType
  actualTokens?: number
  maxTokens?: number
  retryAfterSeconds?: number
  /** Original upstream message, for the diagnostic log only — not
   *  surfaced in the rendered envelope. */
  upstreamMessage?: string
}

/**
 * Build a spec-compliant Anthropic-style error message from a class
 * and optional context. Producing this in one place guarantees that
 * every rendering path (controller JSON path + SSE event:error path)
 * emits exactly the wording CC CLI's parsers expect.
 *
 * For PTL: matches errors.ts:90 in claude-code:
 *   /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i
 */
export function formatAnthropicMessage(ctx: BackendErrorContext): string {
  const base = ANTHROPIC_ERROR_FOR_CLASS[ctx.class].message
  switch (ctx.class) {
    case "context_length_exceeded": {
      if (ctx.actualTokens != null && ctx.maxTokens != null) {
        return `${base}: ${ctx.actualTokens} tokens > ${ctx.maxTokens} maximum`
      }
      if (ctx.maxTokens != null) {
        return `${base}: input exceeded ${ctx.maxTokens} maximum`
      }
      return base
    }
    case "rate_limited": {
      if (ctx.retryAfterSeconds != null) {
        return `${base}; retry after ${ctx.retryAfterSeconds}s`
      }
      return base
    }
    default:
      return base
  }
}

/**
 * Extract a BackendErrorClass from any error. Producer-attached
 * `errorClass` (BackendApiError.errorClass set by the backend service
 * that decoded the wire shape) is authoritative. When that's missing
 * we fall back to a structural inference using HTTP status + a small,
 * conservative set of cross-provider fingerprints — this is the only
 * place in the codebase that's allowed to look at error message text,
 * and even here it's a fallback when the producer didn't classify.
 */
export function classifyBackendError(error: unknown): BackendErrorClass {
  if (!error) return "unknown"

  // Producer-attached class wins. This is the path we want callers on.
  if (typeof error === "object") {
    const tagged = error as { errorClass?: BackendErrorClass }
    if (tagged.errorClass) return tagged.errorClass
  }

  // Abort flag (UpstreamRequestAbortedError or similar).
  if (typeof error === "object" && error !== null) {
    const e = error as {
      name?: string
      code?: string
      message?: string
      aborted?: boolean
    }
    if (e.aborted === true) return "client_aborted"
    if (e.name === "AbortError" || e.code === "ABORT_ERR") {
      return "client_aborted"
    }
  }

  const message = extractMessageString(error)
  const status = extractStatus(error)

  if (status === 413) return "context_length_exceeded"
  if (status === 429) return "rate_limited"
  if (status === 401 || status === 403) return "auth_failed"

  if (status === 400) {
    // Structural fingerprints (in priority order). These match
    // upstream-defined enum/code fields, NOT prose:
    //   - Kiro:        body.reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD"
    //   - OpenAI:      body.error.code === "context_length_exceeded"
    //   - Anthropic:   body.error.type === "invalid_request_error"
    //                  + body.error.message starts with "prompt is too long"
    //
    // These are upstream-API contracts, not message wording — they are
    // stable enums that don't drift when the prose changes.
    const reason = extractStructuredField(error, "reason")
    if (reason === "CONTENT_LENGTH_EXCEEDS_THRESHOLD") {
      return "context_length_exceeded"
    }
    const code = extractStructuredField(error, "code")
    if (code === "context_length_exceeded") return "context_length_exceeded"

    // Last-resort prose match for providers without a stable code.
    // Three patterns cover the documented variants observed in the
    // wild as of 2026-05; if a new wire shape lands, the fix is to
    // add an upstream-stable enum check above, not extend this regex.
    if (
      /prompt is too long|input is too long|input content length exceeds|exceeds threshold/i.test(
        message
      )
    ) {
      return "context_length_exceeded"
    }
    if (/tool|schema|validation/i.test(message)) {
      return "tool_schema_invalid"
    }
    return "request_shape_invalid"
  }

  if (status && status >= 500 && status < 600) return "transient_5xx"

  // Network / DNS / socket / fetch transport errors — no HTTP status.
  if (
    /timeout|timed out|fetch failed|socket hang up|econn|enotfound|eai_again|network/i.test(
      message
    )
  ) {
    return "transient_network"
  }

  return "unknown"
}

function extractMessageString(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (typeof error === "object") {
    const r = error as Record<string, unknown>
    const direct = typeof r.message === "string" ? r.message : ""
    const body =
      typeof r.body === "string"
        ? r.body
        : typeof r.responseBody === "string"
          ? r.responseBody
          : ""
    return [direct, body].filter(Boolean).join("\n")
  }
  return ""
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const r = error as Record<string, unknown>
  for (const k of ["statusCode", "status", "httpStatus", "responseStatus"]) {
    const v = r[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10)
  }
  return undefined
}

/**
 * Walk the upstream error body looking for a structured enum field.
 * The body may be:
 *   - a JSON string in `error.body` / `error.responseBody`
 *   - a parsed object on `error.body`
 *   - shaped `{error: {...}}` (Anthropic / OpenAI) or flat (Kiro)
 *
 * Returns the value of the named field if found at the top of the
 * body or under `body.error`, otherwise undefined. Caller compares
 * against the documented enum values.
 */
function extractStructuredField(
  error: unknown,
  fieldName: string
): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const r = error as Record<string, unknown>
  const candidates: unknown[] = []
  // Inline body field.
  candidates.push(r.body, r.responseBody, r.responseText)
  // The error itself may be shaped like the body.
  candidates.push(r)
  // Sometimes the message is JSON.
  if (typeof r.message === "string") {
    const trimmed = r.message.trim()
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        candidates.push(JSON.parse(trimmed))
      } catch {
        // ignore
      }
    } else {
      // Nested format: "Endpoint X HTTP 400: {...}" — pull the JSON out.
      const start = trimmed.indexOf("{")
      const end = trimmed.lastIndexOf("}")
      if (start >= 0 && end > start) {
        try {
          candidates.push(JSON.parse(trimmed.slice(start, end + 1)))
        } catch {
          // ignore
        }
      }
    }
  }

  for (const c of candidates) {
    if (!c || typeof c !== "object") continue
    const obj = c as Record<string, unknown>
    if (typeof obj[fieldName] === "string") return obj[fieldName]
    if (obj.error && typeof obj.error === "object") {
      const inner = obj.error as Record<string, unknown>
      if (typeof inner[fieldName] === "string") return inner[fieldName]
    }
  }
  return undefined
}
