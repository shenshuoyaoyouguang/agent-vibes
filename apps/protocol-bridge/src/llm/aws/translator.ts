/**
 * Translates Claude/Anthropic API requests into Kiro's
 * `generateAssistantResponse` payload shape.
 *
 * Reference: https://github.com/Quorinex/Kiro-Go (proxy/translator.go)
 * Verified against captured Kiro IDE 0.12.200 traffic
 * (scripts/capture/kiro_traffic.log) — see the wire-shape comments below.
 *
 * The translator is intentionally pure (no I/O, no network) so it can be
 * unit-tested cheaply.
 */

import { randomUUID } from "crypto"
import type { CreateMessageDto } from "../../protocol/anthropic/dto/create-message.dto"
import { appendLanguageDirectiveToText } from "../shared/language-directive"
import type {
  KiroAdditionalModelRequestFields,
  KiroHistoryMessage,
  KiroImage,
  KiroPayload,
  KiroToolResult,
  KiroToolUse,
  KiroToolWrapper,
  KiroUserInputMessage,
  KiroUserInputMessageContext,
} from "./protocol-types"

// ── Model name mapping (long key first to avoid prefix collisions) ──
type ModelMappingPair = readonly [pattern: string, target: string]
const MODEL_MAP_ORDERED: readonly ModelMappingPair[] = [
  ["claude-sonnet-4-20250514", "claude-sonnet-4"],
  ["claude-sonnet-4-5", "claude-sonnet-4.5"],
  ["claude-sonnet-4.5", "claude-sonnet-4.5"],
  ["claude-sonnet-4-6", "claude-sonnet-4.6"],
  ["claude-sonnet-4.6", "claude-sonnet-4.6"],
  ["claude-opus-4-8", "claude-opus-4.8"],
  ["claude-opus-4.8", "claude-opus-4.8"],
  ["claude-opus-4-7", "claude-opus-4.7"],
  ["claude-opus-4.7", "claude-opus-4.7"],
  ["claude-haiku-4-5", "claude-haiku-4.5"],
  ["claude-haiku-4.5", "claude-haiku-4.5"],
  ["claude-opus-4-5", "claude-opus-4.5"],
  ["claude-opus-4.5", "claude-opus-4.5"],
  ["claude-opus-4-6", "claude-opus-4.6"],
  ["claude-opus-4.6", "claude-opus-4.6"],
  ["claude-sonnet-4", "claude-sonnet-4"],
  ["claude-3-5-sonnet", "claude-sonnet-4.5"],
  ["claude-3-opus", "claude-sonnet-4.5"],
  ["claude-3-sonnet", "claude-sonnet-4"],
  ["claude-3-haiku", "claude-haiku-4.5"],
] as const

const MAX_TOOL_DESCRIPTION_LENGTH = 10_237
const MAX_TOOL_NAME_LENGTH = 64
const MINIMAL_FALLBACK_USER_CONTENT = "."

export interface ClaudeToKiroOptions {
  /**
   * Per-request thinking behavior to surface as
   * `userInputMessage.additionalModelRequestFields.thinking`.
   *
   * When omitted, the translator does not write the field at all and the
   * Kiro backend uses its model default (Opus 4.7 default ≈ `adaptive` +
   * `summarized`, which adds 5–40s of `reasoningContentEvent` frames before
   * any tool/assistant output even on trivial continuations).
   *
   * Set explicitly to `{ type: "disabled", display: "omitted" }` to skip
   * extended thinking entirely. Verified accepted by the live endpoint.
   */
  thinking?: KiroAdditionalModelRequestFields["thinking"]
  /** Optional effort override surfaced as `output_config.effort`. */
  effort?: KiroAdditionalModelRequestFields["output_config"] extends infer T
    ? T extends { effort?: infer E }
      ? E
      : never
    : never
  /** Override the agent continuation id (otherwise random UUID v4). */
  agentContinuationId?: string
  /** Override the conversation id (otherwise random UUID v4). */
  conversationId?: string
  /** Pre-resolved Kiro profile ARN, if known. */
  profileArn?: string
  /**
   * Whether this request is an agent-mode (tool-using) call.
   *
   * The official Kiro client only adds `agentTaskType` and
   * `agentContinuationId` in agent-mode payloads; its plain `_streamChat`
   * path omits them entirely. Mirroring that behavior keeps prompt-cache
   * keys aligned with the upstream and avoids drift between simple chat
   * and agent payloads.
   *
   * If `undefined`, the translator infers agent mode from the presence of
   * tools in the dto.
   */
  agentMode?: boolean
}

