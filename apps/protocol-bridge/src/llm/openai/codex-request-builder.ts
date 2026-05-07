import {
  normalizeToolProtocolMessages,
  type LooseMessageContent,
} from "../../context"
import { sanitizeResponsesToolCallIntegrity } from "../shared/openai-tool-call-integrity"
import type { ThinkingIntent } from "../shared/thinking-types"
import { resolveCodexReasoningEffort } from "./codex-thinking"
import { buildShortNameMap, shortenNameIfNeeded } from "./tool-name-shortener"

export interface CodexConversationMessage {
  role: "user" | "assistant"
  content: LooseMessageContent
}

export interface CodexConversationTool {
  type?:
    | "function"
    | "custom"
    | "web_search"
    | "web_search_20250305"
    | "image_generation"
  name: string
  description: string
  input_schema?: Record<string, unknown>
  format?: Record<string, unknown>
  external_web_access?: boolean
  search_content_types?: string[]
  output_format?: string
}

export interface CodexSystemTextBlock {
  type?: string
  text?: string
}

export interface CodexExecutionRequest {
  model: string
  system?: string | CodexSystemTextBlock[]
  messages: CodexConversationMessage[]
  tools?: CodexConversationTool[]
  conversationId?: string
  pendingToolUseIds?: string[]
  thinkingIntent?: ThinkingIntent | null
  includeThinkingSummary?: boolean
  serviceTier?: string
  parallelToolCalls?: boolean
  cacheUserId?: string
  /**
   * @deprecated previous_response_id 现在由 CodexService.streamViaWebSocket() 在 transport 层自动注入，
   * 与 WebSocket 连接生命周期绑定。不再从外部传入。该字段不参与请求构建。
   * 保留字段声明以避免现有调用方的编译错误。
   */
  previousResponseId?: string
  clientMetadata?: Record<string, string>
  textVerbosity?: string
}

export interface CodexInputMessage {
  type: "message"
  role: string
  content: Array<Record<string, unknown>>
}

export interface CodexFunctionCall {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface CodexCustomToolCall {
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
}

export interface CodexFunctionCallOutput {
  type: "function_call_output"
  call_id: string
  output: string | Array<Record<string, unknown>>
}

export interface CodexCustomToolCallOutput {
  type: "custom_tool_call_output"
  call_id: string
  output: string
}

export type CodexInputItem =
  | CodexInputMessage
  | CodexFunctionCall
  | CodexCustomToolCall
  | CodexFunctionCallOutput
  | CodexCustomToolCallOutput

export interface CodexTool {
  type: "function" | "custom" | "web_search" | "image_generation"
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
  format?: Record<string, unknown>
  external_web_access?: boolean
  search_content_types?: string[]
  output_format?: string
}

export interface CodexRequest {
  model: string
  instructions: string
  input: CodexInputItem[]
  tools?: CodexTool[]
  tool_choice?: string | Record<string, unknown>
  stream: boolean
  store?: boolean
  parallel_tool_calls?: boolean
  reasoning?: { effort: string; summary?: string }
  include?: string[]
  previous_response_id?: string
  client_metadata?: Record<string, string>
  text?: { verbosity: string }
  generate?: boolean
  [key: string]: unknown
}

// 对齐官方 Codex CLI（client.rs:865-868）：
// Fast → "priority"，其他非空值直接透传
function normalizeCodexServiceTier(serviceTier?: string): string | undefined {
  const normalized = serviceTier?.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }
  if (normalized === "fast") {
    return "priority"
  }
  return normalized
}

const TOOL_SCHEMA_DOC_KEYS = new Set([
  "description",
  "title",
  "examples",
  "example",
  "default",
])

function compactToolSchemaForCodex(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactToolSchemaForCodex(item))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const compacted: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (TOOL_SCHEMA_DOC_KEYS.has(key)) {
      continue
    }
    compacted[key] = compactToolSchemaForCodex(nestedValue)
  }
  return compacted
}

function normalizeToolParameters(
  schema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} }
  }
  const result = { ...schema }
  if (!result.type) {
    result.type = "object"
  }
  if (result.type === "object" && !result.properties) {
    result.properties = {}
  }
  delete result.$schema
  return compactToolSchemaForCodex(result) as Record<string, unknown>
}

function buildToolNameShortener(
  tools: CodexConversationTool[] | undefined
): (name: string) => string {
  const toolNames: string[] = []
  if (tools) {
    for (const tool of tools) {
      if (tool.name) {
        toolNames.push(tool.name)
      }
    }
  }

  const shortMap =
    toolNames.length > 0
      ? buildShortNameMap(toolNames)
      : new Map<string, string>()

  return (name: string): string => {
    const short = shortMap.get(name)
    if (short) return short
    return shortenNameIfNeeded(name)
  }
}

