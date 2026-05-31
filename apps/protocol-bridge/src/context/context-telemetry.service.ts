import { Injectable, Logger } from "@nestjs/common"

/**
 * Lightweight in-memory counter store for context-management events.
 *
 * The counts are intentionally cumulative across the bridge's lifetime so a
 * Dashboard / Diagnostics tab can show high-water marks without needing a
 * real metrics backend.  All emit calls are best-effort and never throw —
 * telemetry failures must never affect the primary request path.
 *
 * The service is deliberately stateless beyond the counter map.  If we ever
 * need a richer story (per-conversation breakdown, time-series export, etc.)
 * we can wrap an actual metrics SDK behind the same emit calls.
 */
export type ContextTelemetryEvent =
  // Compaction / projection signals
  | "compaction.boundary_applied"
  | "compaction.snip_applied"
  | "compaction.microcompact_preflight"
  | "compaction.microcompact_reactive"
  | "compaction.microcompact_idle"
  | "compaction.microcompact_skipped_cached"
  | "compaction.auto_compact_limit_reached"
  | "compaction.predictive_limit_reached"
  | "compaction.replacement_state_pruned"
  | "compaction.session_memory_updated"
  | "compaction.archived_records_pruned"
  | "compaction.native_cache_edits_inserted"
  | "compaction.native_cache_edit_state_pruned"
  | "compaction.projection_budget_exceeded"
  | "compaction.cross_process_restart_recovery"
  | "compaction.in_process_turn_repair"
  | "compaction.stream_interruption_tool_repair"
  | "compaction.parent_cancel_tool_repair"
  // Reactive prompt-too-long recovery
  | "reactive.recovery_attempted"
  | "reactive.recovery_success"
  | "reactive.recovery_skipped_circuit_open"
  | "reactive.recovery_skipped_no_progress"
  // Tool integrity repairs (read-time safety net)
  | "integrity.orphan_tool_result_removed"
  | "integrity.synthetic_tool_result_injected"
  // Prompt-cache break attribution (cc parity)
  | "prompt_cache.break"
  // Predictive compaction warning (cc parity: TokenWarning hook)
  | "compaction.warning_imminent"
  // Aggregate post-compaction cleanup completion
  | "compaction.post_cleanup"
  // ToolUseSummary generator (cc parity)
  | "tool_use.summary"
  // Reasoning continuity (cross-turn thinking memory)
  | "reasoning_memory.append"
  | "reasoning_memory.invalidated"
  | "reasoning_memory.cleared"
  | "reasoning_memory.dropped"
  | "reasoning_memory.preamble_built"
  | "reasoning_memory.preamble_skipped"
  | "reasoning_memory.consolidated"
  // Backend capability drift (declared vs observed wire behavior)
  | "backend_capability.thinking_disabled_violation"

export interface ContextTelemetryEventDetail {
  event: ContextTelemetryEvent
  /** Stable session / recovery key when known; falls back to `"global"`. */
  scope?: string
  /** Increment value; defaults to 1. */
  delta?: number
  /** Optional structured metadata for diagnostics; never logged at info. */
  metadata?: Record<string, number | string | boolean>
}

@Injectable()
export class ContextTelemetryService {
  private readonly logger = new Logger(ContextTelemetryService.name)
  private readonly counters = new Map<string, number>()

  /**
   * Record a single occurrence.  Returns the new cumulative count for the
   * (event, scope) pair.  Failures are swallowed because telemetry must
   * never propagate into the request hot path.
   */
  recordEvent(detail: ContextTelemetryEventDetail): number {
    try {
      const scope = detail.scope || "global"
      const delta =
        detail.delta && Number.isFinite(detail.delta) ? detail.delta : 1
      const key = `${detail.event}::${scope}`
      const next = (this.counters.get(key) ?? 0) + delta
      this.counters.set(key, next)
      if (detail.metadata) {
        this.logger.debug(
          `${detail.event} scope=${scope} delta=${delta} ${JSON.stringify(
            detail.metadata
          )}`
        )
      } else {
        this.logger.debug(`${detail.event} scope=${scope} delta=${delta}`)
      }
      return next
    } catch (error) {
      this.logger.warn(`Failed to record context telemetry: ${String(error)}`)
      return 0
    }
  }

  /**
   * Snapshot the current counter table for diagnostics export.  The map is
   * keyed `${event}::${scope}` to keep the structure flat — callers can
   * split on `::` to regroup by event or scope.
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters)
  }

  /** Reset everything (used by tests). */
  reset(): void {
    this.counters.clear()
  }
}
