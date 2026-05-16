/**
 * Backend-agnostic prompt-too-long error inspection.
 *
 * Different upstreams report context-length failures with different error
 * shapes: HTTP status (413), provider-specific status codes (Anthropic
 * 400 + `invalid_request_error`), or only a string message.  This
 * helper normalises detection to a single predicate so callers can
 * decide whether to invoke the reactive compaction path without
 * knowing each provider's wire format.
 */

export interface PromptTooLongDetection {
  /** Whether the error appears to be a prompt-too-long failure. */
  matched: boolean
  /** When the upstream surfaces actual prompt size, the parsed value. */
  actualTokens?: number
  /** When the upstream surfaces its hard cap, the parsed value. */
  maxTokens?: number
}

const PTL_KEYWORDS: ReadonlyArray<RegExp> = [
  /prompt[\s_]*is[\s_]*too[\s_]*long/i,
  /prompt[\s_]*too[\s_]*long/i,
  /context[\s_]*length[\s_]*exceeded/i,
  /maximum[\s_]*context[\s_]*length/i,
  /input[\s_]*tokens[\s_]*exceed/i,
  /input[\s_]*length[\s_]*exceeds/i,
  /reduce[\s_]*the[\s_]*length[\s_]*of[\s_]*the[\s_]*messages/i,
  /string too long/i,
  // Some providers respond with HTTP 413 + Payload Too Large
  /payload[\s_]*too[\s_]*large/i,
]

const TOKEN_PAIR_PATTERNS: ReadonlyArray<RegExp> = [
  /(\d+)\s*tokens?[^\d]+(?:max(?:imum)?|limit|cap)[^\d]+(\d+)/i,
  /(\d+)\s*tokens?\s*>\s*(\d+)/i,
  /input length[^\d]*(\d+)[^\d]+(?:max(?:imum)?|limit)[^\d]+(\d+)/i,
]

function extractMessageString(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (typeof error === "object") {
    const record = error as Record<string, unknown>
    const direct = typeof record.message === "string" ? record.message : ""
    const body =
      typeof record.body === "string"
        ? record.body
        : typeof record.responseBody === "string"
          ? record.responseBody
          : ""
    const wrapped =
      record.error && typeof record.error === "object"
        ? extractMessageString(record.error)
        : ""
    return [direct, body, wrapped].filter(Boolean).join("\n")
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return String(error)
  }
  return ""
}

function detectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  for (const key of [
    "status",
    "statusCode",
    "httpStatus",
    "code",
    "responseStatus",
  ]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return parseInt(value, 10)
    }
  }
  return undefined
}

/**
 * Inspect an error thrown by an upstream backend and decide whether it
 * represents a prompt-too-long failure.  Best-effort: providers without
 * a recognisable signature simply return `{ matched: false }`.
 */
export function detectPromptTooLong(error: unknown): PromptTooLongDetection {
  const messageBlob = extractMessageString(error)
  const status = detectStatusCode(error)
  const matchedByStatus = status === 413
  const matchedByMessage = PTL_KEYWORDS.some((pattern) =>
    pattern.test(messageBlob)
  )
  if (!matchedByStatus && !matchedByMessage) {
    return { matched: false }
  }

  let actualTokens: number | undefined
  let maxTokens: number | undefined
  for (const pattern of TOKEN_PAIR_PATTERNS) {
    const match = pattern.exec(messageBlob)
    if (!match) continue
    const a = match[1] ? parseInt(match[1], 10) : NaN
    const b = match[2] ? parseInt(match[2], 10) : NaN
    if (Number.isFinite(a) && Number.isFinite(b)) {
      actualTokens = a
      maxTokens = b
      break
    }
  }

  return { matched: true, actualTokens, maxTokens }
}
