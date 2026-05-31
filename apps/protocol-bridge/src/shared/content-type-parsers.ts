import { Logger } from "@nestjs/common"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { PassThrough, type Readable } from "stream"
import * as zlib from "zlib"

/**
 * Augment Fastify's FastifyRequest with a `bidiPayload` property that
 * the ConnectRPC handler reads from. ContentTypeParser keeps listening
 * to the underlying payload after `done()` and forwards every chunk
 * here, so the handler does not have to race the body parser for the
 * raw HTTP/2 stream.
 *
 * Why not use `req.raw` directly? Fastify body-parsers run before the
 * route handler. For BiDi streams we have to call `done(buffer)` before
 * the handler can be invoked, but Fastify treats the body as fully
 * consumed at that point — subsequent chunks emitted by `req.raw` will
 * be silently dropped during the window between `done()` and the
 * handler attaching its own `for await` listener (in production this
 * window can be seconds while the first turn parses 250KB of rules
 * and tool definitions). Routing later chunks through a PassThrough
 * we own avoids that race entirely.
 */
declare module "fastify" {
  interface FastifyRequest {
    bidiPayload?: PassThrough
  }
}

/**
 * Register custom content type parsers for gRPC/ConnectRPC.
 * Must be called BEFORE NestFactory.create() to avoid conflicts with NestJS default parsers.
 */
