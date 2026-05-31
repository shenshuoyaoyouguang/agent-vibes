/**
 * Async buffer channel — fan-in fan-out helper.
 *
 * Used by the Cursor BiDi tool dispatcher to multiplex an arbitrary
 * number of concurrent sub-generators onto a single AsyncIterable<Buffer>
 * that the main BiDi stream consumes. Producers call `push(buffer)`
 * from any task; the consumer calls `[Symbol.asyncIterator]()` once and
 * reads buffers in arrival order.
 *
 * Why the official agent.v1 protocol needs this:
 *   - A single parent agent turn can emit N independent tool_use blocks.
 *   - Each tool_use must traverse `executePreparedToolInvocation`,
 *     which yields ExecServerMessage / interactionUpdate / inline
 *     result buffers as it goes.
 *   - Sub-agents (the `task` tool) can run for tens of seconds; folding
 *     them into the parent's `yield*` chain serially means the next
 *     sub-agent (or any other tool in the same batch) only starts
 *     after the previous one completes.
 *   - With this channel we instead start every sub-generator
 *     concurrently and interleave their outputs as they emit, which is
 *     what the protocol allows (`is_parallel_worker = 7` exists for
 *     exactly this). Edit serialisation is preserved on a per-path
 *     basis by `SessionLifecycleService.acquireOrQueueEdit`, so the bridge
 *     never lets two writes to the same file race.
 *
 * Backpressure is intentionally NOT implemented. Buffers carry already-
 * encoded protocol envelopes which are tiny (typically <2 KB) and the
 * downstream BiDi sink reads as fast as the network can flush, so the
 * unbounded queue is fine in practice. If we ever need backpressure,
 * `push` becomes async and pauses on a high watermark — but doing that
 * eagerly without measured pain would only hurt latency.
 *
 * Failure semantics:
 *   - `push` after `close()` is a no-op (returns false). Producers
 *     that want to know if their write was actually accepted check the
 *     return value.
 *   - `error(err)` causes the consumer's `for await` to throw on the
 *     next pull, after every already-buffered chunk has been drained.
 *     Mirrors stream.Readable error semantics.
 */
export class BufferChannel<T = unknown> implements AsyncIterable<T> {
  private readonly queue: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private rejectors: Array<(reason: unknown) => void> = []
  private closed = false
  private failure: { reason: Error } | undefined

  /**
   * Push a value into the channel. Wakes one pending consumer if any
   * are parked. Returns `true` if the value was accepted, `false` if
   * the channel has already been closed (in which case the value is
   * discarded — push-after-close is a programmer mistake but we don't
   * throw, because the alternative is far more disruptive: a thrown
   * push from a sub-generator's catch handler would abort the parent
   * tool dispatch loop just because a producer raced past close).
   */
  push(value: T): boolean {
    if (this.closed || this.failure) return false
    const next = this.resolvers.shift()
    this.rejectors.shift()
    if (next) {
      next({ value, done: false })
    } else {
      this.queue.push(value)
    }
    return true
  }

  /**
   * Close the channel. Any consumer currently parked in `next()`
   * resolves with `done: true`. Subsequent `push` calls are silently
   * dropped. Already-buffered values are still drained before the
   * consumer sees `done: true`.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.queue.length === 0) {
      const waiters = this.resolvers
      this.resolvers = []
      this.rejectors = []
      for (const resolve of waiters) {
        resolve({ value: undefined, done: true })
      }
    }
  }

  /**
   * Fail the channel. Same drain-then-fail order as `close()`: the
   * consumer reads every buffered value before observing the error.
   *
   * Non-Error rejection reasons are wrapped in a synthetic Error so
   * downstream consumers (and ESLint) always see a real Error object.
   */
  error(reason: unknown): void {
    if (this.closed || this.failure) return
    const normalized =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : String(reason))
    this.failure = { reason: normalized }
    if (this.queue.length === 0) {
      const rejectors = this.rejectors
      this.resolvers = []
      this.rejectors = []
      for (const reject of rejectors) {
        reject(normalized)
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T
          return Promise.resolve({ value, done: false })
        }
        if (this.failure) {
          return Promise.reject(this.failure.reason)
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push(resolve)
          this.rejectors.push(reject)
        })
      },
      return: (): Promise<IteratorResult<T>> => {
        // Consumer requested early termination. Treat as graceful close.
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/**
 * Fan-in helper: drive an AsyncGenerator into a BufferChannel.
 *
 * Used to pipe a sub-generator (e.g. one tool_use's
 * `executePreparedToolInvocation` output) into the shared channel
 * without the parent generator needing to `yield*` it. Returns a
 * promise that resolves when the source is fully consumed (or
 * rejects when it throws).
 */
export async function pipeGeneratorIntoChannel<T>(
  source: AsyncGenerator<T, unknown>,
  channel: BufferChannel<T>
): Promise<void> {
  for await (const value of source) {
    channel.push(value)
  }
}
