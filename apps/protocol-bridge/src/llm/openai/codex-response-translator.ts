/**
 * Codex Response Translator
 *
 * Translates Codex (OpenAI Responses API) SSE events into Claude/Anthropic
 * Messages API SSE events for streaming responses.
 *
 * Ported from CLIProxyAPI: internal/translator/codex/claude/codex_claude_response.go
 *
 * SSE Event Mapping:
 *   Codex SSE Event                          → Claude SSE Event
 *   ─────────────────────────────────────     ──────────────────────────────
 *   response.created                         → message_start
 *   response.reasoning_summary_part.added    → content_block_start (thinking)
 *   response.reasoning_summary_text.delta    → content_block_delta (thinking_delta)
 *   response.reasoning_summary_part.done     → content_block_stop
 *   response.content_part.added              → content_block_start (text)
 *   response.output_text.delta               → content_block_delta (text_delta)
 *   response.content_part.done               → content_block_stop
 *   response.output_item.added (func_call)   → content_block_start (tool_use)
 *   response.function_call_arguments.delta   → content_block_delta (input_json_delta)
 *   response.output_item.done (func_call)    → content_block_stop
 *   response.completed                       → message_delta + message_stop
 */

import type { AnthropicResponse, ContentBlock } from "../../shared/anthropic"

// ── Streaming state ────────────────────────────────────────────────────

export interface CodexStreamState {
  hasToolCall: boolean
  blockIndex: number
  hasReceivedArgumentsDelta: boolean
  hasTextDelta: boolean
  textBlockOpen: boolean
  thinkingBlockOpen: boolean
  thinkingStopPending: boolean
  thinkingSignature: string
  thinkingSummarySeen: boolean
  responseId: string
  model: string
}

export function createStreamState(): CodexStreamState {
  return {
    hasToolCall: false,
    blockIndex: 0,
    hasReceivedArgumentsDelta: false,
    hasTextDelta: false,
    textBlockOpen: false,
    thinkingBlockOpen: false,
    thinkingStopPending: false,
    thinkingSignature: "",
    thinkingSummarySeen: false,
    responseId: "",
    model: "",
  }
}

// ── Claude tool ID sanitizer ───────────────────────────────────────────
// Ported from CLIProxyAPI: internal/util/claude_tool_id.go

let toolIdCounter = 0
const CLAUDE_TOOL_ID_RE = /[^a-zA-Z0-9_-]/g

function sanitizeClaudeToolId(id: string): string {
  const s = id.replace(CLAUDE_TOOL_ID_RE, "_")
  if (!s) {
    return `toolu_${Date.now()}_${++toolIdCounter}`
  }
  return s
}

// ── Usage extraction ───────────────────────────────────────────────────

function extractResponsesUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
} {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
  }
  let inputTokens = (usage.input_tokens as number) || 0
  const outputTokens = (usage.output_tokens as number) || 0
  const cachedTokens =
    ((usage.input_tokens_details as Record<string, unknown>)
      ?.cached_tokens as number) || 0

  if (cachedTokens > 0) {
    inputTokens = inputTokens >= cachedTokens ? inputTokens - cachedTokens : 0
  }

  return { inputTokens, outputTokens, cachedTokens }
}

// ── SSE event formatting ───────────────────────────────────────────────

function formatSseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function startThinkingBlock(state: CodexStreamState): string[] {
  if (state.thinkingBlockOpen) return []

  state.thinkingBlockOpen = true
  state.thinkingStopPending = false
  return [
    formatSseEvent("content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "thinking", thinking: "" },
    }),
  ]
}

function finalizeThinkingBlock(state: CodexStreamState): string[] {
  if (!state.thinkingBlockOpen) return []

  const results: string[] = []
  if (state.thinkingSignature) {
    results.push(
      formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: {
          type: "signature_delta",
          signature: state.thinkingSignature,
        },
      })
    )
  }

  results.push(
    formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.blockIndex,
    })
  )

  state.blockIndex++
  state.thinkingBlockOpen = false
  state.thinkingStopPending = false
  state.thinkingSignature = ""
  return results
}

function finalizeSignatureOnlyThinkingBlock(state: CodexStreamState): string[] {
  if (!state.thinkingSignature) return []

  return [...startThinkingBlock(state), ...finalizeThinkingBlock(state)]
}

function extractReasoningText(item: Record<string, unknown>): string {
  let thinkingText = ""
  const summary = item.summary as Array<Record<string, unknown>> | string
  if (Array.isArray(summary)) {
    for (const part of summary) {
      const text = (part.text as string) || ""
      thinkingText += text || JSON.stringify(part ?? "")
    }
  } else if (typeof summary === "string") {
    thinkingText = summary
  }

  if (!thinkingText) {
    const reasoningContent = item.content as
      | Array<Record<string, unknown>>
      | string
    if (Array.isArray(reasoningContent)) {
      for (const part of reasoningContent) {
        const text = (part.text as string) || ""
        thinkingText += text || JSON.stringify(part ?? "")
      }
    } else if (typeof reasoningContent === "string") {
      thinkingText = reasoningContent
    }
  }

  return thinkingText
}

