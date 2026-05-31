import { Injectable, Logger } from "@nestjs/common"
import { ForkedAnthropicCallService } from "../../../llm/anthropic/forked-anthropic-call.service"
import { ContextTelemetryService } from "../../../context/context-telemetry.service"
import type { BackendType } from "../../../llm/shared/model-router.service"
import {
  applySubagentOverride,
  TOOL_USE_SUMMARY_SUBAGENT_TYPE,
  type ResolvedSubagentOverride,
} from "./subagent-model-override"

/**
 * One-line summary label for a batch of tool calls. Mirrors cc's
 * ToolUseSummary path which fires after each tool batch completion to
 * produce a 30-char-ish git-commit-subject style label
 * ("Read package.json", "Searched for TODO", "Updated README").
 *
 * Bridge use cases:
 *   - cc CLI streaming endpoint emits a `tool_use_summary` SSE event
 *     so the cc client renders the label inline (matches cc upstream
 *     behavior).
 *   - Cursor sessions stash the label on `SessionRecord.lastToolUseSummary`
 *     and lift it into a `tool_use.summary` telemetry event for
 *     diagnostics tooling.
 *
 * Implementation notes:
 *   - Uses ForkedAnthropicCallService.runForkedSmallFastCall so the
 *     summary always lands on a small-fast model (haiku-class). When
 *     the parent isn't a Claude family model the fork helper returns
 *     null upstream and we fail-silent here.
 *   - Tool batches are usually 1–6 entries with truncated input/output;
 *     no cache sharing benefit, so we deliberately pass empty `system`
 *     and `tools` (no parent cache prefix) to keep the call shape
 *     minimal. cc gets the same effect because cc's small-fast haiku
 *     query has no tools and no real system prompt either.
 *   - All failures are caught and surfaced as `null` — a missing label
 *     is a UX nicety, never a request blocker.
 */
const SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished.
Should be ≤30 chars, past tense, like a git commit subject.

Examples:
- "Read package.json"
- "Searched for TODO"
- "Listed src/utils"
- "Ran npm test"
- "Edited README.md"

Output only the label, no quotes, no extra commentary.`

const MAX_INTENT_CHARS = 200
const MAX_INPUT_CHARS = 300
const MAX_OUTPUT_CHARS = 300
const MAX_LABEL_CHARS = 60

export interface ToolUseSummaryInput {
  parentModel: string
  /**
   * Backend that served the parent turn.  Plumbed through so the haiku
   * summary call lands on the same backend pool the parent's accounts
   * are configured on (Kiro-only deployments would otherwise route to
   * Claude API and fail with "no configured account").  Optional —
   * absent means use the historical Claude-API default.
   */
  parentBackend?: BackendType
  /**
   * Per-subagent override (looked up against
   * `TOOL_USE_SUMMARY_SUBAGENT_TYPE`) captured from the active
   * AgentRunRequest's `subagent_model_overrides`. Three-state semantics:
   *
   *   - `undefined` / `inherit` → run the helper on the parent model
   *     and parent backend (preserves prompt cache hit).
   *   - `disabled`              → skip the helper entirely. The parent
   *     turn proceeds without a summary label.
   *   - `model`                 → run the helper on the pinned model,
   *     routed via ModelRouterService so non-Claude pins (GPT, Gemini)
   *     work too.
   *
   * The Cursor settings UI key for this slot is the synthetic
   * `_tool_use_summary` string; the bridge reserves it so it cannot
   * collide with a user-defined `.cursor/agents/*.md` file.
   */
  override?: ResolvedSubagentOverride
  tools: ReadonlyArray<{
    name: string
    input: unknown
    output: unknown
  }>
  /** Last assistant text — used as "user intent" hint for the summarizer. */
  lastAssistantText?: string
  abortSignal?: AbortSignal
  /** For telemetry attribution; not part of the prompt. */
  conversationId?: string
}

@Injectable()
export class ToolUseSummaryService {
  private readonly logger = new Logger(ToolUseSummaryService.name)

  constructor(
    private readonly forkedCall: ForkedAnthropicCallService,
    private readonly telemetry: ContextTelemetryService
  ) {}

