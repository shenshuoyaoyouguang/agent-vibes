import type { ConversationId } from "../turn/turn.types"

/**
 * Backend-agnostic streaming shape. Every LLM provider (cursor,
 * anthropic, codex) wraps its native streaming API into this
 * interface. The new turn-runner architecture talks ONLY to
 * BackendStream — providers are pluggable behind it.
 *
 * Why a separate abstraction from the runner hooks: the runner
 * hooks (ParentTurnHooks, ForegroundSubagentHooks) are
 * application-shaped — they decide what to do with each event. A
 * BackendStream is mechanism-shaped — it just delivers events. One
 * BackendStream serves both runner shapes plus the background
 * worker.
 */
export interface BackendStream<E = BackendStreamEvent> {
  /**
   * The event stream. Iteration completes when the backend signals
   * the response is done or when `cancel()` is called. The iterator
   * may throw if the backend transport fails.
   */
  events(): AsyncIterable<E>

  /**
   * Cancel the underlying backend HTTP call. Idempotent. After
   * cancel, `events()` resolves with no further iterations (or
   * throws if it had already begun and the backend rejects the
   * cancel).
   *
   * The runner does NOT call this directly under normal flow —
   * instead, it threads the turn's AbortSignal into the backend
   * call via `open()`'s `signal` parameter. `cancel()` is a fallback
   * for cases where the signal-based path is not available.
   */
  cancel(reason: string): void
}

/**
 * Decoded events the backend emits. The shapes are deliberately
 * provider-agnostic — provider-specific deltas are normalised at
 * the BackendStream factory.
 */
export type BackendStreamEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "thinking-delta"; text: string }
  | {
      kind: "tool-use"
      toolCallId: string
      toolName: string
      arguments: unknown
    }
  | { kind: "tool-result-delta"; toolCallId: string; chunk: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "stop"; reason: string }
  | { kind: "error"; error: Error }

/**
 * Factory for a BackendStream. Suppliers (cursor, anthropic, codex)
 * register one of these per-provider; the integration layer picks
 * the right one based on session model.
 */
export interface BackendStreamProvider {
  open(req: BackendStreamOpenRequest): Promise<BackendStream>
}

export interface BackendStreamOpenRequest {
  readonly conversationId: ConversationId
  readonly model: string
  readonly transcript: ReadonlyArray<{
    role: "user" | "assistant" | "tool"
    content: string
  }>
  readonly tools?: ReadonlyArray<{
    name: string
    description: string
    inputSchema: unknown
  }>
  /**
   * Cancellation signal. When fired, the provider MUST abort the
   * underlying HTTP call. The new architecture's TurnHandle.signal
   * is what gets threaded in here.
   */
  readonly signal: AbortSignal
  readonly maxTokens?: number
  readonly temperature?: number
}

/**
 * Test/utility: a BackendStream that emits a fixed sequence of
 * events. Used by tests to drive runners without booting a real
 * provider.
 */
export class FakeBackendStream implements BackendStream {
  private readonly script: BackendStreamEvent[]
  private cancelled = false
  private cancelReason: string | undefined

  constructor(events: BackendStreamEvent[]) {
    this.script = events
  }

  async *events(): AsyncIterable<BackendStreamEvent> {
    for (const e of this.script) {
      if (this.cancelled) break
      yield e
    }
  }

  cancel(reason: string): void {
    this.cancelled = true
    this.cancelReason = reason
  }

  /** Test introspection. */
  wasCancelled(): boolean {
    return this.cancelled
  }
  cancelReasonText(): string | undefined {
    return this.cancelReason
  }
}
