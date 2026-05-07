import { fromBinary } from "@bufbuild/protobuf"
import * as fs from "fs"
import * as path from "path"

import {
  AgentClientMessage,
  AgentServerMessage,
  AgentServerMessageSchema,
  ToolCall,
} from "../../gen/agent/v1_pb"

type TraceDirection = "inbound" | "outbound"

interface TraceRecord {
  ts: string
  direction: TraceDirection
  messageType: "AgentClientMessage" | "AgentServerMessage"
  topCase?: string
  nestedCase?: string
  toolCase?: string
  callId?: string
  id?: number
  execId?: string
  toolCallId?: string
  modelCallId?: string
  bytes?: number
  compressedBytes?: number
  context?: string
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function extractToolCase(toolCall: ToolCall | undefined): string | undefined {
  return toolCall?.tool.case || undefined
}

function extractGenericToolCallId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return firstString(record.toolCallId, record.callId, record.id)
}

function summarizeClientMessage(
  msg: AgentClientMessage,
  meta?: { bytes?: number; compressedBytes?: number; context?: string }
): TraceRecord {
  const record: TraceRecord = {
    ts: new Date().toISOString(),
    direction: "inbound",
    messageType: "AgentClientMessage",
    topCase: msg.message.case || undefined,
    bytes: meta?.bytes,
    compressedBytes: meta?.compressedBytes,
    context: meta?.context,
  }

  switch (msg.message.case) {
    case "execClientMessage": {
      const value = msg.message.value
      record.nestedCase = value.message.case || undefined
      record.id = value.id
      record.execId = value.execId || undefined
      record.toolCallId = extractGenericToolCallId(value.message.value)
      break
    }
    case "execClientControlMessage": {
      const value = msg.message.value
      record.nestedCase = value.message.case || undefined
      record.id = firstNumber((value as unknown as Record<string, unknown>).id)
      record.execId = firstString(
        (value as unknown as Record<string, unknown>).execId
      )
      break
    }
    case "interactionResponse": {
      const value = msg.message.value
      record.nestedCase = value.result.case || undefined
      record.id = value.id
      break
    }
    case "conversationAction": {
      const action = msg.message.value.action
      record.nestedCase = action.case || undefined
      record.toolCallId = extractGenericToolCallId(action.value)
      break
    }
    default:
      break
  }

  return record
}

function summarizeServerMessage(
  msg: AgentServerMessage,
  meta?: { bytes?: number; context?: string }
): TraceRecord {
  const record: TraceRecord = {
    ts: new Date().toISOString(),
    direction: "outbound",
    messageType: "AgentServerMessage",
    topCase: msg.message.case || undefined,
    bytes: meta?.bytes,
    context: meta?.context,
  }

  switch (msg.message.case) {
    case "interactionUpdate": {
      const update = msg.message.value.message
      record.nestedCase = update.case || undefined
      const value = update.value as Record<string, unknown> | undefined
      record.callId = firstString(value?.callId)
      record.modelCallId = firstString(value?.modelCallId)
      record.toolCase = extractToolCase(value?.toolCall as ToolCall | undefined)
      if (!record.toolCase && value?.toolCallDelta) {
        const delta = value.toolCallDelta as { delta?: { case?: string } }
        record.toolCase = delta.delta?.case
      }
      break
    }
    case "interactionQuery": {
      const query = msg.message.value
      record.nestedCase = query.query.case || undefined
      record.id = query.id
      record.toolCallId = extractGenericToolCallId(query.query.value)
      break
    }
    case "execServerMessage": {
      const exec = msg.message.value
      record.nestedCase = exec.message.case || undefined
      record.id = exec.id
      record.execId = exec.execId || undefined
      record.toolCallId = extractGenericToolCallId(exec.message.value)
      break
    }
    case "execServerControlMessage": {
      const control = msg.message.value
      record.nestedCase = control.message.case || undefined
      break
    }
    default:
      break
  }

  return record
}

export class CursorProtocolTraceService {
  private static enabled(): boolean {
    const raw = process.env.CURSOR_PROTOCOL_TRACE
    if (raw === undefined || raw.trim() === "") return true
    return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase())
  }

  private static tracePath(): string {
    if (process.env.CURSOR_PROTOCOL_TRACE_FILE) {
      return path.resolve(process.env.CURSOR_PROTOCOL_TRACE_FILE)
    }
    if (process.env.AGENT_VIBES_LOG_DIR) {
      return path.resolve(
        process.env.AGENT_VIBES_LOG_DIR,
        "cursor_protocol_trace.jsonl"
      )
    }
    return path.resolve(process.cwd(), ".log/cursor_protocol_trace.jsonl")
  }

  private static append(record: TraceRecord): void {
    if (!this.enabled()) return
    try {
      const filePath = this.tracePath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
    } catch {
      // Tracing must never break protocol handling.
    }
  }

  static recordClientMessage(
    msg: AgentClientMessage,
    meta?: { bytes?: number; compressedBytes?: number; context?: string }
  ): void {
    this.append(summarizeClientMessage(msg, meta))
  }

  static recordServerMessage(
    msg: AgentServerMessage,
    meta?: { bytes?: number; context?: string }
  ): void {
    this.append(summarizeServerMessage(msg, meta))
  }

  static recordServerEnvelope(
    buffer: Uint8Array | Buffer,
    meta?: { context?: string }
  ): void {
    if (!this.enabled()) return
    try {
      const bytes = Buffer.from(buffer)
      const payload = bytes.length >= 5 ? bytes.subarray(5) : Buffer.from(bytes)
      const msg = fromBinary(AgentServerMessageSchema, payload)
      this.recordServerMessage(msg, {
        bytes: payload.length,
        context: meta?.context || "envelope",
      })
    } catch {
      // Ignore malformed trace-only decode failures.
    }
  }
}
