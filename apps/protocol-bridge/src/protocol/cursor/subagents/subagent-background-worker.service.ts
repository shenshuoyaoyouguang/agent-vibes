/**
 * Background sub-agent worker.
 *
 * Entry point for sub-agents that the parent agent spawned with
 * `task(run_in_background=true)`. Runs the sub-agent's LLM loop the
 * same way `executeSubAgentTask` does for foreground sub-agents, but
 * with two structural differences:
 *
 *   1. NO outbound BiDi yields. The parent task tool is settled the
 *      moment the worker is spawned, so the BiDi stream that handed
 *      off the task is already closed by the time the worker is
 *      executing real LLM turns. Instead of `yield Buffer`, every
 *      event is appended to the agent's transcript JSONL on disk.
 *
 *   2. NO ExecServerMessage tools. With no parent BiDi stream there is
 *      no place to send shell/edit/delete protocol messages. The worker
 *      surface is clamped to bridge-local / inline tools: read-only
 *      workspace search/read/list plus web, semantic search, MCP,
 *      reflect, todo, plan, lints, project metadata, rules, symbols,
 *      knowledge_base, and fetch_pull_request.
 *
 * The worker writes a final `result.txt` and updates `metadata.json`
 * `status` to `completed` / `failed` / `killed`. The parent agent reads
 * either of these via the standard `read_file` tool when the user
 * follows up.
 */

import { Injectable, Logger } from "@nestjs/common"
import * as crypto from "crypto"

import {
  resolveSubagentToolSurface,
  SUB_AGENT_SAFE_TOOL_NAMES,
} from "./subagent-tool-resolver"
import { getSubagentSystemPrompt, type SubagentDefinition } from "./types"
import {
  type SubagentTaskMetadata,
  SubagentTranscriptStore,
} from "./subagent-transcript-store.service"

/**
 * Tool families that are safe for background sub-agents — i.e. tools
 * fully serviceable inside the bridge process without an
 * ExecServerMessage round-trip. The intersection with
 * `SUB_AGENT_SAFE_TOOL_NAMES` is what the resolver actually applies; we
 * keep this list separate so the universe shrinks symmetrically when
 * the safe surface evolves.
 */
const BACKGROUND_INLINE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "semantic_search",
  "deep_search",
  "read_semsearch_files",
  "file_search",
  "glob_search",
  "search_symbols",
  "go_to_definition",
  "grep_search",
  "read_file",
  "list_directory",
  "web_search",
  "web_fetch",
  "fetch",
  "exa_search",
  "exa_fetch",
  "fetch_rules",
  "read_lints",
  "read_project",
  "read_todos",
  "update_todos",
  "create_plan",
  "get_mcp_tools",
  "mcp_tool",
  "list_mcp_resources",
  "read_mcp_resource",
  "knowledge_base",
  "fetch_pull_request",
  "reflect",
])

function parseToolInputJson(inputJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(inputJson || "{}")
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return { _value: parsed }
}

/** Filter the universal sub-agent surface down to the inline-only set
 * — applied AFTER the per-agent tools/disallowedTools resolution so an
 * agent's frontmatter still narrows further. */
export function clampToBackgroundInlineSurface(
  toolNames: readonly string[]
): string[] {
  return toolNames.filter((name) => BACKGROUND_INLINE_ONLY_TOOLS.has(name))
}

/** Subset of dependencies the worker needs from
 * `CursorConnectStreamService`. We use a structural interface instead
 * of importing the full service so the cyclic graph stays sane. */
