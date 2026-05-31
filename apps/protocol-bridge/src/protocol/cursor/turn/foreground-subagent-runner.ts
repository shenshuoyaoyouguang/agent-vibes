import { Logger } from "@nestjs/common"
import type { TurnHandle } from "./turn-handle"
import type { TurnRunner } from "./turn-runner"
import type { TurnTerminalResult } from "./turn.types"

/**
 * Hooks supplied by the integration layer for executing a foreground
 * (parent-blocking) sub-agent. Mirrors `ParentTurnHooks` but with
 * different commit semantics: a foreground subagent's transcript is
 * appended to its parent's staging area, NOT to its own. The
 * supervisor wires this via the parent's TranscriptStore staging
 * key.
 */
export interface ForegroundSubagentHooks<PreparedContext, BackendEvent> {
  prepareContext(handle: TurnHandle): Promise<PreparedContext>
  callBackend(
    handle: TurnHandle,
    prepared: PreparedContext
  ): Promise<AsyncIterable<BackendEvent>>
  onBackendEvent(
    handle: TurnHandle,
    event: BackendEvent
  ): Promise<{
    streamComplete: boolean
    subagentToolUses?: ParsedSubagentToolUse[]
  }>
  /**
   * Foreground subagents can themselves call tools. Dispatch fires
   * synchronously and contributes inline tool_results to the
   * parent's outbound (writer-stack: subagent is on top while
   * writing).
   */
  dispatchTools(
    handle: TurnHandle,
    toolUses: ParsedSubagentToolUse[]
  ): Promise<DispatchOutcome>
  /**
   * Append the subagent's final synthesis to the parent's staging
   * area. The subagent does NOT commit on its own — its output is
   * data the parent uses.
   */
  finalize(handle: TurnHandle): Promise<{ resultText: string }>
}

export interface ParsedSubagentToolUse {
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: unknown
}

export type DispatchOutcome =
  | { kind: "continue"; resumePrepared: unknown }
  | { kind: "terminal" }

/**
 * Foreground subagent runner. Spawned by the parent's tool-dispatch
 * step under `parentTurnId = parent.turnId`, so:
 *
 *   - it shares the parent's outbound (writer stack on push)
 *   - it inherits the parent's abort scope (parent cancel → child cancel)
 *   - its terminal result is awaited inline before the parent moves on
 *
 * Background subagents (the `task` tool with `run_in_background:
 * true`) use BackgroundJobRegistry instead, see Phase G.
 */
export class ForegroundSubagentRunner<
  PreparedContext,
  BackendEvent,
> implements TurnRunner {
  private readonly logger = new Logger(ForegroundSubagentRunner.name)
  readonly displayName: string
  private readonly hooks: ForegroundSubagentHooks<PreparedContext, BackendEvent>
  private finalText = ""

  constructor(args: {
    subagentName: string
    hooks: ForegroundSubagentHooks<PreparedContext, BackendEvent>
  }) {
    this.displayName = `foreground-subagent:${args.subagentName}`
    this.hooks = args.hooks
  }

  async run(handle: TurnHandle): Promise<TurnTerminalResult> {
    try {
      handle.recordPhase("preparing-context")
      let prepared: PreparedContext = await this.hooks.prepareContext(handle)
      this.bailIfCancelled(handle)
      while (true) {
        handle.recordPhase("calling-backend")
        const stream = await this.hooks.callBackend(handle, prepared)
        this.bailIfCancelled(handle)
        let toolUses: ParsedSubagentToolUse[] = []
        let complete = false
        handle.recordPhase("streaming-content")
        for await (const evt of stream) {
          this.bailIfCancelled(handle)
          const r = await this.hooks.onBackendEvent(handle, evt)
          if (r.subagentToolUses?.length)
            toolUses = toolUses.concat(r.subagentToolUses)
          if (r.streamComplete) {
            complete = true
            break
          }
        }
        if (toolUses.length === 0 && complete) break
        handle.recordPhase("dispatching-tools")
        const outcome = await this.hooks.dispatchTools(handle, toolUses)
        this.bailIfCancelled(handle)
        if (outcome.kind === "terminal") break
        prepared = outcome.resumePrepared as PreparedContext
        handle.recordPhase("awaiting-tool-results")
      }
      handle.recordPhase("committing")
      const final = await this.hooks.finalize(handle)
      this.finalText = final.resultText
      handle.recordPhase("terminal")
      return {
        status: "completed",
        summary: this.finalText.substring(0, 200),
      }
    } catch (err) {
      const reason = handle.cancellationReason()
      if (reason) return { status: "cancelled", reason }
      const e = err instanceof Error ? err : new Error(String(err))
      this.logger.error(
        `foreground-subagent error turn=${handle.turnId}: ${e.message}`
      )
      return { status: "failed", error: e }
    }
  }

  /** Read by the parent runner after `awaitTerminal`. */
  resultText(): string {
    return this.finalText
  }

  private bailIfCancelled(handle: TurnHandle): void {
    if (handle.signal.aborted) {
      throw new Error("subagent cancelled")
    }
  }
}
