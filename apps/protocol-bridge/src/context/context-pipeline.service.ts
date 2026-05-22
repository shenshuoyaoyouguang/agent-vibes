import { Injectable, Logger } from "@nestjs/common"

@Injectable()
export class ContextPipelineService {
  private readonly logger = new Logger(ContextPipelineService.name)
  private readonly mutationQueues = new Map<string, Promise<void>>()

  async runMutation<T>(
    conversationId: string,
    label: string,
    operation: () => Promise<T>
  ): Promise<T> {
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
      return await operation()
    } finally {
      release()
      if (this.mutationQueues.get(key) === queued) {
        this.mutationQueues.delete(key)
      }
    }
  }
}
