/**
 * In-memory registry of in-flight background sub-agent tasks.
 *
 * Mirrors claude-code's `~/.claude/sub-agents/` registry but slimmer —
 * the bridge process is single-host so we don't need cross-process
 * coordination. The registry's purpose:
 *
 *   - Lets `task` tool dispatcher know an `agentId` is currently running
 *     so duplicate spawns / status queries don't race.
 *   - Holds the AbortController used to kill a running background
 *     sub-agent (e.g. when the parent conversation is closed).
 *   - Survives across BiDi streams within the same bridge process so a
 *     parent agent that spawned a background sub-agent in turn N can
 *     still query its status from turn N+1.
 *
 * Persistent state (transcript / metadata / final result) lives in
 * `SubagentTranscriptStore` on disk. The registry only owns the
 * runtime handles.
 */

import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common"

import {
  SubagentTaskMetadata,
  SubagentTaskStatus,
  SubagentTranscriptStore,
} from "./subagent-transcript-store.service"

interface BackgroundTaskHandle {
  agentId: string
  parentConversationId: string
  abortController: AbortController
  /** Promise that resolves when the worker exits (success / fail /
   * killed). Callers can `await` it to block on completion without
   * polling metadata. */
  donePromise: Promise<void>
  startedAt: number
}

@Injectable()
export class SubagentTaskRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(SubagentTaskRegistry.name)
  private readonly handles = new Map<string, BackgroundTaskHandle>()

  constructor(private readonly transcriptStore: SubagentTranscriptStore) {}

  onModuleDestroy(): void {
    // Best-effort kill of every still-running background sub-agent on
    // bridge shutdown. The transcript store still has the partial
    // record for inspection.
    for (const [agentId, handle] of this.handles) {
      try {
        handle.abortController.abort()
      } catch (error) {
        this.logger.warn(
          `Abort failed for background sub-agent ${agentId} on shutdown: ${String(error)}`
        )
      }
    }
    this.handles.clear()
  }

  /**
   * Register a freshly spawned background sub-agent. Persists initial
   * metadata to disk so external readers can see the task immediately.
   */
  register(handle: BackgroundTaskHandle, metadata: SubagentTaskMetadata): void {
    this.handles.set(handle.agentId, handle)
    this.transcriptStore.initMetadata(metadata)
    // When the worker finishes (cleanly or via abort), evict the runtime
    // handle. Metadata file remains on disk for status queries.
    handle.donePromise
      .catch((error) => {
        this.logger.warn(
          `Background sub-agent ${handle.agentId} done-promise rejected: ${String(error)}`
        )
      })
      .finally(() => {
        this.handles.delete(handle.agentId)
      })
  }

  /** Whether a runtime handle exists. False does NOT mean the task
   * doesn't exist — it may have completed; check metadata on disk. */
  isRunning(agentId: string): boolean {
    return this.handles.has(agentId)
  }

  /** Return current status: prefer the in-memory registry (most recent
   * truth) and fall back to on-disk metadata. */
  getStatus(agentId: string): SubagentTaskStatus | undefined {
    if (this.handles.has(agentId)) {
      return "running"
    }
    return this.transcriptStore.readMetadata(agentId)?.status
  }

  /** Read the full metadata snapshot for a task. */
  getMetadata(agentId: string): SubagentTaskMetadata | undefined {
    return this.transcriptStore.readMetadata(agentId)
  }

  /** Abort a running background sub-agent. Returns true when a runtime
   * handle was found and aborted, false when the task is not running
   * (already completed / never registered). */
  kill(agentId: string, reason = "external kill"): boolean {
    const handle = this.handles.get(agentId)
    if (!handle) return false
    try {
      handle.abortController.abort()
    } catch (error) {
      this.logger.warn(
        `Abort failed for background sub-agent ${agentId} (${reason}): ${String(error)}`
      )
    }
    return true
  }

  /** Get the AbortSignal for a running task — used by the worker
   * itself to bail out of long awaits. */
  getAbortSignal(agentId: string): AbortSignal | undefined {
    return this.handles.get(agentId)?.abortController.signal
  }

  /** Iterate runtime handles for diagnostic / status-query tools. */
  listRunning(): Array<{
    agentId: string
    parentConversationId: string
    startedAt: number
  }> {
    return Array.from(this.handles.values()).map((h) => ({
      agentId: h.agentId,
      parentConversationId: h.parentConversationId,
      startedAt: h.startedAt,
    }))
  }

  /**
   * Promise that resolves when a running background sub-agent finishes
   * (success / failure / killed). Resolves immediately when the agent is
   * already terminal. Used by the `await_task` / `wait_agent` tool to
   * block the parent agent's LLM turn on real completion instead of
   * polling the metadata file.
   */
  awaitDone(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId)
    if (!handle) return Promise.resolve()
    return handle.donePromise
  }
}