export interface BackgroundWorkerHostDeps {
  logger: Logger
  /** Run a bridge-local / inline deferred tool exactly like the foreground sub-agent
   * does. Returns the formatted text content the worker writes back to
   * its message history. */
  runInlineDeferredTool(
    conversationId: string,
    toolName: string,
    parsedInput: Record<string, unknown>
  ): Promise<{ content: string; status: "success" | "error" }>
  /** Run one LLM turn for the sub-agent and return the final assistant
   * text + tool calls. Worker drives the loop; host owns the actual
   * backend stream invocation so we re-use the existing
   * Kiro/Codex/Anthropic/Google routing.
   *
   * `toolNames` is the user-facing inline tool surface (e.g.
   * "semantic_search", "web_fetch") — host is responsible for
   * converting these into proper ToolDefinition[] via buildToolsForApi
   * so backend schema validation passes. We don't pre-build them in the
   * worker because the worker doesn't have the per-session MCP defs /
   * backend selection. */
  runSubAgentLlmTurn(
    conversationId: string,
    ctx: {
      subagentId: string
      messages: Array<{ role: "user" | "assistant"; content: unknown }>
      model: string
      toolNames: string[]
      abortSignal: AbortSignal
      /**
       * When true, the host strips tool definitions from the DTO and
       * swaps the system addendum for a synthesis-only prompt. Used by
       * the worker on its very last turn (after MAX_TURNS) to force the
       * LLM to produce a final answer instead of another tool_use.
       * See foreground sub-agent loop for the matching foreground path.
       */
      forceFinalSynthesis?: boolean
    }
  ): Promise<{
    fullText: string
    toolCalls: Array<{ id: string; name: string; inputJson: string }>
    error?: string
  }>
  /** Build a ConversationStep wrapping an assistant text reply. Host
   * delegates to `cursor-grpc.service.ts::buildAssistantConversationStep`
   * which returns a proto-typed object the worker stores opaquely. */
  buildAssistantStep(text: string): unknown
  /** Build a ConversationStep wrapping a sub-agent tool call (with
   * args + result already encoded into the proto ToolCall envelope). */
  buildToolCallStep(args: {
    toolName: string
    callId: string
    parsedInput: Record<string, unknown>
    resultContent: string
  }): unknown
}

interface SpawnArgs {
  parentConversationId: string
  parentToolCallId: string
  description: string
  agent: SubagentDefinition
  model: string
  host: BackgroundWorkerHostDeps
}

@Injectable()
export class SubagentBackgroundWorker {
  private readonly logger = new Logger(SubagentBackgroundWorker.name)

  constructor(private readonly transcriptStore: SubagentTranscriptStore) {}

