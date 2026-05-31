import { Injectable, Logger } from "@nestjs/common"
import { createHash } from "crypto"
import { ContextTelemetryService } from "../../context/context-telemetry.service"

/**
 * Prompt cache break detection — port of cc's promptCacheBreakDetection.ts
 * (claude-code/src/services/api/promptCacheBreakDetection.ts).
 *
 * Two-phase protocol:
 *
 *   1. Pre-call `recordPromptState()` snapshots the request shape (system,
 *      tools, model, betas, cache_control placement, ...). The first call
 *      for a given key seeds the baseline; subsequent calls compute hash
 *      diffs and stash any detected changes as `pendingChanges`.
 *
 *   2. Post-call `checkResponseForCacheBreak()` reads the upstream's
 *      `cache_read_input_tokens`. If it dropped >5% from the previous call
 *      AND the absolute drop is ≥ MIN_CACHE_MISS_TOKENS, the break is
 *      reported via telemetry with the pending change flags as the cause.
 *
 * `notifyCacheDeletion()` and `notifyCompaction()` mark expected drops so
 * cached-microcompact emissions and boundary compactions don't create
 * false positives.
 *
 * State is held in a service-level `Map<TrackingKey, PreviousState>` keyed
 * by `${sessionId}|${agentId ?? ""}`. SessionRecord dispose paths must call
 * `cleanupSession(sessionId)` to release entries.
 *
 * Stateless inputs (no `sessionId`) are skipped silently — without a
 * stable key there is no way to compare turn-to-turn drops.
 */

// cc parity: `cacheReadTokens < prev * 0.95 && drop >= 2000` triggers a
// break; haiku is excluded because its pricing/caching curve is different.
const CACHE_MISS_RATIO = 0.95
const MIN_CACHE_MISS_TOKENS = 2_000
const MAX_TRACKED_SOURCES = 64

const HAIKU_MODEL_RE = /haiku/i

export interface RecordPromptStateInput {
  sessionId?: string
  agentId?: string
  /** Final outbound `system` array (cache_control already applied). */
  system: ReadonlyArray<Record<string, unknown>>
  /** Final outbound `tools` schema array. */
  toolSchemas: ReadonlyArray<Record<string, unknown>>
  model: string
  /** Sorted/deduped beta tokens going on the `anthropic-beta` header. */
  betas?: ReadonlyArray<string>
  /** Free-form extra body params (only its hash is tracked). */
  extraBodyParams?: unknown
  fastMode?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  globalCacheStrategy?: string
  autoModeActive?: boolean
  isUsingOverage?: boolean
}

export interface CheckCacheBreakInput {
  sessionId?: string
  agentId?: string
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Wall-clock time of the last successful assistant response (for TTL hints). */
  lastAssistantTimestampMs?: number
  requestId?: string | null
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  prevEffortValue: string
  newEffortValue: string
}

interface PreviousState {
  systemHash: string
  toolsHash: string
  cacheControlHash: string
  toolNames: string[]
  systemCharCount: number
  model: string
  fastMode: boolean
  globalCacheStrategy: string
  betas: string[]
  autoModeActive: boolean
  isUsingOverage: boolean
  cachedMCEnabled: boolean
  effortValue: string
  extraBodyHash: string
  callCount: number
  pendingChanges: PendingChanges | null
  /** Last observed cache_read_input_tokens; null = first call or just compacted. */
  prevCacheReadTokens: number | null
  /** True after notifyCacheDeletion; the next drop is expected and will be swallowed. */
  cacheDeletionsPending: boolean
}

function makeTrackingKey(sessionId?: string, agentId?: string): string | null {
  if (!sessionId) return null
  return `${sessionId}|${agentId ?? ""}`
}

function computeHash(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null)
    return createHash("sha256").update(json).digest("hex").slice(0, 32)
  } catch {
    return "0"
  }
}

function stripCacheControl(
  blocks: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block
    if (!("cache_control" in block)) return block
    const { cache_control: _omit, ...rest } = block
    return rest
  })
}