export function registerContentTypeParsers(
  fastify: FastifyInstance,
  logger: Logger
): void {
  // application/connect+proto — bidirectional streaming (HTTP/2)
  fastify.addContentTypeParser(
    "application/connect+proto",
    { bodyLimit: 52428800 },
    (
      request: FastifyRequest,
      payload: Readable,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      logger.debug("[ContentTypeParser] Handling application/connect+proto")
      logger.debug(
        `[ContentTypeParser] HTTP version: ${request.raw.httpVersion}, readable: ${payload.readable}`
      )

      // Check if payload is already a buffer
      if (Buffer.isBuffer(payload)) {
        logger.debug(
          `[ContentTypeParser] application/connect+proto: received ${payload.length} bytes (buffer)`
        )
        done(null, payload)
        return
      }

      // BiDi data plane: every chunk emitted by `payload` is mirrored to
      // this PassThrough so the ConnectRPC handler can drain it without
      // racing Fastify for `req.raw`. We attach the listeners ONCE here
      // and never detach — anything else opens a window where chunks
      // emitted between detach and the handler's reattach are dropped.
      const bidiPayload = new PassThrough()
      request.bidiPayload = bidiPayload

      let firstChunkReceived = false
      let doneCalled = false
      const initialChunks: Buffer[] = []
      let firstChunkTimer: NodeJS.Timeout | null = null
      let emptyBodyTimer: NodeJS.Timeout | null = null

      const settleDone = (err: Error | null, body?: Buffer) => {
        if (doneCalled) return
        doneCalled = true
        if (firstChunkTimer) {
          clearTimeout(firstChunkTimer)
          firstChunkTimer = null
        }
        if (emptyBodyTimer) {
          clearTimeout(emptyBodyTimer)
          emptyBodyTimer = null
        }
        done(err, body)
      }

      const finalize = (source: string) => {
        if (doneCalled) return
        const buffer = Buffer.concat(initialChunks)
        logger.debug(
          `[ContentTypeParser] application/connect+proto: received ${buffer.length} bytes (${source})`
        )
        settleDone(null, buffer)
      }

      const onData = (chunk: Buffer) => {
        // Mirror EVERY chunk into the BiDi PassThrough — including those
        // that arrive after `done()` was already called. This is the
        // critical bit that prevents the IDE's lsResult / readResult
        // from being silently dropped during the body-parser handoff.
        bidiPayload.write(chunk)

        if (!doneCalled) {
          logger.debug(
            `[ContentTypeParser] Received chunk: ${chunk.length} bytes`
          )
          initialChunks.push(chunk)

          // For BiDi streams, process immediately after first chunk
          // HTTP/2 BiDi streams don't emit 'end' until client closes
          if (!firstChunkReceived) {
            firstChunkReceived = true
            // Wait a bit longer to allow more data to arrive
            firstChunkTimer = setTimeout(() => {
              if (initialChunks.length > 0 && !doneCalled) {
                finalize("BiDi first chunk")
              }
            }, 50)
          }
        }
      }

      const onEnd = () => {
        logger.debug(
          `[ContentTypeParser] application/connect+proto: stream end event, firstChunkReceived=${firstChunkReceived}, chunks=${initialChunks.length}`
        )
        bidiPayload.end()
        if (!doneCalled) {
          // Wait a short time for any pending data
          firstChunkTimer = setTimeout(() => {
            finalize("stream end")
          }, 10)
        }
      }

      const onError = (err: Error) => {
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          logger.debug(`[ContentTypeParser] Stream closed (normal disconnect)`)
          bidiPayload.end()
        } else {
          logger.error(
            `[ContentTypeParser] Error reading stream: ${err.message}`
          )
          bidiPayload.destroy(err)
        }
        settleDone(err)
      }

      payload.on("data", onData)
      payload.on("end", onEnd)
      payload.on("error", onError)

      // For HTTP/2, also set a timeout to handle cases where no data arrives
      emptyBodyTimer = setTimeout(() => {
        if (!doneCalled && initialChunks.length === 0) {
          logger.warn(
            "[ContentTypeParser] application/connect+proto: timeout with no data, returning empty buffer"
          )
          finalize("timeout")
        }
      }, 100)
    }
  )

  // application/proto — standard unary protobuf
  fastify.addContentTypeParser(
    "application/proto",
    { bodyLimit: 52428800 },
    (
      request: FastifyRequest,
      payload: Readable,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      const shouldLogProtoTraffic = process.env.LOG_PROTO_TRAFFIC === "true"
      if (shouldLogProtoTraffic) {
        logger.debug("[ContentTypeParser] Handling application/proto")
      }

      // ConnectRPC uses Connect-Content-Encoding for compressed payloads
      const encoding =
        (request.headers["connect-content-encoding"] as string) ||
        (request.headers["content-encoding"] as string) ||
        ""

      const chunks: Buffer[] = []
      payload.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      payload.on("end", () => {
        const buffer = Buffer.concat(chunks)
        if (shouldLogProtoTraffic) {
          logger.debug(
            `[ContentTypeParser] application/proto: received ${buffer.length} bytes` +
              (encoding ? `, encoding=${encoding}` : "")
          )
        }

        // Decompress gzip if needed
        if (encoding.toLowerCase() === "gzip" && buffer.length > 0) {
          zlib.gunzip(buffer, (err, decompressed) => {
            if (err) {
              logger.error(
                `[ContentTypeParser] gzip decompression failed: ${err.message}`
              )
              // Fall back to raw buffer in case encoding header was wrong
              done(null, buffer)
            } else {
              if (shouldLogProtoTraffic) {
                logger.debug(
                  `[ContentTypeParser] application/proto: decompressed ${buffer.length} -> ${decompressed.length} bytes`
                )
              }
              done(null, decompressed)
            }
          })
        } else {
          done(null, buffer)
        }
      })
      payload.on("error", (err: Error) => {
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          logger.debug(`[ContentTypeParser] Stream closed (normal disconnect)`)
        } else {
          logger.error(
            `[ContentTypeParser] Error reading stream: ${err.message}`
          )
        }
        done(err)
      })
    }
  )

  // application/x-protobuf — OTLP traces exporter (OpenTelemetry)
  fastify.addContentTypeParser(
    "application/x-protobuf",
    { bodyLimit: 52428800 },
    (
      _request: FastifyRequest,
      payload: Readable,
      done: (err: Error | null, body?: Buffer) => void
    ) => {
      const chunks: Buffer[] = []
      payload.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      payload.on("end", () => {
        done(null, Buffer.concat(chunks))
      })
      payload.on("error", (err: Error) => {
        done(err)
      })
    }
  )
}