  /**
   * Spawn a new background sub-agent. Returns the agentId and a
   * promise that resolves when the worker finishes (clean or aborted).
   * The caller (`task` dispatcher) is expected to register both with
   * the SubagentTaskRegistry and immediately settle the parent task
   * tool with `taskSuccess { agentId, isBackground: true }`.
   */
  spawn(args: SpawnArgs): {
    agentId: string
    abortController: AbortController
    donePromise: Promise<void>
    metadata: SubagentTaskMetadata
  } {
    const agentId = `subagent-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    const abortController = new AbortController()
    const startedAt = Date.now()

    // Resolve tool surface: per-agent allowlist/disallowlist first,
    // then clamp to inline-only families because background workers
    // have no BiDi stream for ExecServerMessage round-trips.
    const surface = resolveSubagentToolSurface(args.agent)
    const inlineToolNames = clampToBackgroundInlineSurface(surface.toolNames)

    const initialMetadata: SubagentTaskMetadata = {
      agentId,
      agentType: args.agent.agentType,
      parentToolCallId: args.parentToolCallId,
      parentConversationId: args.parentConversationId,
      status: "running",
      startedAt,
      turnCount: 0,
      toolCallCount: 0,
      modifiedFiles: [],
    }

    this.logger.log(
      `[BackgroundSubAgent] Spawning ${agentId} (agentType=${args.agent.agentType}, ` +
        `tools=${inlineToolNames.length}, model=${args.model})`
    )

    const donePromise = this.runWorkerLoop({
      agentId,
      abortController,
      args,
      inlineToolNames,
    }).catch((error) => {
      // runWorkerLoop should not throw — it always lands in finally
      // and writes terminal metadata. Any escape here is a bug.
      this.logger.error(
        `[BackgroundSubAgent] ${agentId} worker loop escaped with error: ${String(error)}`
      )
    })

    return {
      agentId,
      abortController,
      donePromise,
      metadata: initialMetadata,
    }
  }

  private async runWorkerLoop(opts: {
    agentId: string
    abortController: AbortController
    args: SpawnArgs
    inlineToolNames: string[]
  }): Promise<void> {
    const { agentId, abortController, args, inlineToolNames } = opts
    const { agent } = args
    const startedAt = Date.now()

    const systemPrompt = getSubagentSystemPrompt(agent)
    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
      {
        role: "user",
        content: `${systemPrompt}\n\n--- TASK ---\n\n${args.description}`,
      },
    ]

    const MAX_TURNS = agent.maxTurns ?? 20
    let turnCount = 0
    let toolCallCount = 0
    let finalText = ""
    let terminalStatus: "completed" | "failed" | "killed" = "completed"
    let errorMessage: string | undefined
    /**
     * Accumulator for TaskSuccess.conversationSteps[]. Worker stores the
     * proto-typed step values as opaque blobs (host built them via
     * buildAssistantStep / buildToolCallStep) so external readers of
     * metadata.json see the same step layout the foreground sub-agent
     * would project into TaskSuccess.
     */
    const conversationSteps: unknown[] = []

    this.transcriptStore.appendTranscript(agentId, {
      ts: startedAt,
      kind: "turn_start",
      data: {
        turnIndex: 0,
        message: "background sub-agent worker starting",
      },
    })

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (abortController.signal.aborted) {
          terminalStatus = "killed"
          errorMessage = "aborted by registry"
          break
        }
        turnCount++
        this.transcriptStore.appendTranscript(agentId, {
          ts: Date.now(),
          kind: "turn_start",
          data: { turnIndex: turn + 1 },
        })

        // Re-resolve the tool list each turn so later iterations see
        // any state-mutating side-effects (e.g. todos changing). The
        // worker passes only tool NAMES — the host is responsible for
        // expanding them into real ToolDefinition[] (with schemas) via
        // buildToolsForApi when assembling the backend request. Worker
        // doesn't have access to per-session MCP defs / backend hints
        // so doing the expansion in the host keeps the call site happy.
        let llmResult: Awaited<
          ReturnType<BackgroundWorkerHostDeps["runSubAgentLlmTurn"]>
        >
        try {
          llmResult = await args.host.runSubAgentLlmTurn(
            args.parentConversationId,
            {
              subagentId: agentId,
              messages,
              model: args.model,
              toolNames: inlineToolNames,
              abortSignal: abortController.signal,
            }
          )
        } catch (error) {
          // If the abort signal fired DURING the LLM stream the host
          // re-throws — treat that as a clean kill rather than a
          // failure so the registry/UI can distinguish operator
          // intent from an upstream backend error.
          if (abortController.signal.aborted) {
            terminalStatus = "killed"
            errorMessage = "aborted by registry"
          } else {
            terminalStatus = "failed"
            errorMessage = `LLM stream error: ${String(error)}`
          }
          break
        }

        if (llmResult.error) {
          // Same distinction here: host returns `error: "aborted"` when
          // it observed our abortSignal flipping mid-stream. That's a
          // kill, not a failure.
          if (llmResult.error === "aborted" || abortController.signal.aborted) {
            terminalStatus = "killed"
            errorMessage = "aborted by registry"
          } else {
            terminalStatus = "failed"
            errorMessage = llmResult.error
          }
          break
        }

        finalText = llmResult.fullText

        // Record assistant text + tool_use blocks into the message
        // history exactly like the foreground worker does.
        const assistantContentParts: Array<Record<string, unknown>> = []
        if (finalText) {
          assistantContentParts.push({ type: "text", text: finalText })
          this.transcriptStore.appendTranscript(agentId, {
            ts: Date.now(),
            kind: "assistant_text",
            data: { text: finalText },
          })
          // ConversationStep accumulation: same shape as foreground
          // sub-agent so external `read_file` consumers see consistent
          // step lists in metadata.json.
          conversationSteps.push(args.host.buildAssistantStep(finalText))
        }
        for (const tc of llmResult.toolCalls) {
          let parsedInput: Record<string, unknown> = {}
          try {
            parsedInput = parseToolInputJson(tc.inputJson)
          } catch {
            parsedInput = { _raw: tc.inputJson }
          }
          assistantContentParts.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: parsedInput,
          })
        }
        if (assistantContentParts.length > 0) {
          messages.push({
            role: "assistant",
            content: assistantContentParts,
          })
        }

        // No tool calls → sub-agent is done.
        if (llmResult.toolCalls.length === 0) {
          break
        }

        // Dispatch each tool call. Background workers ONLY support
        // bridge-local / inline deferred tools; anything else gets a hard error in
        // the message history so the LLM stops looping on a
        // non-existent capability.
        toolCallCount += llmResult.toolCalls.length
        const toolResults: Array<Record<string, unknown>> = []
        for (const tc of llmResult.toolCalls) {
          if (abortController.signal.aborted) break
          let parsedInput: Record<string, unknown> = {}
          try {
            parsedInput = parseToolInputJson(tc.inputJson)
          } catch {
            parsedInput = { _raw: tc.inputJson }
          }
          this.transcriptStore.appendTranscript(agentId, {
            ts: Date.now(),
            kind: "tool_call_start",
            data: { id: tc.id, name: tc.name, input: parsedInput },
          })
          let resultContent: string
          let resultStatus: "success" | "error" = "success"
          if (BACKGROUND_INLINE_ONLY_TOOLS.has(tc.name)) {
            try {
              const result = await args.host.runInlineDeferredTool(
                args.parentConversationId,
                tc.name,
                parsedInput
              )
              resultContent = result.content
              resultStatus = result.status
            } catch (err) {
              resultStatus = "error"
              resultContent = `[tool error] ${String(err)}`
            }
          } else {
            resultStatus = "error"
            resultContent =
              `[tool error] Tool "${tc.name}" is not available to ` +
              `background sub-agents (no ExecServerMessage channel). ` +
              `Available background tools: ${[...BACKGROUND_INLINE_ONLY_TOOLS].join(", ")}.`
          }
          this.transcriptStore.appendTranscript(agentId, {
            ts: Date.now(),
            kind: "tool_call_end",
            data: {
              id: tc.id,
              name: tc.name,
              status: resultStatus,
              contentPreview: resultContent.slice(0, 1000),
            },
          })
          // ConversationStep accumulation for this tool invocation —
          // the host re-uses cursor-grpc.service's
          // buildToolCallConversationStep so background and foreground
          // sub-agents project structurally identical step blobs.
          conversationSteps.push(
            args.host.buildToolCallStep({
              toolName: tc.name,
              callId: tc.id,
              parsedInput,
              resultContent,
            })
          )
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: resultContent,
          })
        }
        messages.push({ role: "user", content: toolResults })
        this.transcriptStore.appendTranscript(agentId, {
          ts: Date.now(),
          kind: "turn_end",
          data: { turnIndex: turn + 1, toolCallCount: toolResults.length },
        })

        // Incremental metadata sync: write out turnCount /
        // toolCallCount / conversationSteps after every turn so an
        // external read_file metadata.json mid-run sees live progress
        // instead of the stale "running, 0 turns" snapshot from spawn.
        this.transcriptStore.updateMetadata(agentId, (current) => ({
          ...current,
          turnCount,
          toolCallCount,
          conversationSteps: [...conversationSteps],
        }))
      }

      if (turnCount >= MAX_TURNS && !errorMessage) {
        // Reached max turns. Run a final synthesis pass with no tools
        // so the LLM produces an actual answer instead of looping on
        // tool_use blocks the worker can no longer dispatch. Mirrors
        // the foreground sub-agent path in cursor-connect-stream.
        if (!abortController.signal.aborted) {
          this.logger.log(
            `[BackgroundSubAgent] ${agentId} reached MAX_TURNS=${MAX_TURNS}; ` +
              `running final synthesis turn (no tools)`
          )
          messages.push({
            role: "user",
            content:
              "You have reached your turn limit. Stop calling tools. " +
              "Using only the tool_results already in this conversation, " +
              "write a single final assistant message that synthesizes " +
              "your findings into a clear answer. This is your last turn.",
          })
          this.transcriptStore.appendTranscript(agentId, {
            ts: Date.now(),
            kind: "turn_start",
            data: {
              turnIndex: turnCount + 1,
              message: "synthesis turn (max turns reached)",
            },
          })
          try {
            const synthesisResult = await args.host.runSubAgentLlmTurn(
              args.parentConversationId,
              {
                subagentId: agentId,
                messages,
                model: args.model,
                toolNames: inlineToolNames,
                abortSignal: abortController.signal,
                forceFinalSynthesis: true,
              }
            )
            if (!synthesisResult.error) {
              const synthText = synthesisResult.fullText.trim()
              if (synthText.length > 0) {
                finalText = synthesisResult.fullText
                messages.push({
                  role: "assistant",
                  content: synthesisResult.fullText,
                })
                this.transcriptStore.appendTranscript(agentId, {
                  ts: Date.now(),
                  kind: "assistant_text",
                  data: { text: synthesisResult.fullText },
                })
                conversationSteps.push(
                  args.host.buildAssistantStep(synthesisResult.fullText)
                )
              }
            } else if (
              synthesisResult.error === "aborted" ||
              abortController.signal.aborted
            ) {
              terminalStatus = "killed"
              errorMessage = "aborted by registry"
            } else {
              this.logger.warn(
                `[BackgroundSubAgent] ${agentId} synthesis turn LLM error: ` +
                  synthesisResult.error
              )
            }
          } catch (synthesisErr) {
            this.logger.warn(
              `[BackgroundSubAgent] ${agentId} synthesis turn threw: ` +
                String(synthesisErr)
            )
          }
        }

        if (!finalText) {
          finalText =
            "[background sub-agent reached max turns without final answer]"
        }
      }
    } catch (error) {
      terminalStatus = "failed"
      errorMessage = String(error)
    } finally {
      const completedAt = Date.now()
      this.transcriptStore.writeResult(agentId, finalText)
      this.transcriptStore.updateMetadata(agentId, (current) => ({
        ...current,
        status: terminalStatus,
        completedAt,
        durationMs: completedAt - startedAt,
        turnCount,
        toolCallCount,
        finalText,
        errorMessage,
        conversationSteps: [...conversationSteps],
      }))
      this.transcriptStore.appendTranscript(agentId, {
        ts: completedAt,
        kind: terminalStatus === "completed" ? "completed" : terminalStatus,
        data: {
          durationMs: completedAt - startedAt,
          turnCount,
          toolCallCount,
          errorMessage,
        },
      })
      this.logger.log(
        `[BackgroundSubAgent] ${agentId} ${terminalStatus} ` +
          `(${turnCount} turns, ${toolCallCount} tool calls, ` +
          `${completedAt - startedAt}ms)`
      )
    }
  }
}

/** Surface the inline-only set as well so callers can include it in
 * task tool prompts. */
export { BACKGROUND_INLINE_ONLY_TOOLS }

/** Convenience: build the inline tool list a background sub-agent
 * actually receives, applied as a sanity check. */
export function buildBackgroundToolNames(agent: SubagentDefinition): string[] {
  return clampToBackgroundInlineSurface(
    resolveSubagentToolSurface(agent).toolNames
  ).filter((name) => SUB_AGENT_SAFE_TOOL_NAMES.includes(name))
}