export function mapKiroModel(model: string): string {
  const lower = model.trim().toLowerCase()
  for (const [pattern, target] of MODEL_MAP_ORDERED) {
    if (lower.includes(pattern)) {
      return target
    }
  }
  if (lower.startsWith("claude-")) {
    return model.trim()
  }
  return model.trim()
}

/**
 * Translate a Claude `CreateMessageDto` to a Kiro payload.
 *
 * Wire shape (verified against captured KiroIDE 0.12.200 traffic):
 *   {
 *     conversationState: {
 *       chatTriggerType: "MANUAL",
 *       conversationId,
 *       agentContinuationId,
 *       agentTaskType: "vibe",
 *       currentMessage: {
 *         userInputMessage: { content, modelId, origin: "AI_EDITOR",
 *                             userInputMessageContext? }
 *       },
 *       history?: KiroHistoryMessage[]
 *     },
 *     profileArn?: string
 *   }
 *
 * Notes:
 *   - currentMessage.userInputMessage 同时带 origin 和 modelId（与抓包一致）。
 *   - 当本轮仅传 tool_result 时，content 必须为空字符串 ""，
 *     不要把 tool_result 文本拼回 content。
 *   - chatTriggerType 固定 "MANUAL"，conversationId 必填（caller 复用同一个）。
 *   - 不发 inferenceConfig（抓包里顶层只有 conversationState + profileArn）。
 *   - 工具名按原样透传，不做 camelCase 转换；只在长度超限时截断。
 */
