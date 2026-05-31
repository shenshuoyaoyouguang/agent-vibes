import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger"
import type { FastifyReply } from "fastify"
import { ApiKeyGuard } from "../../shared/api-key.guard"
import {
  type AnthropicErrorEnvelope,
  renderAnthropicError,
} from "./anthropic-error"
import { CountTokensDto } from "./dto/count-tokens.dto"
import { CreateMessageDto } from "./dto/create-message.dto"
import { MessagesService } from "./messages.service"

@ApiTags("Anthropic API")
@Controller("v1")
@UseGuards(ApiKeyGuard)
@ApiSecurity("api-key")
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  private pickHeaders(
    allowedHeaders: string[],
    headers?: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    if (!headers) return {}

    const out: Record<string, string> = {}
    for (const key of allowedHeaders) {
      const value = headers[key]
      if (typeof value === "string" && value.trim() !== "") {
        out[key] = value.trim()
      } else if (Array.isArray(value) && value.length > 0) {
        const merged = value
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .join(",")
        if (merged) {
          out[key] = merged
        }
      }
    }

    return out
  }

  private pickAnthropicForwardHeaders(
    headers?: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    return this.pickHeaders(
      [
        "anthropic-version",
        "anthropic-beta",
        "anthropic-dangerous-direct-browser-access",
        "x-app",
        "x-stainless-retry-count",
        "x-stainless-runtime",
        "x-stainless-lang",
        "x-stainless-timeout",
        "x-cpa-claude-1m",
        "user-agent",
      ],
      headers
    )
  }

  private pickCodexForwardHeaders(
    headers?: Record<string, string | string[] | undefined>
  ): Record<string, string> {
    return this.pickHeaders(
      [
        "originator",
        "version",
        "user-agent",
        "openai-beta",
        "x-codex-beta-features",
        "x-codex-turn-state",
        "x-codex-turn-metadata",
        "x-client-request-id",
        "x-responsesapi-include-timing-metrics",
        "session_id",
        "session-id",
      ],
      headers
    )
  }

  private buildMissingModelError(): HttpException {
    const envelope: AnthropicErrorEnvelope = {
      type: "error",
      error: { type: "invalid_request_error", message: "missing model" },
    }
    return new HttpException(envelope, 400)
  }

  @Post("messages")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a message (Anthropic API)" })
  @ApiHeader({ name: "x-api-key", description: "API Key", required: false })
  @ApiHeader({
    name: "anthropic-version",
    description: "API Version",
    required: false,
  })
  @ApiBody({ type: CreateMessageDto })
  async createMessage(
    // NOTE: receive the raw plain body instead of letting Nest run
    // class-transformer/class-validator on it. The SEA esbuild bundle does
    // not preserve the reflect-metadata that ValidationPipe needs for DTO
    // transforms, which would otherwise strip every property and leave the
    // service with `model: undefined` (see #5 follow-up). The DTO is still
    // declared for OpenAPI / typing, but at the wire level we accept any
    // plain object and validate the required fields downstream.
    @Body() body: Record<string, unknown>,
    @Headers("x-api-key") apiKey?: string,
    @Headers("anthropic-version") version?: string,
    @Headers()
    headers?: Record<string, string | string[] | undefined>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    void apiKey
    void version
    const createMessageDto = body as unknown as CreateMessageDto
    if (
      typeof createMessageDto?.model !== "string" ||
      createMessageDto.model.trim() === ""
    ) {
      throw this.buildMissingModelError()
    }
    const forwardHeaders = this.pickAnthropicForwardHeaders(headers)
    const codexForwardHeaders = this.pickCodexForwardHeaders(headers)

    // Handle streaming mode
    if (createMessageDto.stream && res) {
      const stream = this.messagesService.createMessageStream(
        createMessageDto,
        forwardHeaders,
        codexForwardHeaders
      )
      let headersWritten = false
      const ensureHeaders = () => {
        if (headersWritten) return
        res.header("Content-Type", "text/event-stream")
        res.header("Cache-Control", "no-cache")
        res.header("Connection", "keep-alive")
        headersWritten = true
      }

      try {
        for await (const chunk of stream) {
          ensureHeaders()
          res.raw.write(chunk)
        }
      } catch (error) {
        const rendered = renderAnthropicError(error)
        if (!headersWritten) {
          res.status(rendered.status)
        }
        if (rendered.retryAfterSeconds != null) {
          res.header("Retry-After", String(rendered.retryAfterSeconds))
        }
        ensureHeaders()
        res.raw.write(
          `event: error\ndata: ${JSON.stringify(rendered.body)}\n\n`
        )
      } finally {
        res.raw.end()
      }
      return
    }

    // Non-streaming mode: render uniform Anthropic error envelopes so CC CLI
    // can branch on `error.type` for retry decisions.
    try {
      return await this.messagesService.createMessage(
        createMessageDto,
        forwardHeaders,
        codexForwardHeaders
      )
    } catch (error) {
      const rendered = renderAnthropicError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Post("messages/count_tokens")
  @HttpCode(200)
  @ApiOperation({ summary: "Count tokens in a message (Anthropic API)" })
  @ApiHeader({ name: "x-api-key", description: "API Key", required: false })
  @ApiHeader({
    name: "anthropic-version",
    description: "API Version",
    required: false,
  })
  @ApiBody({ type: CountTokensDto })
  async countTokens(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    try {
      return await this.messagesService.countTokens(
        body as unknown as CountTokensDto
      )
    } catch (error) {
      const rendered = renderAnthropicError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Get("anthropic/models")
  @ApiOperation({ summary: "List available models (Anthropic format)" })
  listModels() {
    return this.messagesService.listModels()
  }

  @Get("models")
  @ApiOperation({ summary: "List available models (Anthropic-compatible)" })
  listAnthropicModels() {
    return this.messagesService.listModels()
  }
}
