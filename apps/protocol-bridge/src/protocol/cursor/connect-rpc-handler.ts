import { Logger } from "@nestjs/common"
import { FastifyRequest, FastifyReply } from "fastify"
import * as zlib from "zlib"

/**
 * ConnectRPC Protocol Handler
 * Implements the Connect protocol for bidirectional streaming
 * https://connectrpc.com/docs/protocol
 */

export interface ConnectMessage {
  flags: number
  data: Buffer
}

interface ParsedMessagesResult {
  messages: ConnectMessage[]
  remaining: Buffer
}

const CONNECT_FLAG_COMPRESSED = 0x01
const CONNECT_FLAG_END_STREAM = 0x02
const CONNECT_VALID_FLAG_MASK =
  CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM

export class ConnectRPCHandler {
  private readonly logger = new Logger(ConnectRPCHandler.name)

  /**
   * Parse ConnectRPC message frame
   * Format: [flags: 1 byte][length: 4 bytes big-endian][data: length bytes]
   */
  parseMessage(buffer: Buffer): ConnectMessage | null {
    const { messages } = this.parseMessagesWithRemainder(buffer, "gzip")
    return messages[0] ?? null
  }

  /**
   * Parse all messages from buffer
   */
  parseMessages(buffer: Buffer): ConnectMessage[] {
    return this.parseMessagesWithRemainder(buffer, "gzip").messages
  }

  private parseMessagesWithRemainder(
    buffer: Buffer,
    compressionEncoding: string
  ): ParsedMessagesResult {
    const messages: ConnectMessage[] = []
    let offset = 0

    while (buffer.length - offset >= 5) {
      const flags = buffer[offset]!
      const length = buffer.readUInt32BE(offset + 1)
      const unknownFlags = flags & ~CONNECT_VALID_FLAG_MASK

      if (unknownFlags !== 0) {
        this.logger.warn(
          `Received frame with unknown Connect flags bits: 0x${unknownFlags.toString(
            16
          )}`
        )
      }

      if (buffer.length - offset < 5 + length) {
        break
      }

      let payload = buffer.subarray(offset + 5, offset + 5 + length)
      offset += 5 + length

      if ((flags & CONNECT_FLAG_COMPRESSED) !== 0) {
        try {
          payload = this.decodeCompressedPayload(payload, compressionEncoding)
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          this.logger.error(
            `Failed to decompress Connect frame (flags=${flags}, encoding=${compressionEncoding}): ${errorMessage}`
          )
          continue
        }
      }

      // End-stream envelope body is JSON metadata, not protobuf payload.
      if ((flags & CONNECT_FLAG_END_STREAM) !== 0) {
        if (payload.length > 0) {
          try {
            const json = JSON.parse(payload.toString("utf-8")) as Record<
              string,
              unknown
            >
            this.logger.debug(
              `Received client end-stream metadata: ${JSON.stringify(json)}`
            )
          } catch {
            this.logger.warn("Received malformed client end-stream metadata")
          }
        }
        continue
      }

      messages.push({ flags, data: payload })
    }

    return { messages, remaining: buffer.subarray(offset) }
  }