  async generate(input: ToolUseSummaryInput): Promise<string | null> {
    if (!input.tools || input.tools.length === 0) return null
    // Honour the user's settings-UI choice for the
    // `TOOL_USE_SUMMARY_SUBAGENT_TYPE` slot.  `skip` short-circuits
    // before we incur any LLM cost; `proceed-with-model` pins the
    // helper to a specific model id (which ForkedAnthropicCallService
    // routes via ModelRouterService); the default (`proceed-inherit`)
    // reuses the parent model + backend so the upstream prompt cache
    // hits.
    const decision = applySubagentOverride(input.override)
    if (decision.kind === "skip") {
      this.logger.debug(
        `tool_use_summary disabled by subagent_model_overrides[` +
          `${TOOL_USE_SUMMARY_SUBAGENT_TYPE}]; skipping helper call.`
      )
      return null
    }

    try {
      const userPrompt = this.buildUserPrompt(input)
      const result = await this.forkedCall.runForkedSmallFastCall({
        cacheSafeParams: {
          model: input.parentModel,
          system: SYSTEM_PROMPT,
          tools: undefined,
          betas: undefined,
        },
        promptMessages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
        maxOutputTokens: 64,
        abortSignal: input.abortSignal,
        parentBackend: input.parentBackend,
        // Undefined here means the fork helper inherits the parent
        // model verbatim (cache-friendly). When the user pinned a
        // specific model in the settings UI we hand its id through.
        smallFastModel:
          decision.kind === "proceed-with-model" ? decision.modelId : undefined,
      })
      // `null` means the fork helper short-circuited because no Claude-
      // serving backend matches the parent (e.g. parent ran on codex).
      // Treat the same as a thrown error: skip the label silently.
      if (!result) return null
      const raw = result.text.trim()
      if (!raw) return null
      const label = this.sanitizeLabel(raw)
      if (!label) return null
      this.telemetry.recordEvent({
        event: "tool_use.summary",
        scope: input.conversationId ?? "global",
        metadata: { label, toolCount: input.tools.length },
      })
      return label
    } catch (error) {
      this.logger.debug(
        `tool_use_summary generation failed (silent): ${String(error)}`
      )
      return null
    }
  }

  private buildUserPrompt(input: ToolUseSummaryInput): string {
    const lines: string[] = []
    if (input.lastAssistantText) {
      const intent = this.truncate(
        input.lastAssistantText.trim().replace(/\s+/g, " "),
        MAX_INTENT_CHARS
      )
      lines.push(`User's intent (from assistant's last message): ${intent}`)
      lines.push("")
    }
    lines.push("Tools completed:")
    for (const tool of input.tools) {
      lines.push(`Tool: ${tool.name}`)
      lines.push(`Input: ${this.serializeArg(tool.input, MAX_INPUT_CHARS)}`)
      lines.push(`Output: ${this.serializeArg(tool.output, MAX_OUTPUT_CHARS)}`)
    }
    lines.push("")
    lines.push("Label:")
    return lines.join("\n")
  }

  private serializeArg(value: unknown, maxChars: number): string {
    let serialized: string
    if (typeof value === "string") {
      serialized = value
    } else if (value === undefined || value === null) {
      serialized = ""
    } else {
      try {
        serialized = JSON.stringify(value)
      } catch {
        // value may be a non-stringifiable object/symbol; fall back to a
        // generic placeholder rather than the default "[object Object]".
        serialized =
          typeof value === "object" ? "[object]" : String(value as never)
      }
    }
    return this.truncate(serialized.replace(/\s+/g, " ").trim(), maxChars)
  }

  private truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value
    return value.slice(0, Math.max(0, maxChars - 1)) + "…"
  }

  private sanitizeLabel(raw: string): string {
    // Drop surrounding quotes / backticks / trailing punctuation that
    // small models love to add.
    let cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
    if (cleaned.endsWith(".")) cleaned = cleaned.slice(0, -1)
    if (cleaned.length > MAX_LABEL_CHARS) {
      cleaned = cleaned.slice(0, MAX_LABEL_CHARS - 1) + "…"
    }
    return cleaned
  }
}