function getSystemCharCount(
  blocks: ReadonlyArray<Record<string, unknown>>
): number {
  let total = 0
  for (const block of blocks) {
    if (!block) continue
    if (typeof block === "object" && "text" in block) {
      const text = (block as { text?: unknown }).text
      if (typeof text === "string") total += text.length
    }
  }
  return total
}

function getCacheControlSignature(
  blocks: ReadonlyArray<Record<string, unknown>>
): unknown[] {
  return blocks.map((block) =>
    block && typeof block === "object" && "cache_control" in block
      ? (block as { cache_control: unknown }).cache_control
      : null
  )
}

function isHaikuModel(model: string): boolean {
  return HAIKU_MODEL_RE.test(model)
}

@Injectable()
export class PromptCacheBreakDetectionService {
  private readonly logger = new Logger(PromptCacheBreakDetectionService.name)
  private readonly stateByKey = new Map<string, PreviousState>()

  constructor(private readonly telemetry: ContextTelemetryService) {}

  /**
   * Phase 1: snapshot the outbound prompt shape. No-op when sessionId is
   * absent (stateless /v1/messages forwarding has no key for tracking).
   */
  recordPromptState(input: RecordPromptStateInput): void {
    const key = makeTrackingKey(input.sessionId, input.agentId)
    if (!key) return

    try {
      const strippedSystem = stripCacheControl(input.system)
      const strippedTools = stripCacheControl(input.toolSchemas)

      const systemHash = computeHash(strippedSystem)
      const toolsHash = computeHash(strippedTools)
      const cacheControlHash = computeHash(
        getCacheControlSignature(input.system)
      )
      const toolNames = input.toolSchemas.map((tool) =>
        typeof (tool as { name?: unknown }).name === "string"
          ? (tool as { name: string }).name
          : "unknown"
      )
      const systemCharCount = getSystemCharCount(input.system)
      const sortedBetas = [...(input.betas ?? [])].sort()
      const effortStr =
        input.effortValue === undefined || input.effortValue === null
          ? ""
          : String(input.effortValue)
      const extraBodyHash =
        input.extraBodyParams === undefined
          ? "0"
          : computeHash(input.extraBodyParams)
      const fastMode = input.fastMode ?? false
      const cachedMCEnabled = input.cachedMCEnabled ?? false
      const autoModeActive = input.autoModeActive ?? false
      const isUsingOverage = input.isUsingOverage ?? false
      const globalCacheStrategy = input.globalCacheStrategy ?? ""

      const prev = this.stateByKey.get(key)

      if (!prev) {
        // LRU eviction: drop oldest insertion when at capacity.
        while (this.stateByKey.size >= MAX_TRACKED_SOURCES) {
          const oldest = this.stateByKey.keys().next().value
          if (oldest === undefined) break
          this.stateByKey.delete(oldest)
        }
        this.stateByKey.set(key, {
          systemHash,
          toolsHash,
          cacheControlHash,
          toolNames,
          systemCharCount,
          model: input.model,
          fastMode,
          globalCacheStrategy,
          betas: sortedBetas,
          autoModeActive,
          isUsingOverage,
          cachedMCEnabled,
          effortValue: effortStr,
          extraBodyHash,
          callCount: 1,
          pendingChanges: null,
          prevCacheReadTokens: null,
          cacheDeletionsPending: false,
        })
        return
      }

      prev.callCount++

      const systemPromptChanged = systemHash !== prev.systemHash
      const toolSchemasChanged = toolsHash !== prev.toolsHash
      const modelChanged = input.model !== prev.model
      const fastModeChanged = fastMode !== prev.fastMode
      const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
      const globalCacheStrategyChanged =
        globalCacheStrategy !== prev.globalCacheStrategy
      const betasChanged =
        sortedBetas.length !== prev.betas.length ||
        sortedBetas.some((b, i) => b !== prev.betas[i])
      const autoModeChanged = autoModeActive !== prev.autoModeActive
      const overageChanged = isUsingOverage !== prev.isUsingOverage
      const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
      const effortChanged = effortStr !== prev.effortValue
      const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

      const anyChange =
        systemPromptChanged ||
        toolSchemasChanged ||
        modelChanged ||
        fastModeChanged ||
        cacheControlChanged ||
        globalCacheStrategyChanged ||
        betasChanged ||
        autoModeChanged ||
        overageChanged ||
        cachedMCChanged ||
        effortChanged ||
        extraBodyChanged

      if (anyChange) {
        const prevToolSet = new Set(prev.toolNames)
        const newToolSet = new Set(toolNames)
        const addedTools = toolNames.filter((n) => !prevToolSet.has(n))
        const removedTools = prev.toolNames.filter((n) => !newToolSet.has(n))

        prev.pendingChanges = {
          systemPromptChanged,
          toolSchemasChanged,
          modelChanged,
          fastModeChanged,
          cacheControlChanged,
          globalCacheStrategyChanged,
          betasChanged,
          autoModeChanged,
          overageChanged,
          cachedMCChanged,
          effortChanged,
          extraBodyChanged,
          addedToolCount: addedTools.length,
          removedToolCount: removedTools.length,
          systemCharDelta: systemCharCount - prev.systemCharCount,
          previousModel: prev.model,
          newModel: input.model,
          prevGlobalCacheStrategy: prev.globalCacheStrategy,
          newGlobalCacheStrategy: globalCacheStrategy,
          prevEffortValue: prev.effortValue,
          newEffortValue: effortStr,
        }
      } else {
        prev.pendingChanges = null
      }

      // Roll forward.
      prev.systemHash = systemHash
      prev.toolsHash = toolsHash
      prev.cacheControlHash = cacheControlHash
      prev.toolNames = toolNames
      prev.systemCharCount = systemCharCount
      prev.model = input.model
      prev.fastMode = fastMode
      prev.globalCacheStrategy = globalCacheStrategy
      prev.betas = sortedBetas
      prev.autoModeActive = autoModeActive
      prev.isUsingOverage = isUsingOverage
      prev.cachedMCEnabled = cachedMCEnabled
      prev.effortValue = effortStr
      prev.extraBodyHash = extraBodyHash
    } catch (error) {
      this.logger.warn(`recordPromptState failed: ${String(error)}`)
    }
  }

