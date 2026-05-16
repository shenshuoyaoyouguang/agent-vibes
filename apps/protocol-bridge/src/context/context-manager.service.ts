import { Injectable, Logger } from "@nestjs/common"
import { randomUUID } from "crypto"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  ContextCompactionResult,
  ContextCompactionService,
} from "./context-compaction.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"
import {
  ContextConversationState,
  ContextUsageSnapshot,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"

/**
 * Maximum number of consecutive reactive recoveries we tolerate before the
 * circuit breaker opens for a given session.  Mirrors claude-code's
 * MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3.  Once the breaker opens the
 * caller is expected to surface the upstream error to the client instead of
 * looping forever.
 */
const MAX_CONSECUTIVE_REACTIVE_FAILURES = 3

/**
 * After this many milliseconds with no recoveries the failure counter for a
 * given key is forgotten.  Prevents long-lived sessions from accumulating
 * stale state while still catching tight retry loops.
 */
const REACTIVE_FAILURE_TTL_MS = 5 * 60_000

interface ReactiveFailureRecord {
  failures: number
  lastFailureAt: number
}

export interface ReactiveRecoveryRequest {
  /** Upstream-reported actual prompt size, when known. */
  actualTokens?: number
  /** Upstream-reported context-window cap, when known. */
  maxTokens?: number
  /**
   * Aggressiveness of the recovery.  `incremental` shaves a single budget
   * margin per call (default), `aggressive` halves the available budget so
   * recurring failures can converge on a tiny safe payload.
   */
  strategy?: "incremental" | "aggressive"
}

export interface ReactiveRecoveryOutcome {
  /** Whether the caller should retry the request with the new messages. */
  shouldRetry: boolean
  /** Reason the recovery did not produce a retriable payload. */
  reason?:
    | "circuit_open"
    | "no_progress"
    | "no_messages"
    | "below_minimum_budget"
  /** Compaction result when shouldRetry is true. */
  result?: ContextCompactionResult
  /** Updated failure counter exposed to the caller for diagnostics. */
  consecutiveFailures: number
}

@Injectable()
export class ContextManagerService {
  private readonly logger = new Logger(ContextManagerService.name)
  private readonly reactiveFailures = new Map<string, ReactiveFailureRecord>()

  constructor(
    private readonly compaction: ContextCompactionService,
    private readonly usageLedger: ContextUsageLedgerService,
    private readonly tokenCounter: TokenCounterService,
    private readonly telemetry: ContextTelemetryService
  ) {}

  buildBackendMessages(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: "auto" | "manual" | "reactive"
    }
  ): ContextCompactionResult {
    return this.compaction.ensureWithinBudget(state, snapshot, options)
  }

  buildBackendMessagesFromMessages(
    messages: UnifiedMessage[],
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: "auto" | "manual" | "reactive"
    }
  ): ContextCompactionResult {
    return this.buildBackendMessages(
      this.createEphemeralState(messages),
      snapshot,
      options
    )
  }

  recordAssistantUsage(
    state: ContextConversationState,
    recordId: string | undefined,
    usage: ContextUsageSnapshot | undefined,
    options?: {
      promptTokenCount?: number
      recordedCompactionId?: string
      attachmentFingerprint?: string
      assistantMessage?: UnifiedMessage
    }
  ): void {
    if (!recordId || !usage) return
    const assistantMessageTokens = options?.assistantMessage
      ? this.tokenCounter.countMessages([options.assistantMessage])
      : 0
    this.usageLedger.recordResponseUsage(
      state,
      recordId,
      {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        outputTokens: usage.outputTokens,
      },
      {
        projectedTokenCount:
          options?.promptTokenCount != null
            ? options.promptTokenCount + assistantMessageTokens
            : undefined,
        recordedCompactionId: options?.recordedCompactionId,
        attachmentFingerprint: options?.attachmentFingerprint,
      }
    )
  }

  buildProjectionLedger(
    state: ContextConversationState,
    projectedMessages: ProjectedContextMessage[]
  ): {
    projectedTokenCount?: number
    recordedCompactionId?: string
    attachmentFingerprint?: string
  } {
    return this.usageLedger.buildProjectionLedger(state, projectedMessages)
  }

  countMessages(messages: UnifiedMessage[]): number {
    return this.tokenCounter.countMessages(messages)
  }

  /**
   * Reactively compact a conversation in response to an upstream
   * "prompt too long" failure and tell the caller whether it is safe to
   * retry the request.
   *
   * The function is designed for the common case where the bridge already
   * sent a request, the backend returned a 4xx/413/context-length error,
   * and we want to shrink the payload and try again without bothering the
   * end user.  Each call consumes one slot in a per-session circuit
   * breaker so that an irrecoverably oversized conversation cannot loop
   * forever — once `MAX_CONSECUTIVE_REACTIVE_FAILURES` failures have
   * occurred for the same `recoveryKey` within the TTL the breaker stays
   * open and the caller surfaces the original error to the client.
   *
   * The recovery picks a smaller `maxTokens` budget than the previous
   * request so the second attempt actually fits.  When the upstream
   * exposes the real cap (Google Cloud Code returns one) we honour it;
   * otherwise we apply a multiplicative shrink whose factor depends on
   * the chosen strategy.
   */
  applyReactivePromptTooLongRecovery(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    previousOptions: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
    },
    request: ReactiveRecoveryRequest,
    recoveryKey: string
  ): ReactiveRecoveryOutcome {
    const failureCount = this.recordReactiveFailure(recoveryKey)
    this.telemetry.recordEvent({
      event: "reactive.recovery_attempted",
      scope: recoveryKey,
      metadata: {
        failureCount,
        actualTokens: request.actualTokens ?? 0,
        upstreamMaxTokens: request.maxTokens ?? 0,
      },
    })
    if (failureCount > MAX_CONSECUTIVE_REACTIVE_FAILURES) {
      this.logger.warn(
        `Reactive recovery circuit open for ${recoveryKey} after ` +
          `${failureCount - 1} consecutive failures — refusing to retry.`
      )
      this.telemetry.recordEvent({
        event: "reactive.recovery_skipped_circuit_open",
        scope: recoveryKey,
      })
      return {
        shouldRetry: false,
        reason: "circuit_open",
        consecutiveFailures: failureCount - 1,
      }
    }

    if (state.records.length === 0) {
      return {
        shouldRetry: false,
        reason: "no_messages",
        consecutiveFailures: failureCount,
      }
    }

    const nextMaxTokens = this.resolveReactiveBudget(
      previousOptions.maxTokens,
      request
    )
    if (
      nextMaxTokens <=
      previousOptions.systemPromptTokens + this.MIN_REACTIVE_BUDGET
    ) {
      return {
        shouldRetry: false,
        reason: "below_minimum_budget",
        consecutiveFailures: failureCount,
      }
    }

    const result = this.compaction.ensureWithinBudget(state, snapshot, {
      maxTokens: nextMaxTokens,
      systemPromptTokens: previousOptions.systemPromptTokens,
      integrityMode: previousOptions.integrityMode,
      pendingToolUseIds: previousOptions.pendingToolUseIds,
      strategy: "reactive",
    })

    if (
      !result.wasCompacted &&
      !result.snipCompaction?.changed &&
      !result.microcompactCompaction?.changed &&
      result.estimatedTokens >= previousOptions.maxTokens
    ) {
      this.telemetry.recordEvent({
        event: "reactive.recovery_skipped_no_progress",
        scope: recoveryKey,
        metadata: {
          previousMaxTokens: previousOptions.maxTokens,
          attemptedMaxTokens: nextMaxTokens,
          estimatedTokens: result.estimatedTokens,
        },
      })
      return {
        shouldRetry: false,
        reason: "no_progress",
        consecutiveFailures: failureCount,
      }
    }

    this.logger.warn(
      `Reactive recovery for ${recoveryKey}: budget ${previousOptions.maxTokens} → ${nextMaxTokens}, ` +
        `estimated ${result.estimatedTokens} tokens, failures=${failureCount}`
    )
    this.telemetry.recordEvent({
      event: "reactive.recovery_success",
      scope: recoveryKey,
      metadata: {
        previousMaxTokens: previousOptions.maxTokens,
        nextMaxTokens,
        estimatedTokens: result.estimatedTokens,
        failureCount,
      },
    })
    return {
      shouldRetry: true,
      result,
      consecutiveFailures: failureCount,
    }
  }

  /**
   * Stateless variant of `applyReactivePromptTooLongRecovery` for entry
   * points that operate on raw message arrays (e.g. the Anthropic
   * `/v1/messages` proxy path).  Failures are still tracked by
   * `recoveryKey`, which the caller is expected to derive from a stable
   * request identity such as request id or message-array hash.
   */
  applyReactivePromptTooLongRecoveryFromMessages(
    messages: UnifiedMessage[],
    snapshot: ContextAttachmentSnapshot,
    previousOptions: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
    },
    request: ReactiveRecoveryRequest,
    recoveryKey: string
  ): ReactiveRecoveryOutcome {
    return this.applyReactivePromptTooLongRecovery(
      this.createEphemeralState(messages),
      snapshot,
      previousOptions,
      request,
      recoveryKey
    )
  }

  /**
   * Drop the failure counter for a recovery key once the request finally
   * succeeds.  Callers should invoke this after a successful response so
   * a future failure on the same session starts from a clean slate.
   */
  resetReactiveFailures(recoveryKey: string): void {
    this.reactiveFailures.delete(recoveryKey)
  }

  /**
   * Manual compaction entry point — surfaced for command-palette / dashboard
   * "compact now" actions and for diagnostics tooling.  Strategy is
   * deliberately fixed to `"manual"` so the resulting commit can be
   * distinguished from automatic ones in the compaction history.
   *
   * Behaviour mirrors `buildBackendMessages` but with a synthetic budget
   * pressure: callers that simply want to force a summary regardless of
   * the actual token count can pass a tiny `maxTokens` (e.g. 1024) and
   * rely on the compaction planner picking up the squeeze.
   */
  manualCompact(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
    }
  ): ContextCompactionResult {
    return this.compaction.ensureWithinBudget(state, snapshot, {
      ...options,
      strategy: "manual",
    })
  }

  private readonly MIN_REACTIVE_BUDGET = 256

  private resolveReactiveBudget(
    previousMaxTokens: number,
    request: ReactiveRecoveryRequest
  ): number {
    // When the upstream tells us its hard cap, honour it directly minus a
    // small headroom so client-side estimation drift doesn't immediately
    // re-trigger the same error.
    if (
      typeof request.maxTokens === "number" &&
      Number.isFinite(request.maxTokens) &&
      request.maxTokens > 0
    ) {
      const headroom = Math.max(2048, Math.floor(request.maxTokens * 0.04))
      return Math.max(
        this.MIN_REACTIVE_BUDGET,
        Math.min(previousMaxTokens, request.maxTokens - headroom)
      )
    }

    const factor = request.strategy === "aggressive" ? 0.5 : 0.75
    return Math.max(
      this.MIN_REACTIVE_BUDGET,
      Math.floor(previousMaxTokens * factor)
    )
  }

  private recordReactiveFailure(recoveryKey: string): number {
    const now = Date.now()
    const existing = this.reactiveFailures.get(recoveryKey)
    if (existing && now - existing.lastFailureAt < REACTIVE_FAILURE_TTL_MS) {
      existing.failures += 1
      existing.lastFailureAt = now
      return existing.failures
    }
    const fresh: ReactiveFailureRecord = { failures: 1, lastFailureAt: now }
    this.reactiveFailures.set(recoveryKey, fresh)
    return fresh.failures
  }

  private createEphemeralState(
    messages: UnifiedMessage[]
  ): ContextConversationState {
    const baseTimestamp = Date.now()

    return {
      records: messages.map((message, index) => ({
        id: randomUUID(),
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        createdAt: baseTimestamp + index,
      })),
      compactionHistory: [],
      activeCompactionId: undefined,
      compactionEpoch: 0,
      lastAppliedCompaction: undefined,
      usageLedger: {},
      toolResultReplacementState: {
        seenToolUseIds: [],
        replacementByToolUseId: {},
      },
      investigationMemory: [],
    }
  }
}