// ── Streaming translator ───────────────────────────────────────────────

/**
 * Translate a single Codex SSE line into Claude SSE event(s).
 *
 * @param line - Raw SSE line from Codex upstream (e.g. "data: {...}")
 * @param state - Mutable streaming state maintained across calls
 * @param reverseToolMap - Map from shortened tool names back to originals
 * @returns Array of Claude SSE event strings to emit
 */
export function translateCodexSseEvent(
  line: string,
  state: CodexStreamState,
  reverseToolMap: Map<string, string>
): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return []
  }

  const jsonStr = trimmed.slice(5).trim()
  if (!jsonStr || jsonStr === "[DONE]") {
    return []
  }

  let event: Record<string, unknown>
  try {
    event = JSON.parse(jsonStr) as Record<string, unknown>
  } catch {
    return []
  }

  const eventType = event.type as string
  if (!eventType) {
    return []
  }

  const results: string[] = []
  if (state.thinkingBlockOpen && state.thinkingStopPending) {
    switch (eventType) {
      case "response.content_part.added":
      case "response.output_item.added":
      case "response.completed":
      case "response.incomplete":
        results.push(...finalizeThinkingBlock(state))
        break
    }
  }

  switch (eventType) {
    // ── response.created → message_start ──────────────────────────
    case "response.created": {
      const response = event.response as Record<string, unknown>
      state.responseId = (response?.id as string) || ""
      state.model = (response?.model as string) || ""

      results.push(
        formatSseEvent("message_start", {
          type: "message_start",
          message: {
            id: state.responseId,
            type: "message",
            role: "assistant",
            model: state.model,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            content: [],
            stop_reason: null,
          },
        })
      )
      break
    }

    // ── Reasoning (thinking) blocks ──────────────────────────────
    case "response.reasoning_summary_part.added": {
      if (state.thinkingBlockOpen && state.thinkingStopPending) {
        results.push(...finalizeThinkingBlock(state))
      }
      state.thinkingSummarySeen = true
      results.push(...startThinkingBlock(state))
      break
    }

    case "response.reasoning_summary_text.delta": {
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "thinking_delta", thinking: delta },
          })
        )
      }
      break
    }

    case "response.reasoning_summary_part.done": {
      state.thinkingStopPending = true
      break
    }

    // ── Text content blocks ──────────────────────────────────────
    case "response.content_part.added": {
      results.push(...finalizeThinkingBlock(state))
      state.textBlockOpen = true
      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        })
      )
      break
    }

    case "response.output_text.delta": {
      state.hasTextDelta = true
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text: delta },
          })
        )
      }
      break
    }

    case "response.content_part.done": {
      results.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        })
      )
      state.textBlockOpen = false
      state.blockIndex++
      break
    }

    // ── Function call (tool_use) blocks ──────────────────────────
    case "response.output_item.added": {
      const item = event.item as Record<string, unknown>
      if (!item) {
        break
      }

      if (item.type === "reasoning") {
        state.thinkingSummarySeen = false
        state.thinkingSignature =
          typeof item.encrypted_content === "string"
            ? item.encrypted_content
            : ""
        break
      }

      if (item.type !== "function_call" && item.type !== "custom_tool_call") {
        break
      }

      results.push(...finalizeThinkingBlock(state))
      state.hasToolCall = true
      state.hasReceivedArgumentsDelta = false

      // Restore original tool name if shortened
      let name = (item.name as string) || ""
      const original = reverseToolMap.get(name)
      if (original) name = original

      results.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: {
            type: "tool_use",
            id: sanitizeClaudeToolId((item.call_id as string) || ""),
            name,
            input: {},
          },
        })
      )

      // Emit initial empty input_json_delta
      results.push(
        formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.blockIndex,
          delta: { type: "input_json_delta", partial_json: "" },
        })
      )
      break
    }

    case "response.function_call_arguments.delta": {
      state.hasReceivedArgumentsDelta = true
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: delta },
          })
        )
      }
      break
    }

    case "response.function_call_arguments.done": {
      // Some models send arguments in a single "done" event without preceding "delta" events.
      // Emit the full arguments as a single input_json_delta so the downstream client
      // receives the complete tool input.
      if (!state.hasReceivedArgumentsDelta) {
        const args = event.arguments as string
        if (args) {
          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: { type: "input_json_delta", partial_json: args },
            })
          )
        }
      }
      break
    }

    // ── custom_tool_call 参数流式传输 — 对齐 Codex 官方 response.custom_tool_call_input.delta ──
    case "response.custom_tool_call_input.delta": {
      state.hasReceivedArgumentsDelta = true
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "input_json_delta", partial_json: delta },
          })
        )
      }
      break
    }

    case "response.output_item.done": {
      const item = event.item as Record<string, unknown>
      if (!item) {
        break
      }

      if (item.type === "message") {
        if (state.hasTextDelta) {
          break
        }
        const content = item.content as Array<Record<string, unknown>> | string
        let text = ""
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "output_text" && typeof part.text === "string") {
              text += part.text
            }
          }
        } else if (typeof content === "string") {
          text = content
        }
        if (!text) {
          break
        }

        results.push(...finalizeThinkingBlock(state))
        if (!state.textBlockOpen) {
          state.textBlockOpen = true
          results.push(
            formatSseEvent("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: { type: "text", text: "" },
            })
          )
        }
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text },
          })
        )
        results.push(
          formatSseEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.blockIndex,
          })
        )
        state.textBlockOpen = false
        state.blockIndex++
        state.hasTextDelta = true
        break
      }

      if (item.type === "reasoning") {
        if (
          typeof item.encrypted_content === "string" &&
          item.encrypted_content
        ) {
          state.thinkingSignature = item.encrypted_content
        }
        if (state.thinkingSummarySeen) {
          results.push(...finalizeThinkingBlock(state))
        } else {
          results.push(...finalizeSignatureOnlyThinkingBlock(state))
        }
        state.thinkingSummarySeen = false
        break
      }

      if (item.type === "image_generation_call") {
        const status = typeof item.status === "string" ? item.status : "unknown"
        const revisedPrompt =
          typeof item.revised_prompt === "string" ? item.revised_prompt : ""
        const result = typeof item.result === "string" ? item.result : ""
        const text = [
          `[image_generation_call] status=${status}`,
          revisedPrompt ? `revised_prompt: ${revisedPrompt}` : "",
          result ? `image_data_base64_length: ${result.length}` : "",
        ]
          .filter(Boolean)
          .join("\n")

        results.push(...finalizeThinkingBlock(state))
        if (!state.textBlockOpen) {
          state.textBlockOpen = true
          results.push(
            formatSseEvent("content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: { type: "text", text: "" },
            })
          )
        }
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text },
          })
        )
        results.push(
          formatSseEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.blockIndex,
          })
        )
        state.textBlockOpen = false
        state.blockIndex++
        state.hasTextDelta = true
        break
      }

      if (item.type !== "function_call" && item.type !== "custom_tool_call") {
        break
      }

      // custom_tool_call：透传原始 input，不做 patch 包装。
      // 如果上游需要特定包装（如 Cursor 的 apply_agent_diff），在消费侧处理。
      if (item.type === "custom_tool_call") {
        const rawInput =
          typeof item.input === "string"
            ? item.input
            : JSON.stringify(item.input)
        if (rawInput) {
          results.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: rawInput,
              },
            })
          )
        }
      }

      results.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        })
      )
      state.blockIndex++
      break
    }

    // ── response.completed → message_delta + message_stop ────────
    case "response.completed": {
      const response = event.response as Record<string, unknown>
      const usage = extractResponsesUsage(
        response?.usage as Record<string, unknown>
      )

      let stopReason: string
      const upstreamStopReason = response?.stop_reason as string
      if (state.hasToolCall) {
        stopReason = "tool_use"
      } else if (
        upstreamStopReason === "max_tokens" ||
        upstreamStopReason === "stop"
      ) {
        stopReason = upstreamStopReason
      } else {
        stopReason = "end_turn"
      }

      const messageDelta: Record<string, unknown> = {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        },
      }
      if (usage.cachedTokens > 0) {
        ;(
          messageDelta.usage as Record<string, unknown>
        ).cache_read_input_tokens = usage.cachedTokens
      }

      results.push(formatSseEvent("message_delta", messageDelta))
      results.push(formatSseEvent("message_stop", { type: "message_stop" }))
      break
    }

    // ── response.failed → 错误终止 — 对齐 Codex 官方 response.failed 事件 ──
    case "response.failed": {
      const response = event.response as Record<string, unknown>
      const errorObj = response?.error as Record<string, unknown>
      const errorMessage = (errorObj?.message as string) || "Response failed"
      const errorCode = (errorObj?.code as string) || "unknown_error"

      // 映射已知错误码到标准 stop_reason
      let stopReason = "error"
      if (errorCode === "context_length_exceeded") {
        stopReason = "max_tokens"
      }

      results.push(
        formatSseEvent("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopReason,
            stop_sequence: null,
            error: { type: errorCode, message: errorMessage },
          },
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      )
      results.push(formatSseEvent("message_stop", { type: "message_stop" }))
      break
    }

    // ── response.incomplete → 不完整响应 — 对齐 Codex 官方 response.incomplete 事件 ──
    case "response.incomplete": {
      const response = event.response as Record<string, unknown>
      const incompleteDetails = response?.incomplete_details as Record<
        string,
        unknown
      >
      const reason = (incompleteDetails?.reason as string) || "unknown"

      let stopReason = "max_tokens"
      if (reason === "max_output_tokens") {
        stopReason = "max_tokens"
      }

      results.push(
        formatSseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      )
      results.push(formatSseEvent("message_stop", { type: "message_stop" }))
      break
    }

    // ── reasoning 原始内容 — 对齐 Codex 官方 response.reasoning_text.delta ──
    // 当服务端不提供 summary 而是发送原始 reasoning content 时使用。
    case "response.reasoning_text.delta": {
      results.push(...startThinkingBlock(state))
      const delta = event.delta as string
      if (delta != null) {
        results.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "thinking_delta", thinking: delta },
          })
        )
      }
      break
    }

    default:
      // Unknown event type, skip
      break
  }

  return results
}

