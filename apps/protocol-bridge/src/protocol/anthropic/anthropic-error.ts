/**
 * Anthropic-compatible error envelope mapper.
 *
 * Real Claude Code CLI relies on `error.type` to drive its retry / backoff
 * behaviour: 429 must surface as `rate_limit_error`, 529 as
 * `overloaded_error`, etc.  Returning every failure as a generic
 * `api_error` causes CC CLI to treat retryable failures as permanent.
 *
 * Beyond `error.type`, CC CLI also matches on the `error.message` *prose*
 * for prompt-too-long detection (see services/api/errors.ts:564 in
 * claude-code: `error.message.toLowerCase().includes('prompt is too long')`)
 * and for the `N tokens > M maximum` parse used by reactive compact
 * (services/api/errors.ts:90). Upstream backends like Kiro emit
 * different prose ("Input is too long" / "Input content length exceeds
 * threshold"); transparently passing those messages through breaks CC
 * CLI's autoCompact / `/compact` recovery.
 *
 * Solution: render the envelope from the unified `BackendErrorClass`
 * taxonomy, not by parroting upstream wire prose. Each class has a
 * spec-compliant Anthropic-shaped (type, message) pair (see
 * backend-error-class.ts ANTHROPIC_ERROR_FOR_CLASS); when token counts
 * are known they're spliced into the message in the canonical
 * `prompt is too long: N tokens > M maximum` format. CC CLI's
 * detectors match unconditionally because the bridge produces
 * spec-compliant strings, not because anyone reverse-engineered them.
 */

import { HttpException } from "@nestjs/common"

import {
  BackendAccountPoolUnavailableError,
  BackendApiError,
} from "../../llm/shared/backend-errors"
import {
  ANTHROPIC_ERROR_FOR_CLASS,
  type BackendErrorClass,
  classifyBackendError,
  formatAnthropicMessage,
} from "../../llm/shared/backend-error-class"

export interface AnthropicErrorEnvelope {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export interface AnthropicErrorRendering {
  status: number
  body: AnthropicErrorEnvelope
  retryAfterSeconds?: number
}

/**
 * Map an HTTP status code to the canonical Anthropic API error
 * type, matching the Anthropic public spec and CLIProxyAPI's
 * `claudeErrorTypeFromStatus`.
 *
 * Used as a last-resort fallback when neither the producer nor the
 * structural classifier can decide a class. Class-driven rendering is
 * the primary path.
 */
export function claudeErrorTypeFromStatus(status: number): string {
  switch (status) {
    case 401:
      return "authentication_error"
    case 402:
      return "billing_error"
    case 403:
      return "permission_error"
    case 404:
      return "not_found_error"
    case 408:
      return "timeout_error"
    case 413:
      return "request_too_large"
    case 429:
      return "rate_limit_error"
    case 504:
      return "timeout_error"
    case 529:
      return "overloaded_error"
    default:
      if (status >= 500) {
        return "api_error"
      }
      return "invalid_request_error"
  }
}

/**
 * Render any error captured by the controller layer into the canonical
 * Anthropic envelope shape.  Used by both the non-streaming JSON
 * response and the SSE `event: error` writer so they stay in sync.
 *
 * Precedence:
 *   1. BackendErrorClass (producer-attached or structurally inferred)
 *      → spec-compliant message from ANTHROPIC_ERROR_FOR_CLASS, with
 *      token details spliced in for context_length_exceeded.
 *   2. HTTP-status-only fallback (claudeErrorTypeFromStatus + raw text)
 *      for paths that haven't been migrated to BackendErrorClass yet.
 */
export function renderAnthropicError(error: unknown): AnthropicErrorRendering {
  const cls = classifyBackendError(error)
  const status = inferStatus(error, cls)
  const retryAfterSeconds = extractRetryAfterSeconds(error)

  if (cls !== "unknown") {
    return {
      status: ANTHROPIC_ERROR_FOR_CLASS[cls].status,
      body: {
        type: "error",
        error: {
          type: ANTHROPIC_ERROR_FOR_CLASS[cls].type,
          message: formatAnthropicMessage({
            class: cls,
            actualTokens: extractActualTokens(error),
            maxTokens: extractMaxTokens(error),
            retryAfterSeconds,
          }),
        },
      },
      retryAfterSeconds,
    }
  }

  // Legacy / unclassified path: best-effort wire passthrough by status.
  const rawText = extractErrorText(error)
  return {
    status,
    body: {
      type: "error",
      error: {
        type: claudeErrorTypeFromStatus(status),
        message: rawText || defaultStatusMessage(status),
      },
    },
    retryAfterSeconds,
  }
}

function inferStatus(error: unknown, cls: BackendErrorClass): number {
  if (cls !== "unknown") return ANTHROPIC_ERROR_FOR_CLASS[cls].status

  if (error instanceof HttpException) {
    const code = error.getStatus()
    if (code > 0) return code
  }

  if (error instanceof BackendApiError) {
    if (typeof error.statusCode === "number" && error.statusCode > 0) {
      return error.statusCode
    }
  }

  if (error instanceof BackendAccountPoolUnavailableError) {
    return 503
  }

  const candidate =
    error && typeof error === "object"
      ? (error as { status?: unknown; statusCode?: unknown })
      : null
  if (candidate) {
    if (typeof candidate.status === "number" && candidate.status > 0) {
      return candidate.status
    }
    if (typeof candidate.statusCode === "number" && candidate.statusCode > 0) {
      return candidate.statusCode
    }
  }

  return 500
}

function extractActualTokens(error: unknown): number | undefined {
  if (error instanceof BackendApiError && error.actualTokens) {
    return error.actualTokens
  }
  return undefined
}

function extractMaxTokens(error: unknown): number | undefined {
  if (error instanceof BackendApiError && error.maxTokens) {
    return error.maxTokens
  }
  return undefined
}

function extractErrorText(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse()
    if (typeof response === "string") {
      return response
    }
    if (response && typeof response === "object") {
      const candidate = response as { message?: unknown; error?: unknown }
      if (typeof candidate.message === "string") {
        return candidate.message
      }
      try {
        return JSON.stringify(response)
      } catch {
        return error.message
      }
    }
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === "string") {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return ""
  }
}

function extractRetryAfterSeconds(error: unknown): number | undefined {
  const candidate = error as { retryAfterSeconds?: unknown } | null | undefined
  if (
    candidate &&
    typeof candidate.retryAfterSeconds === "number" &&
    candidate.retryAfterSeconds > 0
  ) {
    return candidate.retryAfterSeconds
  }
  return undefined
}

function defaultStatusMessage(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request"
    case 401:
      return "Unauthorized"
    case 402:
      return "Payment Required"
    case 403:
      return "Forbidden"
    case 404:
      return "Not Found"
    case 408:
      return "Request Timeout"
    case 413:
      return "Payload Too Large"
    case 429:
      return "Too Many Requests"
    case 500:
      return "Internal Server Error"
    case 502:
      return "Bad Gateway"
    case 503:
      return "Service Unavailable"
    case 504:
      return "Gateway Timeout"
    case 529:
      return "Overloaded"
    default:
      return `HTTP ${status}`
  }
}
