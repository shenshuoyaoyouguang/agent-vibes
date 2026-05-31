import { Injectable, Logger, OnModuleInit } from "@nestjs/common"
import {
  type CursorDisplayModel,
  detectModelFamily,
  getCursorDisplayModel,
  getDefaultModelIds,
  isSupportedModel as isRegistrySupported,
  resolveCloudCodeModel,
} from "../shared/model-registry"
import { ProcessPoolService } from "./process-pool.service"
import {
  GOOGLE_STARTUP_UPSTREAM_CHECK_ENV,
  isGoogleStartupUpstreamCheckEnabled,
} from "./startup-probe-policy"

/**
 * Title-case a Gemini model id when neither the dynamic Cloud Code metadata
 * nor the static registry provides a usable display name. Mirrors the simple
 * casing logic in cursor-model-protocol's `formatFallbackModelName` so the
 * resulting label feels consistent with the rest of the Cursor model picker.
 */
function formatGeminiFallbackName(modelId: string): string {
  return modelId
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "gemini") return "Gemini"
      if (segment === "mini") return "Mini"
      if (segment === "max") return "Max"
      return segment.charAt(0).toUpperCase() + segment.slice(1)
    })
    .join(" ")
}

/**
 * Model info from Cloud Code API
 */
interface GeminiModelInfo {
  modelId: string
  displayName?: string
  description?: string
  supportsThinking?: boolean
  thinkingBudget?: number
  minThinkingBudget?: number
  /**
   * Cloud Code-driven badge displayed next to the model name (e.g. `Fast`,
   * `New`). Antigravity's UI renders this as a colored chip alongside the
   * display name. Verified empirically against `fetchAvailableModels` raw
   * responses — only a subset of Gemini models carry it.
   */
  tagTitle?: string
  /**
   * Optional secondary text Cloud Code pairs with `tagTitle` (e.g.
   * `Limited time` for the `Fast` chip). We don't surface this directly in
   * the Cursor picker today, but cache it so future UI work doesn't need
   * another upstream roundtrip.
   */
  tagDescription?: string
}

/**
 * GoogleModelCacheService - Fetches and caches available models from Cloud Code API
 *
 * Model discovery is delegated to native worker processes
 * which call Cloud Code using the IDE's own network stack.
 */
@Injectable()
export class GoogleModelCacheService implements OnModuleInit {
  private readonly logger = new Logger(GoogleModelCacheService.name)

  // Model cache
  private modelCache: Map<string, GeminiModelInfo> = new Map()
  private lastUpdate: Date | null = null
  private readonly CACHE_TTL = 3600 * 1000 // 1 hour in ms

  // Default models from unified registry
  private readonly DEFAULT_MODELS = getDefaultModelIds()

  constructor(private readonly processPool: ProcessPoolService) {}

  onModuleInit(): void {
    // Load default models first, then try API in background
    this.addDefaultModels()

    if (this.processPool.isConfigured()) {
      if (isGoogleStartupUpstreamCheckEnabled()) {
        this.logger.log(
          "Using default models, loading from Google API in background..."
        )
        this.loadModelsInBackground()
      } else {
        this.logger.log(
          `Startup Google model fetch disabled (${GOOGLE_STARTUP_UPSTREAM_CHECK_ENV}=false); keeping default Gemini models until an explicit refresh or request.`
        )
      }
    } else {
      this.logger.warn(
        "Antigravity not configured, using default Gemini models"
      )
    }
  }