// ── Non-streaming translator ───────────────────────────────────────────

/**
 * Translate a complete Codex response (from response.completed event)
 * into a Claude/Anthropic non-streaming response.
 */
export function translateCodexToClaudeNonStream(
  completedEvent: Record<string, unknown>,
  reverseToolMap: Map<string, string>
): AnthropicResponse | null {
  if (completedEvent.type !== "response.completed") {
    return null
  }

  const response = completedEvent.response as Record<string, unknown>
  if (!response) return null

  const usage = extractResponsesUsage(response.usage as Record<string, unknown>)
  const content: ContentBlock[] = []
  let hasToolCall = false

  const output = response.output as Array<Record<string, unknown>>
  if (Array.isArray(output)) {
    for (const item of output) {
      const itemType = item.type as string

      switch (itemType) {
        case "reasoning": {
          const thinkingText = extractReasoningText(item)
          const signature =
            typeof item.encrypted_content === "string"
              ? item.encrypted_content
              : ""

          if (thinkingText || signature) {
            content.push({
              type: "thinking",
              thinking: thinkingText,
              ...(signature ? { signature } : {}),
            })
          }
          break
        }

        case "message": {
          const msgContent = item.content as
            | Array<Record<string, unknown>>
            | string
          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (part.type === "output_text") {
                const text = (part.text as string) || ""
                if (text) {
                  content.push({ type: "text", text })
                }
              }
            }
          } else if (typeof msgContent === "string" && msgContent) {
            content.push({ type: "text", text: msgContent })
          }
          break
        }

        case "function_call": {
          hasToolCall = true
          let name = (item.name as string) || ""
          const original = reverseToolMap.get(name)
          if (original) name = original

          let input: Record<string, unknown> = {}
          const argsStr = item.arguments as string
          if (argsStr) {
            try {
              const parsed = JSON.parse(argsStr) as Record<string, unknown>
              if (typeof parsed === "object" && parsed !== null) {
                input = parsed
              }
            } catch {
              // Leave input as empty object
            }
          }

          content.push({
            type: "tool_use",
            id: sanitizeClaudeToolId((item.call_id as string) || ""),
            name,
            input,
          })
          break
        }

        case "custom_tool_call": {
          hasToolCall = true
          let name = (item.name as string) || ""
          const original = reverseToolMap.get(name)
          if (original) name = original

          // 透传原始 input，不做 patch 包装。
          let customInput: Record<string, unknown> = {}
          if (typeof item.input === "string") {
            try {
              const parsed = JSON.parse(item.input) as Record<string, unknown>
              if (typeof parsed === "object" && parsed !== null) {
                customInput = parsed
              }
            } catch {
              customInput = { input: item.input }
            }
          } else if (item.input && typeof item.input === "object") {
            customInput = item.input as Record<string, unknown>
          }

          content.push({
            type: "tool_use",
            id: sanitizeClaudeToolId((item.call_id as string) || ""),
            name,
            input: customInput,
          })
          break
        }
      }
    }
  }

  // Determine stop reason
  let stopReason: string
  const upstreamStopReason = response.stop_reason as string
  if (
    upstreamStopReason &&
    (upstreamStopReason === "max_tokens" || upstreamStopReason === "stop")
  ) {
    stopReason = upstreamStopReason
  } else if (hasToolCall) {
    stopReason = "tool_use"
  } else {
    stopReason = "end_turn"
  }

  return {
    id: (response.id as string) || "",
    type: "message",
    role: "assistant",
    model: (response.model as string) || "",
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    },
  }
}