export function claudeToKiro(
  dto: CreateMessageDto,
  options: ClaudeToKiroOptions = {}
): KiroPayload {
  const modelId = mapKiroModel(dto.model || "")
  const origin = "AI_EDITOR"

  const systemPrompt = appendLanguageDirectiveToText(
    extractSystemPromptText(dto.system),
    dto.messages
  )
  const history: KiroHistoryMessage[] = []
  let currentContent = ""
  let currentImages: KiroImage[] = []
  let currentToolResults: KiroToolResult[] = []

  const messages = dto.messages || []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const isLast = i === messages.length - 1

    if (msg.role === "user") {
      const extracted = extractClaudeUserContent(msg.content)
      const content = normalizeUserContent(
        extracted.text,
        extracted.images.length > 0,
        extracted.toolResults.length > 0
      )

      if (isLast) {
        currentContent = content
        currentImages = extracted.images
        currentToolResults = extracted.toolResults
      } else {
        // history 里的 userInputMessage 才带 origin/modelId（与抓包一致）。
        const userMsg: KiroUserInputMessage = {
          content,
          modelId,
          origin,
        }
        if (extracted.images.length > 0) {
          userMsg.images = extracted.images
        }
        if (extracted.toolResults.length > 0) {
          userMsg.userInputMessageContext = {
            toolResults: extracted.toolResults,
          }
        }
        history.push({ userInputMessage: userMsg })
      }
    } else if (msg.role === "assistant") {
      const extracted = extractClaudeAssistantContent(msg.content)
      // 历史里 assistant 的 toolUses 名称原样透传（不再 camelCase 改写）。
      // Kiro 后端从抓包看接受下划线工具名（execute_bash / str_replace 等）。
      const truncatedToolUses = extracted.toolUses.map((tu) => ({
        ...tu,
        name: enforceToolNameLength(tu.name),
      }))
      history.push({
        assistantResponseMessage: {
          content: extracted.text,
          ...(truncatedToolUses.length > 0
            ? { toolUses: truncatedToolUses }
            : {}),
        },
      })
    }
  }

  // Drop / repair protocol-invalid history before Kiro schema validation.
  // Kiro is stricter than Anthropic here: a history toolResult must belong to
  // the immediately preceding assistant toolUse, and history cannot start with
  // orphaned toolResults from a truncated transcript.
  const trimmedHistory = sanitizeKiroHistoryToolAdjacency(
    trimLeadingAssistantHistory(history)
  )
  // Kiro requires every history assistant `toolUses` to be answered. The
  // adjacency pass covers assistant→user pairs *inside* history; when history
  // ends on an assistant that still has open toolUses (e.g. a
  // background-shell continuation whose tool_result never came back), those
  // ids must be answered by the current message's toolResults instead — this
  // is the same shape Kiro emits for a normal tool continuation. Backfill any
  // ids the real current toolResults do not already cover.
  const safeCurrentToolResults = backfillTrailingAssistantToolResults(
    sanitizeCurrentToolResultsForHistory(currentToolResults, trimmedHistory),
    trimmedHistory
  )

  // currentMessage.content 拼装：
  //   - 文本消息：(可选 SYSTEM PROMPT) + 用户文本
  //   - 仅 tool_result：留空字符串 ""（关键修正，参考抓包）
  //   - 仅 image：图片占位说明
  //   - 其它：占位 "."
  let finalContent: string
  if (safeCurrentToolResults.length > 0 && !currentContent) {
    // 仅 tool_result 的延续请求。content 必须为空，
    // tool_result 文本完全靠 userInputMessageContext.toolResults 承载。
    finalContent = ""
  } else {
    let body = ""
    if (currentContent) {
      body = currentContent
    } else if (currentImages.length > 0) {
      body = normalizeUserContent("", true, false)
    } else {
      body = MINIMAL_FALLBACK_USER_CONTENT
    }
    finalContent = systemPrompt
      ? `--- SYSTEM PROMPT ---\n${systemPrompt}\n--- END SYSTEM PROMPT ---\n\n${body}`
      : body
  }

  const kiroTools = convertClaudeTools(
    dto.tools as
      | Array<{
          name?: string
          description?: string
          input_schema?: unknown
        }>
      | undefined
  )

  // Agent-mode resolution: caller can override via options.agentMode, otherwise
  // we infer from tool presence (matches the official Kiro client, which only
  // emits agentTaskType / agentContinuationId in its agent-mode path).
  const isAgentMode =
    options.agentMode ??
    (kiroTools.length > 0 || safeCurrentToolResults.length > 0)

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: options.conversationId || randomUUID(),
      currentMessage: {
        userInputMessage: {
          // 抓包验证：currentMessage.userInputMessage 同时带 modelId / origin。
          content: finalContent,
          modelId,
          origin,
          ...(currentImages.length > 0 ? { images: currentImages } : {}),
        },
      },
    },
  }

  if (isAgentMode) {
    payload.conversationState.agentTaskType = "vibe"
    payload.conversationState.agentContinuationId =
      options.agentContinuationId || randomUUID()
  }

  if (options.profileArn) {
    payload.profileArn = options.profileArn
  }

  // 字段顺序与抓包一致：toolResults 在 tools 之前。
  if (kiroTools.length > 0 || safeCurrentToolResults.length > 0) {
    const ctx: NonNullable<KiroUserInputMessage["userInputMessageContext"]> = {}
    if (safeCurrentToolResults.length > 0) {
      ctx.toolResults = safeCurrentToolResults
    }
    if (kiroTools.length > 0) {
      ctx.tools = kiroTools
    }
    payload.conversationState.currentMessage.userInputMessage.userInputMessageContext =
      ctx
  }

  if (trimmedHistory.length > 0) {
    payload.conversationState.history = trimmedHistory
  }

  // additionalModelRequestFields — verified accepted by the live endpoint
  // (claude-opus-4.7) at userInputMessage scope. Thinking on Opus 4.7 is
  // adaptive-by-default with summarized display, which can add 5–40s of
  // `reasoningContentEvent` frames to every tool continuation. Callers can
  // override via options.thinking / options.effort.
  const amrf = buildAdditionalModelRequestFields(options)
  if (amrf) {
    payload.conversationState.currentMessage.userInputMessage.additionalModelRequestFields =
      amrf
  }

  // 抓包里顶层无 inferenceConfig（官方客户端不发）；
  // 我们也不再附带，避免触发上游的 schema 校验。

  return payload
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build the `additionalModelRequestFields` object to splice onto the
 * outbound `userInputMessage`, or return `undefined` to leave it off the
 * wire (so the backend uses its model default).
 *
 * Today we only emit the field when the caller explicitly requested
 * `thinking` or `effort`. We deliberately do NOT inject a default — the
 * Kiro backend's own default is already adaptive thinking, and writing
 * the field unconditionally would change cache keys for every existing
 * caller. The bridge layer above (e.g. cursor-connect-stream) is the one
 * that decides whether to disable thinking based on the cursor-side
 * thinkingLevel.
 */
