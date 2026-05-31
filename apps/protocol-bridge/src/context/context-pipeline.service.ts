import { Injectable, Logger } from "@nestjs/common"

/**
 * Per-conversation mutation queue for context-state mutations
 * (compaction, collapse, projection rewrites). Ensures only one
 * mutation operates on a given conversation's `ContextConversationState`
 * at a time without holding a global lock.
 *
 * The queue itself never observes the AbortSignal — once enqueued, an
 * operation runs to completion or rejection. Cancellation is the
 * operation's responsibility: it must thread `signal` into every await
 * and short-circuit on abort. The queue does, however, refuse to
 * START a new operation whose signal is already aborted; that protects
 * the common race where a turn is superseded between the time it
 * enqueued the work and the time the queue gets around to it.
 *
 * Renamed from `ContextPipelineService` as part of Phase A of the
 * cursor-namespace rewrite. The required `signal` parameter is the
 * load-bearing change — every caller now has to consciously pass a
 * lifecycle-bound signal, eliminating the silent "queue runs orphaned
 * work after the requester is gone" failure mode that produced the
 * 12:35 supersede bug.
 */
@Injectable()
export class ContextPipeline {
  private readonly logger = new Logger(ContextPipeline.name)
  private readonly mutationQueues = new Map<string, Promise<void>>()

  async runMutation<T>(args: {
    conversationId: string
    label: string
    signal: AbortSignal
    operation: (signal: AbortSignal) => Promise<T>
  }): Promise<T> {
    const { conversationId, label, signal, operation } = args
    const key = conversationId || "__stateless__"
    const previous = this.mutationQueues.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(
      () => current,
      () => current
    )
    this.mutationQueues.set(key, queued)

    await previous.catch((error) => {
      this.logger.warn(
        `Previous context mutation failed before ${label}: ${String(error)}`
      )
    })

    try {
      // Refuse to start work whose lifecycle has already ended. This
      // catches the critical race where a turn was superseded while
      // queued behind another mutation — without this check, the
      // operation would run, allocate a backend account, and produce
      // the duplicate-request anomaly that motivates the rewrite.
      if (signal.aborted) {
        const reason =
          signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason ?? "ContextPipeline aborted"))
        throw reason
      }
      return await operation(signal)
    } finally {
      release()
      if (this.mutationQueues.get(key) === queued) {
        this.mutationQueues.delete(key)
      }
    }
  }
}

/**
 * @deprecated Re-exported as ContextPipelineService for callers that
 * have not yet migrated. Will be deleted in Phase H.
 */
export { ContextPipeline as ContextPipelineService }
