import type { BackendErrorClass } from "./backend-error-class"

export class BackendApiError extends Error {
  readonly backend: string
  readonly statusCode?: number
  readonly retryAfterSeconds?: number
  readonly permanent: boolean
  /**
   * Structured classification. Producer (the backend service that
   * decoded the wire response) decides this; downstream code reads it
   * via `classifyBackendError` so a single source of truth flows
   * through retry / fallback / Anthropic-envelope rendering.
   *
   * Optional for backward-compat with throwers that haven't been
   * migrated yet — the shared classifier will infer one from
   * `statusCode` + `message` for those, but the inference is a
   * fallback, not the primary path.
   */
  readonly errorClass?: BackendErrorClass
  /** Actual input tokens reported by the upstream (PTL detail). */
  readonly actualTokens?: number
  /** Maximum input tokens reported by the upstream (PTL detail). */
  readonly maxTokens?: number

  constructor(
    message: string,
    options: {
      backend: string
      statusCode?: number
      retryAfterSeconds?: number
      permanent?: boolean
      errorClass?: BackendErrorClass
      actualTokens?: number
      maxTokens?: number
    }
  ) {
    super(message)
    this.name = "BackendApiError"
    this.backend = options.backend
    this.statusCode = options.statusCode
    this.retryAfterSeconds = options.retryAfterSeconds
    this.permanent = options.permanent ?? false
    this.errorClass = options.errorClass
    this.actualTokens = options.actualTokens
    this.maxTokens = options.maxTokens
  }
}

export class BackendAccountPoolUnavailableError extends Error {
  readonly backend: string
  readonly retryAfterSeconds?: number
  readonly disabledCount: number
  readonly coolingCount: number
  readonly permanent: boolean
  readonly errorClass: BackendErrorClass = "rate_limited"

  constructor(
    message: string,
    options: {
      backend: string
      retryAfterSeconds?: number
      disabledCount?: number
      coolingCount?: number
      permanent?: boolean
    }
  ) {
    super(message)
    this.name = "BackendAccountPoolUnavailableError"
    this.backend = options.backend
    this.retryAfterSeconds = options.retryAfterSeconds
    this.disabledCount = options.disabledCount ?? 0
    this.coolingCount = options.coolingCount ?? 0
    this.permanent = options.permanent ?? false
  }
}