  private decodeCompressedPayload(
    payload: Buffer,
    compressionEncoding: string
  ): Buffer {
    const encoding = compressionEncoding.trim().toLowerCase()

    switch (encoding) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(payload)
      case "deflate":
        return zlib.inflateSync(payload)
      case "br":
        return zlib.brotliDecompressSync(payload)
      case "identity":
        throw new Error("compressed frame received with identity encoding")
      default:
        throw new Error(`unsupported compression encoding: ${encoding}`)
    }
  }

  private resolveRequestCompressionEncoding(req: FastifyRequest): string {
    const headers = req.headers as Record<string, unknown>
    const connectEncodingHeader = headers["connect-content-encoding"]
    const contentEncodingHeader = headers["content-encoding"]
    const grpcEncodingHeader = headers["grpc-encoding"]
    const pickHeaderValue = (value: unknown): string | undefined => {
      if (typeof value === "string") return value
      if (!Array.isArray(value)) return undefined
      const firstString = value.find(
        (entry): entry is string => typeof entry === "string"
      )
      return firstString
    }
    const headerValue =
      pickHeaderValue(connectEncodingHeader) ??
      pickHeaderValue(contentEncodingHeader) ??
      pickHeaderValue(grpcEncodingHeader) ??
      ""
    const encoding = headerValue.split(",")[0]?.trim().toLowerCase()
    return encoding || "gzip"
  }

  /**
   * Encode message to ConnectRPC frame
   */
  encodeMessage(data: Buffer, flags = 0): Buffer {
    const frame = Buffer.allocUnsafe(5 + data.length)
    frame[0] = flags
    frame.writeUInt32BE(data.length, 1)
    data.copy(frame, 5)
    return frame
  }

  /**
   * Setup ConnectRPC streaming response
   * This writes headers directly to the raw response to ensure they are sent
   * before any data is written via res.raw.write()
   */
  setupStreamingResponse(res: FastifyReply): void {
    // Set status code first
    res.raw.statusCode = 200

    // Write headers directly to raw response to ensure they are sent
    // Note: Transfer-Encoding is NOT allowed in HTTP/2 - it has its own framing
    res.raw.setHeader("Content-Type", "application/connect+proto")
    res.raw.setHeader("Connect-Protocol-Version", "1")

    // Mark the reply as sent to prevent Fastify from trying to send again
    res.hijack()
  }

  /**
   * Write a message to the stream
   * Note: data is expected to already include ConnectRPC envelope from grpcService
   */
  writeMessage(res: FastifyReply, data: Buffer, _flags = 0): boolean {
    try {
      // Write data directly - grpcService methods already include the ConnectRPC envelope
      return res.raw.write(data)
    } catch (error) {
      this.logger.error("Failed to write message", error)
      return false
    }
  }

  /**
   * End the stream with ConnectRPC EndStreamResponse
   * ConnectRPC requires flags=2 for the end-stream message containing status/metadata
   */
  endStream(res: FastifyReply, error?: Error): void {
    try {
      // ConnectRPC EndStreamResponse format:
      // - flags byte: 0x02 (end stream flag)
      // - 4-byte length (big endian)
      // - JSON body with optional error

      let endStreamBody: Record<string, unknown>
      if (error) {
        endStreamBody = {
          error: {
            code: "internal",
            message: error.message,
          },
        }
      } else {
        // Empty object for successful completion
        endStreamBody = {}
      }

      const bodyJson = JSON.stringify(endStreamBody)
      const bodyBuffer = Buffer.from(bodyJson, "utf-8")

      // Create EndStreamResponse frame with flags=2
      const frame = Buffer.allocUnsafe(5 + bodyBuffer.length)
      frame[0] = 0x02 // flags: end stream
      frame.writeUInt32BE(bodyBuffer.length, 1)
      bodyBuffer.copy(frame, 5)

      res.raw.write(frame)
      res.raw.end()
    } catch (err) {
      this.logger.error("Failed to end stream", err)
      try {
        res.raw.end()
      } catch {
        // ignore
      }
    }
  }

  /**
   * Create a bidirectional stream handler
   */
  async handleBidiStream(
    req: FastifyRequest,
    res: FastifyReply,
    handler: (
      input: AsyncIterable<Buffer>,
      output: (data: Buffer) => void
    ) => Promise<void>
  ): Promise<void> {
    this.logger.log(">>> handleBidiStream started")

    this.setupStreamingResponse(res)
    this.logger.log(">>> Streaming response setup complete")

    // Create input stream from request
    const inputMessages = this.createInputStream(req)
    this.logger.log(">>> Input stream created")

    // Create output function
    const output = (data: Buffer) => {
      this.writeMessage(res, data)
    }

    try {
      this.logger.log(">>> Calling handler")
      await handler(inputMessages, output)
      this.logger.log(">>> Handler completed successfully")
      this.endStream(res)
    } catch (error) {
      this.logger.error("Bidi stream error", error)
      // Create a clean error with only the message to avoid circular references
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      this.endStream(res, new Error(errorMessage))
    }
  }

  /**
   * Create async iterable from request stream
   * For BiDi streaming, this needs to handle both:
   * 1. Initial request body (already parsed by Fastify)
   * 2. Additional messages on the same HTTP/2 stream (tool results)
   *
   * Based on Cursor source analysis: Cursor sends tool results via the same
   * HTTP/2 stream after receiving tool calls. We must keep the stream open
   * and continue reading to receive these results.
   */
  private async *createInputStream(req: FastifyRequest): AsyncIterable<Buffer> {
    this.logger.log(">>> createInputStream started")

    const compressionEncoding = this.resolveRequestCompressionEncoding(req)
    let pendingBuffer: Buffer = Buffer.alloc(0)

    // Preferred path: drain the BiDi PassThrough installed by the
    // application/connect+proto ContentTypeParser. The parser keeps
    // listening to the underlying HTTP/2 readable for the entire BiDi
    // session and mirrors every chunk into this PassThrough — including
    // the initial-body chunks that were also handed to Fastify via
    // `done(buffer)`. By draining the PassThrough exclusively we avoid
    // racing Fastify for `req.raw`, which is the failure mode that
    // silently dropped the IDE's first lsResult / readResult and
    // produced 90 s deadline-expire warnings.
    //
    // Fallback to `req.body` + `req.raw` is kept for non-BiDi routes
    // (unary protobuf, etc.) where ContentTypeParser does not install
    // bidiPayload.
    const bidiPayload = req.bidiPayload
    if (bidiPayload) {
      this.logger.log(">>> Draining bidiPayload (BiDi mirror channel)")
      try {
        for await (const chunk of bidiPayload) {
          const chunkBuffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as Uint8Array)
          this.logger.log(`>>> Received chunk: ${chunkBuffer.length} bytes`)

          pendingBuffer =
            pendingBuffer.length === 0
              ? chunkBuffer
              : Buffer.concat([pendingBuffer, chunkBuffer])

          const parsed = this.parseMessagesWithRemainder(
            pendingBuffer,
            compressionEncoding
          )
          pendingBuffer = parsed.remaining

          for (const message of parsed.messages) {
            this.logger.log(
              `>>> Yielding message: ${message.data.length} bytes`
            )
            yield message.data
          }
        }

        this.logger.log(">>> bidiPayload ended normally")
        if (pendingBuffer.length > 0) {
          this.logger.warn(
            `>>> bidiPayload ended with ${pendingBuffer.length} unparsed trailing bytes`
          )
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "unknown"
        this.logger.error(`>>> bidiPayload error: ${errorMessage}`)
      }

      this.logger.log(">>> Input stream completed")
      return
    }

    // Legacy / unary fallback: parse the buffered body, then read any
    // remaining chunks straight from req.raw.
    const initialBody = req.body as Buffer
    this.logger.log(
      `>>> Initial body: ${initialBody ? initialBody.length : 0} bytes (encoding=${compressionEncoding})`
    )

    if (initialBody && initialBody.length > 0) {
      const parsed = this.parseMessagesWithRemainder(
        initialBody,
        compressionEncoding
      )
      const messages = parsed.messages
      pendingBuffer = parsed.remaining
      this.logger.log(
        `>>> Parsed ${messages.length} message(s) from initial body`
      )

      for (const msg of messages) {
        this.logger.log(`>>> Yielding message: ${msg.data.length} bytes`)
        yield msg.data
      }

      if (pendingBuffer.length > 0) {
        this.logger.warn(
          `>>> Initial body has ${pendingBuffer.length} trailing bytes; keeping for next chunks`
        )
      }
    }

    // Continue reading from the HTTP/2 stream for tool results
    // This is critical for the tool execution lifecycle
    this.logger.log(">>> Listening for tool results on HTTP/2 stream...")

    try {
      // Access the raw HTTP/2 stream
      const rawStream = req.raw

      // Read from stream using async iteration
      for await (const chunk of rawStream) {
        const chunkBuffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array)
        this.logger.log(`>>> Received chunk: ${chunkBuffer.length} bytes`)

        pendingBuffer =
          pendingBuffer.length === 0
            ? chunkBuffer
            : Buffer.concat([pendingBuffer, chunkBuffer])

        const parsed = this.parseMessagesWithRemainder(
          pendingBuffer,
          compressionEncoding
        )
        pendingBuffer = parsed.remaining

        for (const message of parsed.messages) {
          this.logger.log(
            `>>> Yielding tool result: ${message.data.length} bytes`
          )
          yield message.data
        }
      }

      this.logger.log(">>> HTTP/2 stream ended normally")
      if (pendingBuffer.length > 0) {
        this.logger.warn(
          `>>> Stream ended with ${pendingBuffer.length} unparsed trailing bytes`
        )
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "unknown"
      this.logger.error(`>>> Stream error: ${errorMessage}`)
    }

    this.logger.log(">>> Input stream completed")
  }

  /**
   * Parse ConnectRPC request envelope
   * Some requests have a 5-byte envelope prefix
   */
  stripEnvelope(buffer: Buffer): Buffer {
    if (buffer.length < 5) {
      return buffer
    }

    const flags = buffer[0]!
    const length = buffer.readUInt32BE(1)
    const isMessageFrame =
      (flags & CONNECT_FLAG_END_STREAM) === 0 &&
      (flags & ~CONNECT_FLAG_COMPRESSED) === 0

    if (isMessageFrame && buffer.length >= 5 + length) {
      return buffer.subarray(5, 5 + length)
    }
    return buffer
  }
}

export const connectRPCHandler = new ConnectRPCHandler()
