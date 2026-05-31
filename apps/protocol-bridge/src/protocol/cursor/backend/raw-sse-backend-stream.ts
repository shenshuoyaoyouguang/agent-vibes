/**
 * Cursor adapter that wraps the legacy
 * `CursorConnectStreamService.getBackendStream(...)` generator into
 * the new turn-architecture `BackendStream<string>` shape.
 *
 * The events stream is passthrough — each item is a raw SSE event
 * line, exactly as the legacy worker code already consumes. The
 * adapter exists so the background worker can talk to the new
 * BackendStream interface without us also rewriting the SSE event
 * decoder (cursor + codex have provider-specific quirks the worker
 * already handles inline).
 *
 * Phase H5b. The intent is to migrate one consumer at a time onto
 * BackendStream so providers (cursor, anthropic, codex) can be
 * swapped without changing call-sites. Background worker is the
 * cleanest first consumer because it has no live BiDi outbound.
 */
import type { BackendStream } from "./backend-stream"

export class RawSseBackendStream implements BackendStream<string> {
  private readonly source: AsyncGenerator<string, void, unknown>
  private readonly externalAbort: AbortController
  private cancelled = false

  constructor(source: AsyncGenerator<string, void, unknown>) {
    this.source = source
    this.externalAbort = new AbortController()
  }

  events(): AsyncIterable<string> {
    return this.toAsyncIterable()
  }

  private async *toAsyncIterable(): AsyncIterable<string> {
    try {
      for await (const evt of this.source) {
        if (this.cancelled) break
        yield evt
      }
    } finally {
      // Best-effort: ensure the underlying generator is fully
      // unwound. The source generator's finally handles
      // registration.release() so we don't need to do anything
      // extra here.
    }
  }

  cancel(reason: string): void {
    if (this.cancelled) return
    this.cancelled = true
    this.externalAbort.abort(reason)
    // The underlying SSE source observes abortSignal internally
    // (passed through `getBackendStream`'s options), so flipping
    // this controller is the cancellation handshake.
    void this.source.return?.(undefined)
  }

  /** Test introspection. */
  wasCancelled(): boolean {
    return this.cancelled
  }
}
