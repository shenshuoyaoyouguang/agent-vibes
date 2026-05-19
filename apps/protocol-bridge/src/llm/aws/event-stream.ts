/**
 * AWS binary Event Stream parser for Kiro responses.
 *
 * AWS encodes streaming generations as a sequence of binary frames:
 *   - 12-byte prelude (total_len, headers_len, prelude CRC)
 *   - headers section (name/value pairs)
 *   - JSON payload
 *   - trailing 4-byte CRC
 *
 * This parser intentionally skips CRC validation (matches the reference
 * Go implementation) and dispatches recognized event types via callbacks.
 */

import type {
  KiroCodeReference,
  KiroStreamCallback,
  KiroToolUse,
} from "./protocol-types"

interface ToolUseState {
  toolUseId: string
  name: string
  inputBuffer: string
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false })

/**
 * Parse a Node.js readable stream of AWS Event Stream frames and dispatch
 * recognized events to the provided callback bag.
 */
export async function parseKiroEventStream(
  body: ReadableStream<Uint8Array>,
  callback: KiroStreamCallback,
  abortSignal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  let pending = new Uint8Array(0)

  let inputTokens = 0
  let outputTokens = 0
  let totalCredits = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let currentToolUse: ToolUseState | null = null

  const append = (chunk: Uint8Array): void => {
    if (pending.length === 0) {
      // Copy into a fresh ArrayBuffer-backed view to keep the typed-array
      // generic compatible with concat / slice operations below.
      const copy = new Uint8Array(chunk.length)
      copy.set(chunk, 0)
      pending = copy
      return
    }
    const merged = new Uint8Array(pending.length + chunk.length)
    merged.set(pending, 0)
    merged.set(chunk, pending.length)
    pending = merged
  }

  try {
    while (true) {
      if (abortSignal?.aborted) {
        throw new Error("Kiro event stream aborted")
      }

      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value || value.length === 0) {
        continue
      }
      append(value)

      while (pending.length >= 12) {
        const totalLength =
          (pending[0]! << 24) |
          (pending[1]! << 16) |
          (pending[2]! << 8) |
          pending[3]!
        if (!Number.isFinite(totalLength) || totalLength < 16) {
          // Malformed frame — drop the prelude and continue.
          pending = pending.slice(12)
          continue
        }
        if (pending.length < totalLength) {
          // Wait for more bytes.
          break
        }

        const headersLength =
          (pending[4]! << 24) |
          (pending[5]! << 16) |
          (pending[6]! << 8) |
          pending[7]!

        const frame = pending.slice(0, totalLength)
        pending = pending.slice(totalLength)

        const remaining = totalLength - 12
        const msgBuf = frame.subarray(12, 12 + remaining)
        if (headersLength > msgBuf.length - 4) {
          continue
        }

        const eventType = extractEventType(msgBuf.subarray(0, headersLength))
        const payloadBytes = msgBuf.subarray(headersLength, msgBuf.length - 4)
        if (payloadBytes.length === 0) {
          continue
        }

        let event: Record<string, unknown>
        try {
          event = JSON.parse(TEXT_DECODER.decode(payloadBytes)) as Record<
            string,
            unknown
          >
        } catch {
          continue
        }

        ;[inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] =
          updateTokensFromEvent(
            event,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens
          )

        switch (eventType) {
          case "assistantResponseEvent": {
            const content = readString(event, "content")
            if (content && callback.onText) {
              // AWS CodeWhisperer streams text with HTML entities encoded
              // (&quot;, &apos;, &amp;, &lt;, &gt;, plus numeric forms).
              // The official Kiro client decodes per-chunk via unescape3()
              // before yielding to consumers — match that behavior exactly.
              // No dedup/overlap handling: each event is a clean delta.
              callback.onText(unescapeHtmlEntities(content), false)
            }
            break
          }
          case "reasoningContentEvent": {
            const text = readString(event, "text")
            if (text && callback.onText) {
              callback.onText(unescapeHtmlEntities(text), true)
            }
            break
          }
          case "toolUseEvent": {
            currentToolUse = handleToolUseEvent(event, currentToolUse, callback)
            break
          }
          case "meteringEvent": {
            const usage = readNumber(event, "usage")
            if (usage != null) {
              totalCredits += usage
            }
            break
          }
          case "metadataEvent":
          case "messageMetadataEvent": {
            // Diagnostic: surface the raw metadata payload so we can tell
            // whether the upstream is emitting cache counters at all.
            // Bedrock's `MetadataEvent` carries a `tokenUsage` sub-object
            // with `cacheReadInputTokens / cacheWriteInputTokens`; if the
            // dump shows the field but our `onCacheUsage` callback never
            // fires, parsing has a bug; if the field is absent, the
            // upstream is silently dropping our cachePoint markers.
            // eslint-disable-next-line no-console
            console.log(
              `[Kiro][diagnostic] ${eventType} payload:`,
              JSON.stringify(event)
            )
            break
          }
          case "contextUsageEvent": {
            const pct = readNumber(event, "contextUsagePercentage")
            if (pct != null && callback.onContextUsage) {
              callback.onContextUsage(pct)
            }
            break
          }
          case "codeReferenceEvent": {
            // License attribution metadata. Amazon Q Developer / Kiro must
            // display these to comply with the commercial reference-tracker
            // terms. The parser surfaces them via a callback; the proxy
            // layer decides how (or whether) to render them.
            const refs = extractCodeReferences(event)
            if (refs.length > 0 && callback.onCodeReferences) {
              callback.onCodeReferences(refs)
            }
            break
          }
          case "error":
          case "invalidStateEvent":
          case "internalServerException": {
            // In-band stream error frames. The official Kiro client lets
            // the AWS SDK throw these as typed exceptions; we don't get
            // SDK deserialization for free, so route them through onError
            // instead of silently dropping them.
            const message =
              readString(event, "message") ||
              readString(event, "reason") ||
              `Kiro stream emitted ${eventType}`
            const err = new Error(`[${eventType}] ${message}`)
            if (callback.onError) {
              callback.onError(err)
            }
            // Stop further parsing — once the upstream signals a stream
            // error, subsequent frames are unreliable.
            throw err
          }
          default: {
            // Diagnostic: surface unknown event types once per stream so
            // we can build an exhaustive map of what the upstream is
            // actually emitting.  Kiro's wire frames include `usage`
            // counters under `metadataEvent` per the Smithy schema, but
            // empirical observation shows they never arrive on
            // `q.us-east-1.amazonaws.com`; this dump tells us where they
            // really live (or confirms the upstream simply doesn't emit
            // them at all).
            const keys = Object.keys(event).slice(0, 16)
            // eslint-disable-next-line no-console
            console.log(
              `[Kiro][diagnostic] unknown event-type=${eventType} keys=[${keys.join(",")}] payload=${JSON.stringify(event).slice(0, 800)}`
            )
            break
          }
        }
      }
    }

    // Flush any tool_use that the upstream finished without a final
    // `stop: true` marker (rare, but happens on abrupt stream close).
    if (currentToolUse) {
      finishToolUse(currentToolUse, callback)
      currentToolUse = null
    }

    if (callback.onCredits && totalCredits > 0) {
      callback.onCredits(totalCredits)
    }
    if (
      callback.onCacheUsage &&
      (cacheReadTokens > 0 || cacheWriteTokens > 0)
    ) {
      callback.onCacheUsage(cacheReadTokens, cacheWriteTokens)
    }
    if (callback.onComplete) {
      callback.onComplete(inputTokens, outputTokens)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function readString(
  event: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = event[key]
  return typeof raw === "string" && raw.length > 0 ? raw : undefined
}

function readNumber(
  event: Record<string, unknown>,
  key: string
): number | undefined {
  const raw = event[key]
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function readTokenNumber(
  m: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    if (!(k in m)) continue
    const v = m[k]
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.trunc(v)
    }
    if (typeof v === "string") {
      const parsed = Number.parseFloat(v)
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed)
      }
    }
  }
  return undefined
}

