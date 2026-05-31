export interface RegisteredBackendAbortController {
  controller: AbortController
  release: () => void
}

/**
 * Per-conversation, per-stream registry of in-flight backend HTTP
 * AbortControllers. The registry is the lone owner of cancellation tokens for
 * already-opened streaming LLM calls; it is *not* responsible for abortable
 * work that has not yet reached the network (e.g. an LLM compaction call
 * scheduled inside `prepareContextWithCompactRunner`). Those callers must
 * obtain an AbortSignal from the per-turn AbortController on
 * `SessionRecord.currentTurnAbortController` and combine it with whatever
 * signal this registry hands out at register-time.
 *
 * Moved from `cursor/session/backend-stream-abort-registry.ts` as part of
 * Phase A of the cursor-namespace rewrite. Behaviour is unchanged; the old
 * path remains as a re-export shim for the duration of the rewrite.
 */
export class BackendAbortRegistry {
  private readonly controllersByConversation = new Map<
    string,
    Map<string, Set<AbortController>>
  >()

  register(
    conversationId: string,
    streamId: string
  ): RegisteredBackendAbortController {
    const controller = new AbortController()
    const streamControllers = this.getOrCreateStreamControllers(
      conversationId,
      streamId
    )
    streamControllers.add(controller)

    return {
      controller,
      release: () => this.release(conversationId, streamId, controller),
    }
  }

  abortStream(
    conversationId: string,
    streamId: string,
    reason: string
  ): number {
    const conversationControllers =
      this.controllersByConversation.get(conversationId)
    const streamControllers = conversationControllers?.get(streamId)
    if (!streamControllers || streamControllers.size === 0) {
      return 0
    }

    for (const controller of streamControllers) {
      controller.abort(new Error(reason))
    }

    conversationControllers?.delete(streamId)
    if (conversationControllers && conversationControllers.size === 0) {
      this.controllersByConversation.delete(conversationId)
    }

    return streamControllers.size
  }

  abortOtherStreams(
    conversationId: string,
    currentStreamId: string,
    reason: string
  ): number {
    const conversationControllers =
      this.controllersByConversation.get(conversationId)
    if (!conversationControllers) {
      return 0
    }

    let abortedCount = 0
    for (const streamId of Array.from(conversationControllers.keys())) {
      if (streamId === currentStreamId) {
        continue
      }
      abortedCount += this.abortStream(conversationId, streamId, reason)
    }
    return abortedCount
  }

  private getOrCreateStreamControllers(
    conversationId: string,
    streamId: string
  ): Set<AbortController> {
    let conversationControllers =
      this.controllersByConversation.get(conversationId)
    if (!conversationControllers) {
      conversationControllers = new Map<string, Set<AbortController>>()
      this.controllersByConversation.set(
        conversationId,
        conversationControllers
      )
    }

    let streamControllers = conversationControllers.get(streamId)
    if (!streamControllers) {
      streamControllers = new Set<AbortController>()
      conversationControllers.set(streamId, streamControllers)
    }
    return streamControllers
  }

  private release(
    conversationId: string,
    streamId: string,
    controller: AbortController
  ): void {
    const conversationControllers =
      this.controllersByConversation.get(conversationId)
    const streamControllers = conversationControllers?.get(streamId)
    if (!streamControllers) {
      return
    }

    streamControllers.delete(controller)
    if (streamControllers.size === 0) {
      conversationControllers?.delete(streamId)
    }
    if (conversationControllers && conversationControllers.size === 0) {
      this.controllersByConversation.delete(conversationId)
    }
  }
}
