import { Injectable, Logger } from "@nestjs/common"
import type { ConversationId } from "../turn/turn.types"

/**
 * Identifier for a background job. A background job is conceptually
 * a TurnRunner that does not have a BiDi outbound — it writes its
 * results to disk and notifies the registry on completion.
 *
 * Branded primitive for the same reason TurnId is branded.
 */
declare const __backgroundJobIdBrand: unique symbol
export type BackgroundJobId = string & {
  readonly [__backgroundJobIdBrand]: "BackgroundJobId"
}
export const BackgroundJobId = {
  of(raw: string): BackgroundJobId {
    return raw as BackgroundJobId
  },
  generate(): BackgroundJobId {
    return crypto.randomUUID() as BackgroundJobId
  },
}

export type BackgroundJobStatus =
  | { kind: "running" }
  | { kind: "completed"; resultText: string }
  | { kind: "failed"; error: Error }
  | { kind: "cancelled"; reason: string }

export interface BackgroundJob {
  readonly id: BackgroundJobId
  readonly conversationId: ConversationId
  readonly subagentName: string
  readonly toolCallId: string
  readonly startedAt: number
  readonly status: BackgroundJobStatus
  readonly finishedAt?: number
  /**
   * Whether the registered "completion notice" — the synthetic
   * recovery frame the IDE consumes — has been delivered to the
   * IDE. The BidiStreamController flips this to `true` when it
   * emits a recovery turn carrying the result.
   */
  readonly notificationDelivered: boolean
}

/**
 * Per-conversation, in-memory ledger of every background subagent
 * the bridge has spawned. The registry is the seam between
 * `subagent-background-worker` (legacy, soon to be migrated) and the
 * new turn architecture: callers register a job, periodically update
 * its status, and on completion the registry emits an event that
 * BidiStreamController turns into a RecoveryRunner.
 *
 * Persistence is intentionally NOT wired here. The legacy worker
 * already persists its transcript and result.txt to disk; the
 * registry is RAM-only and gets repopulated by re-loading any
 * still-running jobs at process start (job recovery is the
 * integration phase's responsibility).
 */
@Injectable()
export class BackgroundJobRegistry {
  private readonly logger = new Logger(BackgroundJobRegistry.name)
  private readonly byId = new Map<BackgroundJobId, BackgroundJob>()
  private readonly byConversation = new Map<
    ConversationId,
    Set<BackgroundJobId>
  >()
  private observers: Array<(job: BackgroundJob) => void> = []

  register(args: {
    conversationId: ConversationId
    subagentName: string
    toolCallId: string
  }): BackgroundJobId {
    const id = BackgroundJobId.generate()
    const job: BackgroundJob = {
      id,
      conversationId: args.conversationId,
      subagentName: args.subagentName,
      toolCallId: args.toolCallId,
      startedAt: Date.now(),
      status: { kind: "running" },
      notificationDelivered: false,
    }
    this.byId.set(id, job)
    let set = this.byConversation.get(args.conversationId)
    if (!set) {
      set = new Set()
      this.byConversation.set(args.conversationId, set)
    }
    set.add(id)
    return id
  }

  /**
   * Mark a job complete. Fires every observer registered via
   * `addCompletionObserver`. Idempotent: a second complete call
   * with a different status is ignored.
   */
  complete(id: BackgroundJobId, resultText: string): void {
    this.transition(id, {
      kind: "completed",
      resultText,
    })
  }
  fail(id: BackgroundJobId, error: Error): void {
    this.transition(id, { kind: "failed", error })
  }
  cancel(id: BackgroundJobId, reason: string): void {
    this.transition(id, { kind: "cancelled", reason })
  }

  private transition(id: BackgroundJobId, status: BackgroundJobStatus): void {
    const existing = this.byId.get(id)
    if (!existing) {
      this.logger.warn(`transition for unknown job ${id}`)
      return
    }
    if (existing.status.kind !== "running") {
      // Already terminal; ignore.
      return
    }
    const next: BackgroundJob = {
      ...existing,
      status,
      finishedAt: Date.now(),
    }
    this.byId.set(id, next)
    for (const o of this.observers) {
      try {
        o(next)
      } catch (err) {
        this.logger.warn(
          `completion observer threw for job=${id}: ${(err as Error).message}`
        )
      }
    }
  }

  /**
   * Mark a job's completion notification as delivered. Used by the
   * BidiStreamController after it has emitted a RecoveryRunner
   * carrying the job's result.
   */
  markNotificationDelivered(id: BackgroundJobId): void {
    const j = this.byId.get(id)
    if (!j) return
    this.byId.set(id, { ...j, notificationDelivered: true })
  }

  get(id: BackgroundJobId): BackgroundJob | undefined {
    return this.byId.get(id)
  }

  /**
   * List jobs for a conversation that have terminated but whose
   * completion notice has not yet been delivered. The BidiStreamController
   * consults this when a new BiDi attaches so the IDE learns about
   * background work that completed between sessions.
   */
  pendingDeliveriesFor(conversationId: ConversationId): BackgroundJob[] {
    const ids = this.byConversation.get(conversationId)
    if (!ids) return []
    const out: BackgroundJob[] = []
    for (const id of ids) {
      const j = this.byId.get(id)
      if (j && j.status.kind !== "running" && !j.notificationDelivered) {
        out.push(j)
      }
    }
    return out
  }

  /**
   * Observe terminal transitions. The integration layer hooks this
   * to enqueue a RecoveryRunner if the conversation's BiDi is
   * currently attached, otherwise leaves the job marked
   * undelivered.
   */
  addCompletionObserver(fn: (job: BackgroundJob) => void): () => void {
    this.observers.push(fn)
    return () => {
      this.observers = this.observers.filter((x) => x !== fn)
    }
  }

  /**
   * Drop completed-and-delivered jobs older than the supplied
   * cutoff. Returns the number of jobs evicted. The integration
   * layer typically calls this on a 24h timer.
   */
  evict(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs
    let evicted = 0
    for (const [id, job] of this.byId) {
      if (
        job.status.kind !== "running" &&
        job.notificationDelivered &&
        job.finishedAt !== undefined &&
        job.finishedAt < cutoff
      ) {
        this.byId.delete(id)
        const set = this.byConversation.get(job.conversationId)
        set?.delete(id)
        if (set && set.size === 0) {
          this.byConversation.delete(job.conversationId)
        }
        evicted += 1
      }
    }
    return evicted
  }

  size(): number {
    return this.byId.size
  }

  /**
   * Diagnostics: list every running job. Used by health checks.
   */
  listRunning(): BackgroundJob[] {
    const out: BackgroundJob[] = []
    for (const j of this.byId.values()) {
      if (j.status.kind === "running") out.push(j)
    }
    return out
  }
}