function buildAdditionalModelRequestFields(
  options: ClaudeToKiroOptions
): KiroAdditionalModelRequestFields | undefined {
  const thinking = options.thinking
  const effort = options.effort
  if (!thinking && !effort) return undefined

  const out: KiroAdditionalModelRequestFields = {}
  if (thinking) {
    out.thinking = thinking.display
      ? { type: thinking.type, display: thinking.display }
      : { type: thinking.type }
  }
  if (effort) {
    out.output_config = { effort }
  }
  return out
}

function extractSystemPromptText(system: CreateMessageDto["system"]): string {
  if (!system) return ""
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    const parts: string[] = []
    for (const block of system) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        parts.push(block.text)
      }
    }
    return parts.join("\n")
  }
  return ""
}

interface ExtractedUserContent {
  text: string
  images: KiroImage[]
  toolResults: KiroToolResult[]
}

function extractClaudeUserContent(content: unknown): ExtractedUserContent {
  const result: ExtractedUserContent = {
    text: "",
    images: [],
    toolResults: [],
  }
  if (typeof content === "string") {
    result.text = content
    return result
  }
  if (!Array.isArray(content)) return result

  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const record = block as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : ""
    switch (type) {
      case "text":
      case "input_text": {
        if (typeof record.text === "string") {
          result.text += record.text
        }
        break
      }
      case "image":
      case "image_url":
      case "input_image": {
        const image = extractImageBlock(record)
        if (image) result.images.push(image)
        break
      }
      case "tool_result": {
        const toolUseId =
          typeof record.tool_use_id === "string" ? record.tool_use_id : ""
        if (!toolUseId) break
        const text = extractToolResultContent(record.content)
        result.toolResults.push({
          toolUseId,
          content: [{ text }],
          status: record.is_error === true ? "error" : "success",
        })
        break
      }
      default:
        break
    }
  }
  return result
}

interface ExtractedAssistantContent {
  text: string
  toolUses: KiroToolUse[]
}

function extractClaudeAssistantContent(
  content: unknown
): ExtractedAssistantContent {
  const result: ExtractedAssistantContent = { text: "", toolUses: [] }
  if (typeof content === "string") {
    result.text = content
    return result
  }
  if (!Array.isArray(content)) return result

  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const record = block as Record<string, unknown>
    const type = typeof record.type === "string" ? record.type : ""
    if (type === "text") {
      if (typeof record.text === "string") {
        result.text += record.text
      }
    } else if (type === "tool_use") {
      const id = typeof record.id === "string" ? record.id : ""
      const name = typeof record.name === "string" ? record.name : ""
      const input =
        record.input &&
        typeof record.input === "object" &&
        !Array.isArray(record.input)
          ? (record.input as Record<string, unknown>)
          : {}
      if (id && name) {
        result.toolUses.push({ toolUseId: id, name, input })
      }
    } else if (type === "thinking" || type === "redacted_thinking") {
      // Kiro / CodeWhisperer has no on-the-wire thinking slot. Any thinking
      // blocks that survive into this translator are residual storage
      // artifacts — the send-time pipeline in
      // apps/protocol-bridge/src/llm/shared/normalize-for-api.ts is the
      // authoritative drop point for non-anthropic backends. Skip here as a
      // defensive fallback so we never accidentally splice reasoning text
      // into the user-visible Kiro payload.
      continue
    }
  }
  return result
}

