import { Injectable, Logger } from "@nestjs/common"
import { CompactWarningStateService } from "./compact-warning-state.service"
import { ContextCollapseService } from "./context-collapse.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextConversationState } from "./types"

/**
 * Aggregate post-compaction cleanup — bridge port of cc's
 * `services/compact/postCompactCleanup.ts`.
 *
 * Phases (executed in order; each phase is best-effort and a throw in
 * one does not skip later phases):
 *
 *   1. Reset `toolResultReplacementState` — the post-microcompact
 *      buffer is invalid once the boundary moves.
 *   2. Reset `investigationMemory` — the investigation buffer is
 *      summarized into the boundary record itself, so the live
 *      mirror gets cleared.
 *   4. `contextCollapse.reset(state)` — full compaction supersedes the
 *      read-time collapse commit log, matching Claude Code's
 *      post-compact reset behavior.
 *   5. `compactWarningState.clearCompactWarningSuppression(state)` —
 *      idempotent backstop: the next ensureWithinBudget entry will
 *      clear again, but doing it here means a caller that compacts
 *      out-of-band still gets a clean slate.
 *   6. PromptCacheBreak `notifyCompaction` callback — drops the
 *      cache_read baseline so the next response is treated as a
 *      fresh comparison point. Wired via callback from the caller
 *      (typically cursor-connect-stream) so the context module does
 *      not depend on the anthropic-api module.
 *   7. Run any callbacks registered via `registerCleanup(conversationId, cb)`.
 *      Used by sub-agent / extension code that needs to learn about
 *      compactions out-of-band.
 *   8. Emit `compaction.post_cleanup` telemetry.
 *
 * Lifetime / state:
 *   - `callbacksByConversation` is service-level, keyed by
 *     conversationId. SessionLifecycleService.removeSession should call
 *     `clearCallbacks(conversationId)` (or the registered handles
 *     should self-deregister) to avoid leaks.
 */
@Injectable()
export class PostCompactCleanupService {
  private readonly logger = new Logger(PostCompactCleanupService.name)
  private readonly callbacksByConversation = new Map<
    string,
    Array<() => void>
  >()

  constructor(
    private readonly contextCollapse: ContextCollapseService,
    private readonly compactWarningState: CompactWarningStateService,
    private readonly telemetry: ContextTelemetryService
  ) {}

  /**
   * Register a per-conversation cleanup callback. Returns an
   * unregister function the caller should invoke when the registered
   * lifetime ends (e.g., sub-agent done, SessionRecord disposed).
   */
  registerCleanup(conversationId: string, cb: () => void): () => void {
    if (!conversationId || typeof cb !== "function") return () => undefined
    const arr = this.callbacksByConversation.get(conversationId) ?? []
    arr.push(cb)
    this.callbacksByConversation.set(conversationId, arr)
    return () => {
      const list = this.callbacksByConversation.get(conversationId)
      if (!list) return
      const idx = list.indexOf(cb)
      if (idx >= 0) list.splice(idx, 1)
      if (list.length === 0) this.callbacksByConversation.delete(conversationId)
    }
  }

  /** Invoked by SessionLifecycleService.removeSession when a session goes away. */
  clearCallbacks(conversationId: string): void {
    if (!conversationId) return
    this.callbacksByConversation.delete(conversationId)
  }

  /**
   * Run all post-compaction cleanup phases for a single state. Every
   * phase is wrapped in try/catch — telemetry / hook failures must
   * not break the compaction commit that just happened.
   */
  run(
    state: ContextConversationState,
    opts: {
      conversationId?: string
      sessionId?: string
      agentId?: string
      querySource?: string
      /**
       * Callback wired by the caller to dispatch into
       * PromptCacheBreakDetectionService.notifyCompaction. Avoids the
       * direct context → anthropic dependency.
       */
      notifyPromptCacheCompaction?: () => void
    } = {}
  ): void {
    // Phase 1
    try {
      if (state.toolResultReplacementState) {
        state.toolResultReplacementState = {
          seenToolUseIds: [],
          replacementByToolUseId: {},
          storedByToolUseId: {},
          records: [],
        }
      }
    } catch (error) {
      this.logger.warn(
        `Phase 1 reset toolResultReplacementState failed: ${String(error)}`
      )
    }

    // Phase 2
    try {
      if (state.investigationMemory.length > 0) {
        state.investigationMemory = []
      }
    } catch (error) {
      this.logger.warn(
        `Phase 2 reset investigationMemory failed: ${String(error)}`
      )
    }

    // Phase 4
    try {
      this.contextCollapse.reset(state)
    } catch (error) {
      this.logger.warn(`Phase 4 contextCollapse.reset failed: ${String(error)}`)
    }

    // Phase 5
    try {
      this.compactWarningState.clearCompactWarningSuppression(state)
    } catch (error) {
      this.logger.warn(
        `Phase 5 clearCompactWarningSuppression failed: ${String(error)}`
      )
    }

    // Phase 6 (delegated to caller — see notifyPromptCacheCompaction docstring)
    if (opts.notifyPromptCacheCompaction) {
      try {
        opts.notifyPromptCacheCompaction()
      } catch (error) {
        this.logger.warn(
          `Phase 6 notifyPromptCacheCompaction failed: ${String(error)}`
        )
      }
    }

    // Phase 7
    if (opts.conversationId) {
      const callbacks = this.callbacksByConversation.get(opts.conversationId)
      if (callbacks) {
        for (const cb of callbacks) {
          try {
            cb()
          } catch (error) {
            this.logger.warn(
              `Phase 7 cleanup callback threw (continuing): ${String(error)}`
            )
          }
        }
      }
    }

    // Phase 8
    try {
      this.telemetry.recordEvent({
        event: "compaction.post_cleanup",
        scope: opts.sessionId ?? opts.conversationId ?? "global",
        metadata: {
          agentId: opts.agentId ?? "",
          querySource: opts.querySource ?? "",
        },
      })
    } catch {
      // ignore — counter map errors are not actionable
    }
  }
}