  /**
   * Phase 2: compare the response's cache_read_input_tokens against the
   * previous call's value. Reports a break to telemetry when the drop
   * crosses both the ratio and absolute thresholds.
   */
  checkResponseForCacheBreak(input: CheckCacheBreakInput): void {
    const key = makeTrackingKey(input.sessionId, input.agentId)
    if (!key) return

    try {
      const state = this.stateByKey.get(key)
      if (!state) return

      // Haiku's caching behavior is different — drops here are noise.
      if (isHaikuModel(state.model)) return

      const prevCacheRead = state.prevCacheReadTokens
      state.prevCacheReadTokens = input.cacheReadTokens

      // First call: no prior to compare against.
      if (prevCacheRead === null) return

      // Cached microcompact / boundary compaction will legitimately reduce
      // cache_read_input_tokens. We were warned via notifyCacheDeletion;
      // swallow this drop and clear the flag.
      if (state.cacheDeletionsPending) {
        state.cacheDeletionsPending = false
        state.pendingChanges = null
        return
      }

      const tokenDrop = prevCacheRead - input.cacheReadTokens
      if (
        input.cacheReadTokens >= prevCacheRead * CACHE_MISS_RATIO ||
        tokenDrop < MIN_CACHE_MISS_TOKENS
      ) {
        state.pendingChanges = null
        return
      }

      const changes = state.pendingChanges
      const reason = this.formatBreakReason(
        changes,
        input.lastAssistantTimestampMs
      )

      this.telemetry.recordEvent({
        event: "prompt_cache.break",
        scope: key,
        metadata: {
          reason,
          callNumber: state.callCount,
          prevCacheReadTokens: prevCacheRead,
          cacheReadTokens: input.cacheReadTokens,
          cacheCreationTokens: input.cacheCreationTokens,
          systemPromptChanged: changes?.systemPromptChanged ?? false,
          toolSchemasChanged: changes?.toolSchemasChanged ?? false,
          modelChanged: changes?.modelChanged ?? false,
          cacheControlChanged: changes?.cacheControlChanged ?? false,
          betasChanged: changes?.betasChanged ?? false,
          fastModeChanged: changes?.fastModeChanged ?? false,
          extraBodyChanged: changes?.extraBodyChanged ?? false,
          addedToolCount: changes?.addedToolCount ?? 0,
          removedToolCount: changes?.removedToolCount ?? 0,
          systemCharDelta: changes?.systemCharDelta ?? 0,
          requestId: input.requestId ?? "",
        },
      })

      state.pendingChanges = null
    } catch (error) {
      this.logger.warn(`checkResponseForCacheBreak failed: ${String(error)}`)
    }
  }