function extractImageBlock(record: Record<string, unknown>): KiroImage | null {
  const source = record.source
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const src = source as Record<string, unknown>
    const data = typeof src.data === "string" ? src.data : ""
    const url = typeof src.url === "string" ? src.url : ""
    const mediaType =
      (typeof src.media_type === "string" ? src.media_type : "") ||
      (typeof src.mediaType === "string" ? src.mediaType : "") ||
      (typeof src.mime_type === "string" ? src.mime_type : "")

    if (data) {
      const dataUrlImage = parseDataUrl(data)
      if (dataUrlImage) return dataUrlImage
      const format = mediaType
        .toLowerCase()
        .replace(/^image\//, "")
        .trim()
      const image = parseBase64Image(data, format || "png")
      if (image) return image
    }
    if (url) {
      const dataUrlImage = parseDataUrl(url)
      if (dataUrlImage) return dataUrlImage
    }
  }

  // OpenAI-style image_url object
  const imageUrl = record["image_url"]
  if (imageUrl && typeof imageUrl === "object" && !Array.isArray(imageUrl)) {
    const inner = imageUrl as Record<string, unknown>
    if (typeof inner.url === "string") {
      const dataUrlImage = parseDataUrl(inner.url)
      if (dataUrlImage) return dataUrlImage
    }
  } else if (typeof imageUrl === "string") {
    const dataUrlImage = parseDataUrl(imageUrl)
    if (dataUrlImage) return dataUrlImage
  }

  if (typeof record.data === "string") {
    const dataUrlImage = parseDataUrl(record.data)
    if (dataUrlImage) return dataUrlImage
  }

  return null
}

function extractToolResultContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const record = block as Record<string, unknown>
    if (typeof record.text === "string") {
      parts.push(record.text)
    }
  }
  return parts.join("")
}

function trimLeadingAssistantHistory(
  history: KiroHistoryMessage[]
): KiroHistoryMessage[] {
  let idx = 0
  while (idx < history.length && history[idx]!.assistantResponseMessage) {
    idx++
  }
  if (idx === 0) return history
  if (idx >= history.length) return []
  return history.slice(idx)
}

function sanitizeKiroHistoryToolAdjacency(
  history: KiroHistoryMessage[]
): KiroHistoryMessage[] {
  const output: KiroHistoryMessage[] = []

  for (const entry of history) {
    if (entry.assistantResponseMessage) {
      if (output.length === 0) {
        continue
      }
      output.push(entry)
      continue
    }

    const user = entry.userInputMessage
    if (!user) continue

    const previousAssistant =
      output[output.length - 1]?.assistantResponseMessage
    const allowedToolUseIds = new Set(
      (previousAssistant?.toolUses || [])
        .map((toolUse) => toolUse.toolUseId)
        .filter((id) => id.length > 0)
    )
    const sanitizedUser = sanitizeKiroUserToolResults(user, allowedToolUseIds)
    if (!sanitizedUser) continue

    output.push({ userInputMessage: sanitizedUser })
  }

  return output
}