function serializeCodexInstructions(
  system?: string | CodexSystemTextBlock[]
): string {
  if (typeof system === "string") {
    return system.trim()
  }

  if (!Array.isArray(system)) {
    return ""
  }

  return system
    .flatMap((block) => {
      if (block.type !== "text" || typeof block.text !== "string") {
        return []
      }
      if (block.text.startsWith("x-anthropic-billing-header: ")) {
        return []
      }
      const text = block.text.trim()
      return text ? [text] : []
    })
    .join("\n\n")
}

function buildToolTypeLookup(
  tools: CodexConversationTool[] | undefined
): Map<string, CodexConversationTool["type"]> {
  const lookup = new Map<string, CodexConversationTool["type"]>()
  if (!tools) {
    return lookup
  }

  for (const tool of tools) {
    if (!tool?.name) continue
    lookup.set(tool.name, tool.type)
  }

  return lookup
}

function serializeCustomToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    for (const key of ["patch", "input", "content", "text"]) {
      const value = record[key]
      if (typeof value === "string") {
        return value
      }
    }
  }

  return JSON.stringify(input ?? {})
}

function serializeCustomToolOutput(
  output: string | Array<Record<string, unknown>>
): string {
  if (typeof output === "string") {
    return output
  }

  const parts: string[] = []
  for (const part of output) {
    if (part.type === "input_text" && typeof part.text === "string") {
      parts.push(part.text)
    }
  }

  if (parts.length > 0) {
    return parts.join("\n")
  }

  return JSON.stringify(output)
}

function normalizeToolCallTypeHint(
  value: unknown
): "function" | "custom" | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === "custom") {
    return "custom"
  }
  if (normalized === "function") {
    return "function"
  }
  return undefined
}