  /**
   * Mark the next response's cache-read drop as expected. Cached
   * microcompact emits cache_edits, the upstream re-prices the prefix,
   * cache_read_input_tokens drops — we know about it, don't flag it.
   */
  notifyCacheDeletion(sessionId?: string, agentId?: string): void {
    const key = makeTrackingKey(sessionId, agentId)
    if (!key) return
    const state = this.stateByKey.get(key)
    if (state) state.cacheDeletionsPending = true
  }

  /**
   * Reset the cache-read baseline after a boundary compaction. The next
   * response's cache_read tokens will naturally drop because the message
   * count just collapsed; treat the next reading as a fresh baseline.
   */
  notifyCompaction(sessionId?: string, agentId?: string): void {
    const key = makeTrackingKey(sessionId, agentId)
    if (!key) return
    const state = this.stateByKey.get(key)
    if (state) {
      state.prevCacheReadTokens = null
      state.pendingChanges = null
    }
  }

  /**
   * Drop all entries for a session. SessionLifecycleService.removeSession must
   * call this so long-lived servers don't leak per-session state.
   */
  cleanupSession(sessionId: string): void {
    if (!sessionId) return
    const prefix = `${sessionId}|`
    for (const key of this.stateByKey.keys()) {
      if (key === `${sessionId}|` || key.startsWith(prefix)) {
        this.stateByKey.delete(key)
      }
    }
  }

  /** Test-only helper. */
  resetForTests(): void {
    this.stateByKey.clear()
  }

  /** Test-only helper. */
  getTrackedKeysForTests(): string[] {
    return Array.from(this.stateByKey.keys())
  }

  private formatBreakReason(
    changes: PendingChanges | null,
    lastAssistantTimestampMs?: number
  ): string {
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(
          `model changed (${changes.previousModel} → ${changes.newModel})`
        )
      }
      if (changes.systemPromptChanged) {
        const delta = changes.systemCharDelta
        const charInfo =
          delta === 0
            ? ""
            : delta > 0
              ? ` (+${delta} chars)`
              : ` (${delta} chars)`
        parts.push(`system prompt changed${charInfo}`)
      }
      if (changes.toolSchemasChanged) {
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
            : " (tool prompt/schema changed, same tool set)"
        parts.push(`tools changed${toolDiff}`)
      }
      if (changes.cacheControlChanged && !changes.systemPromptChanged) {
        parts.push("cache_control changed (scope or TTL)")
      }
      if (changes.betasChanged) parts.push("betas changed")
      if (changes.fastModeChanged) parts.push("fast mode toggled")
      if (changes.cachedMCChanged) parts.push("cached microcompact toggled")
      if (changes.effortChanged) {
        parts.push(
          `effort changed (${changes.prevEffortValue || "default"} → ${changes.newEffortValue || "default"})`
        )
      }
      if (changes.extraBodyChanged) parts.push("extra body params changed")
    }
    if (parts.length > 0) return parts.join(", ")

    if (lastAssistantTimestampMs !== undefined) {
      const gapMs = Date.now() - lastAssistantTimestampMs
      if (gapMs > 60 * 60_000)
        return "possible 1h TTL expiry (prompt unchanged)"
      if (gapMs > 5 * 60_000)
        return "possible 5min TTL expiry (prompt unchanged)"
      return "likely server-side (prompt unchanged, <5min gap)"
    }
    return "unknown cause"
  }
}