function sanitizeKiroUserToolResults(
  user: KiroUserInputMessage,
  allowedToolUseIds: ReadonlySet<string>
): KiroUserInputMessage | undefined {
  const context = user.userInputMessageContext
  const toolResults = context?.toolResults || []
  let nextContext: KiroUserInputMessageContext | undefined = context
    ? { ...context }
    : undefined

  if (toolResults.length > 0 || allowedToolUseIds.size > 0) {
    const filteredToolResults =
      allowedToolUseIds.size > 0
        ? toolResults.filter((result) =>
            allowedToolUseIds.has(result.toolUseId)
          )
        : []
    const existingIds = new Set(
      filteredToolResults.map((result) => result.toolUseId)
    )
    const syntheticMissingResults = [...allowedToolUseIds]
      .filter((toolUseId) => !existingIds.has(toolUseId))
      .map(createSyntheticInterruptedKiroToolResult)
    const nextToolResults = [...filteredToolResults, ...syntheticMissingResults]

    nextContext = nextContext || {}
    if (nextToolResults.length > 0) {
      nextContext.toolResults = nextToolResults
    } else {
      delete nextContext.toolResults
    }
    if (!nextContext.tools?.length && !nextContext.toolResults?.length) {
      nextContext = undefined
    }
  }

  const sanitized: KiroUserInputMessage = {
    ...user,
    ...(nextContext ? { userInputMessageContext: nextContext } : {}),
  }
  if (!nextContext) {
    delete sanitized.userInputMessageContext
  }

  if (!hasKiroUserPayload(sanitized)) {
    return undefined
  }
  return sanitized
}

function sanitizeCurrentToolResultsForHistory(
  toolResults: KiroToolResult[],
  history: KiroHistoryMessage[]
): KiroToolResult[] {
  if (toolResults.length === 0) return toolResults
  const lastAssistant = [...history]
    .reverse()
    .find((entry) => entry.assistantResponseMessage)?.assistantResponseMessage
  const allowedToolUseIds = new Set(
    (lastAssistant?.toolUses || [])
      .map((toolUse) => toolUse.toolUseId)
      .filter((id) => id.length > 0)
  )
  if (allowedToolUseIds.size === 0) return []
  return toolResults.filter((result) => allowedToolUseIds.has(result.toolUseId))
}

/**
 * Ensure the trailing history `assistantResponseMessage`'s `toolUses` are all
 * answered by the current message's `toolResults`.
 *
 * Kiro rejects a payload whose history ends on an assistant turn with open
 * toolUses that nothing answers (`Improperly formed request`, HTTP 400,
 * reason=null). This happens on control-frame resumes — most notably a
 * background-shell task completion — where the last real assistant turn
 * spawned a tool whose result never returned, and the resume carries only
 * text.
 *
 * For every trailing toolUseId not already covered by `toolResults`, append a
 * synthetic interrupted result so the pair is closed. Ids are only backfilled
 * when history actually ends on an assistant entry; an assistant followed by a
 * user entry is already handled by `sanitizeKiroHistoryToolAdjacency`.
 */
function backfillTrailingAssistantToolResults(
  toolResults: KiroToolResult[],
  history: KiroHistoryMessage[]
): KiroToolResult[] {
  const lastEntry = history[history.length - 1]
  const trailingAssistant = lastEntry?.assistantResponseMessage
  if (!trailingAssistant) return toolResults

  const trailingToolUseIds = (trailingAssistant.toolUses || [])
    .map((toolUse) => toolUse.toolUseId)
    .filter((id) => id.length > 0)
  if (trailingToolUseIds.length === 0) return toolResults

  const coveredIds = new Set(toolResults.map((result) => result.toolUseId))
  const missing = trailingToolUseIds.filter((id) => !coveredIds.has(id))
  if (missing.length === 0) return toolResults

  return [
    ...toolResults,
    ...missing.map(createSyntheticInterruptedKiroToolResult),
  ]
}

function createSyntheticInterruptedKiroToolResult(
  toolUseId: string
): KiroToolResult {
  return {
    toolUseId,
    content: [
      {
        text: "Tool execution was interrupted or result was lost due to context truncation.",
      },
    ],
    status: "error",
  }
}

function hasKiroUserPayload(user: KiroUserInputMessage): boolean {
  if ((user.content || "").trim().length > 0) return true
  if ((user.images || []).length > 0) return true
  if ((user.userInputMessageContext?.toolResults || []).length > 0) return true
  return false
}

function normalizeUserContent(
  text: string,
  hasImages: boolean,
  _hasToolResults: boolean
): string {
  const trimmed = (text || "").trim()
  if (trimmed === "" && hasImages) {
    return "Please analyze the attached image."
  }
  return trimmed
}

