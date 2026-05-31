import type { CodexInputItem } from "./codex-request-builder"

export interface CodexLastResponseSnapshot {
  responseId: string
  itemsAdded: CodexInputItem[]
}

export type CodexIncrementalInputResult =
  | { ok: true; input: CodexInputItem[] }
  | {
      ok: false
      reason: "static_fields_changed"
      changedStaticKeys: string[]
    }
  | {
      ok: false
      reason: "input_not_extension"
      inputMismatch: CodexInputMismatch
    }

export interface CodexInputMismatch {
  baselineLength: number
  requestLength: number
  mismatchIndex?: number
  baselineType?: string
  requestType?: string
}

const TRANSPORT_ONLY_REQUEST_FIELDS = new Set([
  "input",
  "previous_response_id",
  "generate",
  // Official Codex sends WebSocket client metadata separately from the
  // semantic ResponsesApiRequest compared by get_incremental_items().
  "client_metadata",
  // Cache identity affects transport/cache selection, not prompt semantics.
  "prompt_cache_key",
])

export function stripCodexRequestForIncrementalCompare(
  request: Record<string, unknown>
): Record<string, unknown> {
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request)) {
    if (TRANSPORT_ONLY_REQUEST_FIELDS.has(key)) {
      continue
    }
    stripped[key] = value
  }
  return stripped
}

export function stableCodexJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

export function codexRequestIncrementalSignature(
  request: Record<string, unknown>
): string {
  return stableCodexJsonStringify(
    stripCodexRequestForIncrementalCompare(request)
  )
}

export function getCodexIncrementalInput(
  request: Record<string, unknown>,
  previousRequest: Record<string, unknown>,
  lastResponse: CodexLastResponseSnapshot,
  allowEmptyDelta: boolean
): CodexIncrementalInputResult {
  const changedStaticKeys = diffCodexStaticRequestKeys(request, previousRequest)
  if (changedStaticKeys.length > 0) {
    return {
      ok: false,
      reason: "static_fields_changed",
      changedStaticKeys,
    }
  }

  const previousInput = getCodexInputItems(previousRequest)
  const requestInput = getCodexInputItems(request)
  const baseline = [...previousInput, ...lastResponse.itemsAdded]
  if (
    requestInput.length < baseline.length ||
    (!allowEmptyDelta && requestInput.length === baseline.length)
  ) {
    return {
      ok: false,
      reason: "input_not_extension",
      inputMismatch: {
        baselineLength: baseline.length,
        requestLength: requestInput.length,
      },
    }
  }

  for (let index = 0; index < baseline.length; index++) {
    if (
      stableCodexJsonStringify(requestInput[index]) !==
      stableCodexJsonStringify(baseline[index])
    ) {
      return {
        ok: false,
        reason: "input_not_extension",
        inputMismatch: {
          baselineLength: baseline.length,
          requestLength: requestInput.length,
          mismatchIndex: index,
          baselineType: getCodexInputItemType(baseline[index]),
          requestType: getCodexInputItemType(requestInput[index]),
        },
      }
    }
  }

  return { ok: true, input: requestInput.slice(baseline.length) }
}

function diffCodexStaticRequestKeys(
  request: Record<string, unknown>,
  previousRequest: Record<string, unknown>
): string[] {
  const current = stripCodexRequestForIncrementalCompare(request)
  const previous = stripCodexRequestForIncrementalCompare(previousRequest)
  const keys = new Set([...Object.keys(current), ...Object.keys(previous)])
  const changed: string[] = []
  for (const key of [...keys].sort()) {
    if (
      stableCodexJsonStringify(current[key]) !==
      stableCodexJsonStringify(previous[key])
    ) {
      changed.push(key)
    }
  }
  return changed
}

function getCodexInputItemType(item: CodexInputItem | undefined): string {
  const type =
    item && typeof (item as { type?: unknown }).type === "string"
      ? ((item as { type: string }).type || "").trim()
      : ""
  return type || "unknown"
}

function getCodexInputItems(
  request: Record<string, unknown>
): CodexInputItem[] {
  return Array.isArray(request.input) ? (request.input as CodexInputItem[]) : []
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJsonValue((value as Record<string, unknown>)[key])
  }
  return sorted
}