export function buildCodexRequest(
  request: CodexExecutionRequest,
  modelName: string = request.model
): CodexRequest {
  const shortenName = buildToolNameShortener(request.tools)
  const toolTypeByName = buildToolTypeLookup(request.tools)
  const toolCallTypeById = new Map<string, "function" | "custom">()
  let input: CodexInputItem[] = []
  const instructions = serializeCodexInstructions(request.system)

  const protocolNormalized = normalizeToolProtocolMessages(
    request.messages as Array<{
      role: "user" | "assistant"
      content: unknown
    }>,
    { pendingToolUseIds: request.pendingToolUseIds }
  )

  for (const msg of protocolNormalized.messages) {
    const role = msg.role
    const messageContent: Array<Record<string, unknown>> = []
    let hasContent = false

    const flushMessage = () => {
      if (!hasContent) {
        return
      }
      input.push({
        type: "message",
        role,
        content: [...messageContent],
      })
      messageContent.length = 0
      hasContent = false
    }

    const appendTextContent = (text: string) => {
      const partType = role === "assistant" ? "output_text" : "input_text"
      messageContent.push({ type: partType, text })
      hasContent = true
    }

    const appendImageContent = (dataURL: string) => {
      messageContent.push({ type: "input_image", image_url: dataURL })
      hasContent = true
    }

    if (typeof msg.content === "string") {
      if (msg.content) {
        appendTextContent(msg.content)
      }
      flushMessage()
      continue
    }

    if (!Array.isArray(msg.content)) {
      continue
    }

    const blocks = msg.content as Array<{
      type?: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?:
        | string
        | Array<{
            type: string
            text?: string
            source?: Record<string, unknown>
          }>
      source?: {
        data?: string
        base64?: string
        media_type?: string
        mime_type?: string
      }
    }>

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          if (block.text) {
            appendTextContent(block.text)
          }
          break

        case "image": {
          const source = block.source
          if (!source) {
            break
          }
          const data = source.data || source.base64
          if (!data) {
            break
          }
          const mediaType =
            source.media_type || source.mime_type || "application/octet-stream"
          appendImageContent(`data:${mediaType};base64,${data}`)
          break
        }

        case "tool_use":
          flushMessage()
          {
            const originalName = block.name || ""
            const shortName = shortenName(originalName)
            const toolType =
              toolTypeByName.get(originalName) ||
              normalizeToolCallTypeHint(
                (block as Record<string, unknown>).tool_call_type
              )
            const callId = block.id || ""

            if (toolType === "custom") {
              input.push({
                type: "custom_tool_call",
                call_id: callId,
                name: shortName,
                input: serializeCustomToolInput(block.input),
              })
              toolCallTypeById.set(callId, "custom")
            } else {
              input.push({
                type: "function_call",
                call_id: callId,
                name: shortName,
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input || {}),
              })
              toolCallTypeById.set(callId, "function")
            }
          }
          break

        case "tool_result": {
          flushMessage()

          let output: string | Array<Record<string, unknown>> = ""
          if (typeof block.content === "string") {
            output = block.content
          } else if (Array.isArray(block.content)) {
            const parts: Array<Record<string, unknown>> = []
            for (const part of block.content) {
              if (part.type === "text" && part.text) {
                parts.push({ type: "input_text", text: part.text })
                continue
              }
              if (part.type === "image" && part.source) {
                const src = part.source as {
                  data?: string
                  base64?: string
                  media_type?: string
                  mime_type?: string
                }
                const imgData = src.data || src.base64
                if (!imgData) {
                  continue
                }
                const mediaType =
                  src.media_type || src.mime_type || "application/octet-stream"
                const detail =
                  typeof (part as { detail?: unknown }).detail === "string"
                    ? ((part as { detail?: string }).detail as string)
                    : undefined
                parts.push({
                  type: "input_image",
                  image_url: `data:${mediaType};base64,${imgData}`,
                  ...(detail ? { detail } : {}),
                })
              }
            }
            output = parts.length > 0 ? parts : ""
          }

          const callId = block.tool_use_id || ""
          const callType =
            toolCallTypeById.get(callId) ||
            normalizeToolCallTypeHint(
              (block as Record<string, unknown>).tool_call_type
            )
          if (callType === "custom") {
            input.push({
              type: "custom_tool_call_output",
              call_id: callId,
              output: serializeCustomToolOutput(output),
            })
          } else {
            input.push({
              type: "function_call_output",
              call_id: callId,
              output,
            })
          }
          break
        }

        default:
          if (block.text) {
            appendTextContent(block.text)
          }
          break
      }
    }

    flushMessage()
  }

  input = sanitizeResponsesToolCallIntegrity(
    input,
    request.pendingToolUseIds
  ).items

  let codexTools: CodexTool[] | undefined
  if (request.tools && request.tools.length > 0) {
    codexTools = []
    for (const tool of request.tools) {
      if (tool.type === "web_search_20250305" || tool.type === "web_search") {
        codexTools.push({
          type: "web_search",
          ...(typeof tool.external_web_access === "boolean"
            ? { external_web_access: tool.external_web_access }
            : {}),
          ...(Array.isArray(tool.search_content_types)
            ? { search_content_types: tool.search_content_types }
            : {}),
        })
        continue
      }

      if (tool.type === "custom") {
        codexTools.push({
          type: "custom",
          name: shortenName(tool.name || ""),
          description: tool.description,
          format: tool.format,
        })
        continue
      }

      if (tool.type === "image_generation") {
        codexTools.push({
          type: "image_generation",
          output_format: tool.output_format || "png",
        })
        continue
      }

      codexTools.push({
        type: "function",
        name: shortenName(tool.name || ""),
        description: tool.description,
        parameters: normalizeToolParameters(tool.input_schema),
        strict: false,
      })
    }
  }

  const serviceTier = normalizeCodexServiceTier(request.serviceTier)
  const reasoning: CodexRequest["reasoning"] = {
    effort: resolveCodexReasoningEffort(request.thinkingIntent, modelName),
  }
  if (request.includeThinkingSummary) {
    reasoning.summary = "auto"
  }

  const codexRequest: CodexRequest = {
    model: modelName,
    instructions,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: request.parallelToolCalls !== false,
    reasoning,
    include: ["reasoning.encrypted_content"],
    text: { verbosity: request.textVerbosity?.trim() || "low" },
  }

  if (serviceTier) {
    codexRequest.service_tier = serviceTier
  }

  if (codexTools && codexTools.length > 0) {
    codexRequest.tools = codexTools
    codexRequest.tool_choice = "auto"
  }

  const clientMetadata = request.clientMetadata
  if (clientMetadata && Object.keys(clientMetadata).length > 0) {
    codexRequest.client_metadata = clientMetadata
  }

  // previous_response_id 现在由 CodexService.streamViaWebSocket() 在 transport 层自动注入，
  // 与 WebSocket 连接生命周期绑定。不再从外部传入。
  // 对标官方 prepare_websocket_request() 设计。

  return codexRequest
}

/**
 * 从完整的 CodexRequest 中提取 warmup-only payload。
 * 只保留 model + instructions + tools + reasoning + include + text 等静态配置，
 * 去掉 input messages 和 previous_response_id，用于 generate:false 的 prompt cache 预热。
 *
 * 对齐官方 Codex CLI（session_startup_prewarm.rs:216-223）：
 *   build_prompt(Vec::new(), ...) — 使用空的 input items 构建 warmup prompt。
 */
export function extractWarmupPayload(
  codexRequest: CodexRequest
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: codexRequest.model,
    instructions: codexRequest.instructions,
    input: [],
    stream: true,
    store: codexRequest.store,
    parallel_tool_calls: codexRequest.parallel_tool_calls,
    reasoning: codexRequest.reasoning,
    include: codexRequest.include,
  }

  if (codexRequest.text) {
    payload.text = codexRequest.text
  }
  if (codexRequest.tools && codexRequest.tools.length > 0) {
    payload.tools = codexRequest.tools
    payload.tool_choice = codexRequest.tool_choice
  }
  if (codexRequest.service_tier) {
    payload.service_tier = codexRequest.service_tier
  }
  if (codexRequest.client_metadata) {
    payload.client_metadata = codexRequest.client_metadata
  }

  return payload
}