function parseDataUrl(input: string): KiroImage | null {
  const cleaned = (input || "").replaceAll("\r", "").replaceAll("\n", "").trim()
  if (cleaned.includes("[Image")) return null
  const match = cleaned.match(
    /^data:image\/([a-zA-Z0-9+.-]+)(;[a-zA-Z0-9=._:+-]+)*;base64,(.+)$/
  )
  if (!match) return null
  return parseBase64Image(match[3]!, match[1]!)
}

function parseBase64Image(data: string, formatRaw: string): KiroImage | null {
  if (!data) return null
  let format = (formatRaw || "png").toLowerCase()
  if (format === "jpg") format = "jpeg"
  // Validate the body is decodable base64. If decode fails entirely, drop.
  try {
    Buffer.from(data, "base64")
  } catch {
    return null
  }
  return {
    format,
    source: { bytes: data },
  }
}

function convertClaudeTools(
  tools:
    | Array<{
        name?: string
        description?: string
        input_schema?: unknown
      }>
    | undefined
): KiroToolWrapper[] {
  if (!tools || tools.length === 0) {
    return []
  }
  const result: KiroToolWrapper[] = []
  for (const tool of tools) {
    const original = tool.name || ""
    if (!original) continue
    const description = (tool.description || "").slice(
      0,
      MAX_TOOL_DESCRIPTION_LENGTH
    )
    // 抓包验证：Kiro 后端接受下划线工具名（execute_bash / str_replace 等），
    // 不需要 camelCase 转换；仅当超过 64 字符时做最小侵入截断。
    const safeName = enforceToolNameLength(original)
    result.push({
      toolSpecification: {
        name: safeName,
        description:
          (tool.description || "").length > MAX_TOOL_DESCRIPTION_LENGTH
            ? description + "..."
            : description,
        inputSchema: { json: ensureObjectSchema(tool.input_schema) },
      },
    })
  }
  return result
}

function ensureObjectSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object" }
  }
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  cleanSchema(cloned)
  if (!("type" in cloned)) {
    cloned.type = "object"
  }
  return cloned
}

function cleanSchema(node: Record<string, unknown>): void {
  if ("required" in node) {
    const req = node.required
    if (req == null) {
      delete node.required
    } else if (Array.isArray(req) && req.length === 0) {
      delete node.required
    }
  }

  if (
    node.properties &&
    typeof node.properties === "object" &&
    !Array.isArray(node.properties)
  ) {
    for (const value of Object.values(node.properties)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        cleanSchema(value as Record<string, unknown>)
      }
    }
  }
  if (
    node.items &&
    typeof node.items === "object" &&
    !Array.isArray(node.items)
  ) {
    cleanSchema(node.items as Record<string, unknown>)
  }
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === "object" &&
    !Array.isArray(node.additionalProperties)
  ) {
    cleanSchema(node.additionalProperties as Record<string, unknown>)
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    const arr = node[key]
    if (Array.isArray(arr)) {
      for (const sub of arr) {
        if (sub && typeof sub === "object" && !Array.isArray(sub)) {
          cleanSchema(sub as Record<string, unknown>)
        }
      }
    }
  }
}

/**
 * 把工具名截断到 64 字符以内。
 * 抓包验证：Kiro 后端接受下划线风格的工具名，无需 camelCase 转换。
 * 仅当超长时做最小侵入截断，并尽量保留 mcp__ 命名空间后段。
 */
function enforceToolNameLength(name: string): string {
  if (!name) return "tool"
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name
  if (name.startsWith("mcp__")) {
    const lastIdx = name.lastIndexOf("__")
    if (lastIdx > 5) {
      const shortened = `mcp__${name.slice(lastIdx + 2)}`
      if (shortened.length <= MAX_TOOL_NAME_LENGTH) return shortened
    }
  }
  return name.slice(0, MAX_TOOL_NAME_LENGTH)
}

export const __TEST__ = {
  enforceToolNameLength,
  trimLeadingAssistantHistory,
}