function collectUsageMaps(
  value: unknown,
  out: Array<Record<string, unknown>>
): void {
  if (!value) return
  if (Array.isArray(value)) {
    for (const child of value) {
      collectUsageMaps(child, out)
    }
    return
  }
  if (typeof value !== "object") return

  const obj = value as Record<string, unknown>
  for (const [k, child] of Object.entries(obj)) {
    const lower = k.toLowerCase()
    if (
      (lower === "usage" ||
        lower === "tokenusage" ||
        lower === "token_usage") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      out.push(child as Record<string, unknown>)
    }
    collectUsageMaps(child, out)
  }
}

function updateTokensFromEvent(
  event: Record<string, unknown>,
  currentInputTokens: number,
  currentOutputTokens: number,
  currentCacheReadTokens: number = 0,
  currentCacheWriteTokens: number = 0
): [number, number, number, number] {
  const candidates: Array<Record<string, unknown>> = [event]
  collectUsageMaps(event, candidates)

  let inputTokens = currentInputTokens
  let outputTokens = currentOutputTokens
  let cacheReadTokens = currentCacheReadTokens
  let cacheWriteTokens = currentCacheWriteTokens

  for (const usage of candidates) {
    if (!usage) continue

    const out = readTokenNumber(
      usage,
      "outputTokens",
      "completionTokens",
      "totalOutputTokens",
      "output_tokens",
      "completion_tokens",
      "total_output_tokens"
    )
    if (out != null) {
      outputTokens = out
    }

    const inp = readTokenNumber(
      usage,
      "inputTokens",
      "promptTokens",
      "totalInputTokens",
      "input_tokens",
      "prompt_tokens",
      "total_input_tokens"
    )
    if (inp != null) {
      inputTokens = inp
      // Even when total inputTokens is reported directly, the upstream
      // may still attach cache counters in the same usage map; track
      // them so the proxy can surface real cache hits separately from
      // the client-side simulation.
      const cr = readTokenNumber(
        usage,
        "cacheReadInputTokens",
        "cache_read_input_tokens"
      )
      if (cr != null && cr > cacheReadTokens) {
        cacheReadTokens = cr
      }
      const cw = readTokenNumber(
        usage,
        "cacheWriteInputTokens",
        "cache_write_input_tokens",
        "cacheCreationInputTokens",
        "cache_creation_input_tokens"
      )
      if (cw != null && cw > cacheWriteTokens) {
        cacheWriteTokens = cw
      }
      continue
    }

    const uncached = readTokenNumber(
      usage,
      "uncachedInputTokens",
      "uncached_input_tokens"
    )
    const cacheRead = readTokenNumber(
      usage,
      "cacheReadInputTokens",
      "cache_read_input_tokens"
    )
    const cacheWrite = readTokenNumber(
      usage,
      "cacheWriteInputTokens",
      "cache_write_input_tokens",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens"
    )
    const sum = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    if (sum > 0) {
      inputTokens = sum
      if (cacheRead != null && cacheRead > cacheReadTokens) {
        cacheReadTokens = cacheRead
      }
      if (cacheWrite != null && cacheWrite > cacheWriteTokens) {
        cacheWriteTokens = cacheWrite
      }
      continue
    }

    const total = readTokenNumber(usage, "totalTokens", "total_tokens")
    if (total != null && total > 0) {
      let candidateOutput = outputTokens
      const candidateOut = readTokenNumber(
        usage,
        "outputTokens",
        "completionTokens",
        "totalOutputTokens",
        "output_tokens",
        "completion_tokens",
        "total_output_tokens"
      )
      if (candidateOut != null) {
        candidateOutput = candidateOut
      }
      if (total - candidateOutput > 0) {
        inputTokens = total - candidateOutput
      }
    }
  }

  return [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
}

/**
 * Decode the HTML entities that AWS CodeWhisperer's assistantResponseEvent /
 * reasoningContentEvent payloads use to escape quote-like characters.
 *
 * The set is intentionally identical to the official Kiro client's
 * `unescape3` (sourced from `html-escaper`):
 *   `&amp;` `&#38;` -> `&`
 *   `&lt;`  `&#60;` -> `<`
 *   `&gt;`  `&#62;` -> `>`
 *   `&apos;` `&#39;` -> `'`
 *   `&quot;` `&#34;` -> `"`
 *
 * Why this matters: when the model emits text containing `"` or `'`, the
 * upstream serializes them as HTML entities. Without decoding, downstream
 * markdown renderers see literal `&quot;` strings (or, worse, partial
 * entities split across stream-frame boundaries) and the output ends up
 * mis-formatted (e.g. unbalanced inline code).
 */
const HTML_ENTITY_RE = /&(?:amp|#38|lt|#60|gt|#62|apos|#39|quot|#34);/g
const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&#38;": "&",
  "&lt;": "<",
  "&#60;": "<",
  "&gt;": ">",
  "&#62;": ">",
  "&apos;": "'",
  "&#39;": "'",
  "&quot;": '"',
  "&#34;": '"',
}
function unescapeHtmlEntities(input: string): string {
  return input.replace(
    HTML_ENTITY_RE,
    (match) => HTML_ENTITY_MAP[match] ?? match
  )
}

function handleToolUseEvent(
  event: Record<string, unknown>,
  current: ToolUseState | null,
  callback: KiroStreamCallback
): ToolUseState | null {
  const toolUseId = readString(event, "toolUseId")
  const name = readString(event, "name")
  const isStop = event["stop"] === true

  // Open or rotate the current tool-use buffer when a new toolUseId arrives.
  // Per the official Kiro client, the FIRST chunk of a tool call carries
  // both `toolUseId` and `name`; subsequent chunks carry only `input` and
  // (optionally) `stop`. So we don't require `name` on every frame — only
  // when allocating a fresh buffer.
  if (toolUseId) {
    if (current === null) {
      current = { toolUseId, name: name ?? "", inputBuffer: "" }
    } else if (current.toolUseId !== toolUseId) {
      finishToolUse(current, callback)
      current = { toolUseId, name: name ?? "", inputBuffer: "" }
    } else if (name && !current.name) {
      // Edge case: id arrived first, name landed in a later frame.
      current.name = name
    }
  }

  if (current) {
    const input = event["input"]
    if (typeof input === "string") {
      current.inputBuffer += input
    } else if (input && typeof input === "object" && !Array.isArray(input)) {
      // Defensive only: the official wire format streams `input` as a string.
      try {
        current.inputBuffer = JSON.stringify(input)
      } catch {
        // ignore non-serializable input snapshot
      }
    }
  }

  if (isStop && current) {
    finishToolUse(current, callback)
    return null
  }

  return current
}

function finishToolUse(
  state: ToolUseState,
  callback: KiroStreamCallback
): void {
  let parsed: Record<string, unknown> | null = null
  if (state.inputBuffer.length > 0) {
    try {
      const candidate: unknown = JSON.parse(state.inputBuffer)
      if (
        candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
      ) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      parsed = null
    }
  }
  if (!parsed) parsed = {}

  if (!state.toolUseId || !state.name) {
    // Drop malformed tool calls instead of emitting a half-baked block.
    return
  }

  const tu: KiroToolUse = {
    toolUseId: state.toolUseId,
    name: state.name,
    input: parsed,
  }
  callback.onToolUse?.(tu)
}

/**
 * Extract `references` from a `codeReferenceEvent` payload.
 * Mirrors the shape `Be3` produces in the official client.
 */
function extractCodeReferences(
  event: Record<string, unknown>
): KiroCodeReference[] {
  const raw = event["references"]
  if (!Array.isArray(raw)) return []
  const refs: KiroCodeReference[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const ref: KiroCodeReference = {}
    if (typeof r.licenseName === "string") ref.licenseName = r.licenseName
    if (typeof r.repository === "string") ref.repository = r.repository
    if (typeof r.url === "string") ref.url = r.url
    if (typeof r.information === "string") ref.information = r.information
    const span = r.recommendationContentSpan
    if (span && typeof span === "object" && !Array.isArray(span)) {
      const s = span as Record<string, unknown>
      ref.recommendationContentSpan = {
        start: typeof s.start === "number" ? s.start : undefined,
        end: typeof s.end === "number" ? s.end : undefined,
      }
    }
    refs.push(ref)
  }
  return refs
}

/**
 * Read the `:event-type` value out of an AWS Event Stream header section.
 *
 * Header format per byte:
 *   nameLen(u8) | name(bytes) | valueType(u8) | value(...)
 * Recognized value types: 7 = string (u16 length + bytes); 6 = byte-buffer
 * (u16 length + bytes); 0/1 = bool; 2 = u8; 3 = u16; 4 = u32; 5 = u64;
 * 8 = timestamp (u64); 9 = uuid (16 bytes).
 */
function extractEventType(headers: Uint8Array): string {
  let offset = 0
  while (offset < headers.length) {
    if (offset >= headers.length) break
    const nameLen = headers[offset]!
    offset += 1
    if (offset + nameLen > headers.length) break
    const name = TEXT_DECODER.decode(headers.subarray(offset, offset + nameLen))
    offset += nameLen
    if (offset >= headers.length) break
    const valueType = headers[offset]!
    offset += 1

    if (valueType === 7) {
      if (offset + 2 > headers.length) break
      const valueLen = (headers[offset]! << 8) | headers[offset + 1]!
      offset += 2
      if (offset + valueLen > headers.length) break
      const value = TEXT_DECODER.decode(
        headers.subarray(offset, offset + valueLen)
      )
      offset += valueLen
      if (name === ":event-type") {
        return value
      }
      continue
    }

    if (valueType === 6) {
      if (offset + 2 > headers.length) break
      const len = (headers[offset]! << 8) | headers[offset + 1]!
      offset += 2 + len
      continue
    }

    const skipSizes: Record<number, number> = {
      0: 0,
      1: 0,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      8: 8,
      9: 16,
    }
    const skip = skipSizes[valueType]
    if (typeof skip !== "number") break
    offset += skip
  }
  return ""
}