  /**
   * Load models in background via native worker (non-blocking)
   */
  private loadModelsInBackground(): void {
    const LOAD_TIMEOUT_MS = 15000

    const loadPromise = this.loadModels()
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("Model loading timeout")),
        LOAD_TIMEOUT_MS
      )
    )

    Promise.race([loadPromise, timeoutPromise]).catch((error) => {
      this.logger.warn(
        `Background model loading failed: ${error instanceof Error ? error.message : String(error)}, using defaults`
      )
    })
  }

  /**
   * Load models from Cloud Code API via native worker process
   */
  async loadModels(): Promise<void> {
    this.logger.log("Loading models via native process pool...")

    try {
      const result = (await this.processPool.fetchAvailableModels()) as {
        models?: Record<
          string,
          {
            displayName?: string
            supportsThinking?: boolean
            thinkingBudget?: number
            minThinkingBudget?: number
            quotaInfo?: { remainingFraction?: number; resetTime?: string }
            // Antigravity-driven badge metadata. `tagTitle` is the chip
            // text (e.g. `Fast`, `New`) and `tagDescription` is the
            // optional secondary line (`Limited time`). Verified
            // empirically against the raw `fetchAvailableModels` payload.
            tagTitle?: string
            tagDescription?: string
          }
        >
      }

      const modelsMap = result?.models || {}

      // Update cache
      this.modelCache.clear()
      for (const [modelId, modelData] of Object.entries(modelsMap)) {
        if (this.isSupportedModel(modelId)) {
          this.modelCache.set(modelId, {
            modelId,
            displayName: modelData.displayName,
            supportsThinking: modelData.supportsThinking,
            thinkingBudget:
              typeof modelData.thinkingBudget === "number"
                ? modelData.thinkingBudget
                : undefined,
            minThinkingBudget:
              typeof modelData.minThinkingBudget === "number"
                ? modelData.minThinkingBudget
                : undefined,
            tagTitle:
              typeof modelData.tagTitle === "string" &&
              modelData.tagTitle.trim().length > 0
                ? modelData.tagTitle.trim()
                : undefined,
            tagDescription:
              typeof modelData.tagDescription === "string" &&
              modelData.tagDescription.trim().length > 0
                ? modelData.tagDescription.trim()
                : undefined,
          })
        }
      }
      this.lastUpdate = new Date()

      this.logger.log(
        `Loaded ${this.modelCache.size} models via native process`
      )
      this.logger.debug(
        `Models: ${Array.from(this.modelCache.keys()).join(", ")}`
      )
    } catch (error) {
      this.logger.warn(
        `Failed to fetch models via native process: ${error instanceof Error ? error.message : String(error)}`
      )
      // Keep existing default models
    }
  }

  /**
   * Check if a model is supported (Claude or Gemini)
   */
  private isSupportedModel(modelId: string): boolean {
    return isRegistrySupported(modelId)
  }

  /**
   * Add default models to cache
   */
  private addDefaultModels(): void {
    this.modelCache.clear()
    for (const modelId of this.DEFAULT_MODELS) {
      this.modelCache.set(modelId, {
        modelId,
        displayName: modelId,
        description: "Gemini model via Antigravity Cloud Code",
      })
    }
    this.lastUpdate = new Date()
    this.logger.log(`Added ${this.DEFAULT_MODELS.length} default Gemini models`)
  }

  /**
   * Get all available model IDs
   */
  getAllModelIds(): string[] {
    return Array.from(this.modelCache.keys()).sort()
  }

  /**
   * Check if model exists in cache
   */
  isValidModel(modelId: string): boolean {
    return this.modelCache.has(modelId)
  }

  /**
   * Get model info
   */
  getModelInfo(modelId: string): GeminiModelInfo | undefined {
    return this.modelCache.get(modelId)
  }

  /**
   * Build Cursor display entries for every Gemini model currently in cache.
   *
   * Static `GEMINI_CURSOR_DISPLAY_MODELS` only enumerates the IDs hard-coded at
   * build time. Newer Antigravity Cloud Code releases keep adding Gemini models
   * (e.g. `gemini-3.5-flash-low`, `gemini-pro-agent`); we want those to surface
   * in Cursor's AvailableModels response without a code change.
   *
   * Strategy:
   * - If a static entry exists for the cached id, reuse it verbatim so the
   *   curated `shortName` / capability flags win.
   * - Otherwise synthesize a minimum entry from the cached Cloud Code metadata.
   *
   * Callers inject the result via `getCursorDisplayModels({ extraModels })`.
   * Its dedup logic keeps the first occurrence, so static entries always take
   * precedence and dynamic ones only fill the gaps.
   */
  getCursorDisplayModels(): CursorDisplayModel[] {
    const result: CursorDisplayModel[] = []
    for (const [modelId, info] of this.modelCache.entries()) {
      if (detectModelFamily(modelId) !== "gemini") {
        continue
      }

      const staticEntry = getCursorDisplayModel(modelId)

      // Antigravity Cloud Code is the source of truth for Gemini display
      // names (e.g. `Gemini 3.1 Pro (High)`). Prefer the dynamic
      // `displayName` whenever the worker returned a real label — i.e. it
      // is non-empty and not just the modelId echoed back by
      // `addDefaultModels` before the API roundtrip completes. This keeps
      // the curated `shortName` / capability flags from the static entry
      // while letting the official Antigravity label win over our hand
      // -written fallback.
      const trimmedDisplay = info.displayName?.trim()
      const dynamicDisplayName =
        trimmedDisplay &&
        trimmedDisplay.length > 0 &&
        trimmedDisplay.toLowerCase() !== modelId.toLowerCase()
          ? trimmedDisplay
          : undefined

      // Antigravity's UI renders a chip badge from Cloud Code's
      // `tagTitle` field (e.g. `Fast`, `New`). Mirror it verbatim — the
      // raw `fetchAvailableModels` response is the only data-driven
      // badge source we have, verified empirically. The previous
      // `startsWith("gemini-3.5-flash") → Fast` heuristic was both too
      // narrow (missed `gemini-3-flash-agent` which also carries `Fast`)
      // and too broad (couldn't represent `gemini-3.1-pro-high`'s `New`).
      const upstreamTagline = info.tagTitle

      if (staticEntry) {
        const merged: CursorDisplayModel = { ...staticEntry }
        if (dynamicDisplayName) {
          merged.displayName = dynamicDisplayName
          merged.shortName = dynamicDisplayName
        }
        if (upstreamTagline && !staticEntry.tagline) {
          merged.tagline = upstreamTagline
        }
        result.push(merged)
        continue
      }

      const resolved = resolveCloudCodeModel(modelId)
      const isThinking =
        info.supportsThinking === true ||
        typeof info.thinkingBudget === "number" ||
        typeof info.minThinkingBudget === "number" ||
        modelId.toLowerCase().includes("thinking")

      const displayName =
        dynamicDisplayName ??
        (resolved?.displayName &&
        resolved.displayName.toLowerCase() !== modelId.toLowerCase()
          ? resolved.displayName
          : formatGeminiFallbackName(modelId))

      result.push({
        name: modelId,
        displayName,
        shortName: displayName,
        family: "gemini",
        isThinking,
        tagline: upstreamTagline,
      })
    }
    return result
  }

  /**
   * Check if cache is stale
   */
  isStale(): boolean {
    if (!this.lastUpdate) return true
    return Date.now() - this.lastUpdate.getTime() > this.CACHE_TTL
  }

  /**
   * Refresh cache if stale
   */
  async refreshIfStale(): Promise<void> {
    if (this.isStale() && this.processPool.isConfigured()) {
      await this.loadModels()
    }
  }

  /**
   * Force refresh cache regardless of staleness.
   * Used when user explicitly requests model list refresh.
   */
  async forceRefresh(): Promise<void> {
    if (this.processPool.isConfigured()) {
      await this.loadModels()
    }
  }
}
