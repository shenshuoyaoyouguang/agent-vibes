import { Injectable } from "@nestjs/common"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  resolveAutoCompactTokenLimit,
  resolvePredictiveCompactTokenLimit,
} from "./context-auto-compact-policy"
import {
  ContextCompactionResult,
  ContextCompactionService,
} from "./context-compaction.service"
import { ContextManagerService } from "./context-manager.service"
import { TokenCounterService } from "./token-counter.service"
import { ContextConversationState, UnifiedMessage } from "./types"

export interface ContextRequestBudgetInput {
  backend: string
  protocolMaxTokens?: number
  backendMaxTokens?: number
  /**
   * Default budget when the protocol layer doesn't pin one. Caller
   * must supply either this or a positive `protocolMaxTokens` —
   * `resolveBudget` throws otherwise to surface budget bugs at the
   * call site instead of silently picking a magic number.
   */
  defaultMaxTokens?: number
  protectedContextTokens?: number
  systemPrompt?: string
  systemPromptTokens?: number
  toolDefinitions?: unknown
  backendSystemPromptTokens?: number
  fixedOverheadTokens?: number
  maxOutputTokens?: number
  requestedServiceTier?: string
}

export type ContextRequestBudgetSelectionSource = "protocol" | "default"

export interface ContextRequestBudgetDecision {
  selectionSource: ContextRequestBudgetSelectionSource
  protocolMaxTokens?: number
  backendMaxTokens?: number
  defaultMaxTokens?: number
  selectedMaxTokensBeforeBackendClamp: number
  backendClampedFrom?: number
  backendClampedTo?: number
  maxTokens: number
  protectedContextTokens: number
  promptSystemTokens: number
  toolDefinitionTokens: number
  backendSystemPromptTokens: number
  fixedOverheadTokens: number
  systemPromptTokens: number
  maxOutputTokens: number
  requestedServiceTier?: string
  autoCompactTokenLimit?: number
  predictiveCompactTokenLimit?: number
}

export interface ContextRequestBudget {
  maxTokens: number
  systemPromptTokens: number
  maxOutputTokens: number
  autoCompactTokenLimit?: number
  predictiveCompactTokenLimit?: number
  backendClampedFrom?: number
  backendClampedTo?: number
  decision: ContextRequestBudgetDecision
}

export interface ContextProjectionOptions {
  integrityMode?: "strict-adjacent" | "global"
  pendingToolUseIds?: Iterable<string>
  strategy?: "auto" | "manual" | "reactive"
  dryRun?: boolean
}

export type ContextProjectionBudget = Pick<
  ContextRequestBudget,
  | "maxTokens"
  | "systemPromptTokens"
  | "autoCompactTokenLimit"
  | "predictiveCompactTokenLimit"
>

@Injectable()
export class ContextRequestPlannerService {
  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly contextManager: ContextManagerService
  ) {}

  resolveBudget(input: ContextRequestBudgetInput): ContextRequestBudget {
    const protocolMaxTokens = this.normalizePositiveInteger(
      input.protocolMaxTokens
    )
    const backendMaxTokens = this.normalizePositiveInteger(
      input.backendMaxTokens
    )
    // The default budget is the caller's responsibility — they know
    // the context (CC CLI vs Cursor protocol vs Codex) and which
    // semantics make sense. Falling back to a magic number here
    // hides budget bugs at the call site (the previous 166_000
    // fallback was the source of UI showing "X / 166K context used"
    // even though the model advertised 200K). Accept only positive
    // values; reject ambiguous absence so call sites stay explicit.
    const defaultMaxTokens = this.normalizePositiveInteger(
      input.defaultMaxTokens
    )
    if (defaultMaxTokens === undefined && protocolMaxTokens === undefined) {
      throw new Error(
        "ContextRequestPlanner.resolveBudget: caller must supply a positive protocolMaxTokens or defaultMaxTokens"
      )
    }
    // After the guard above, at least one of the two is a positive
    // integer; the `||` selection below cannot fall to undefined.
    //
    // The backend limit is a hard cap, not the default request budget.
    // Cursor only sends a large protocol limit when the conversation/model is
    // actually in max-context mode; otherwise keep the normal default budget
    // and use backendMaxTokens only to clamp oversized protocol requests.
    const selectionSource: ContextRequestBudgetSelectionSource =
      protocolMaxTokens ? "protocol" : "default"
    const selectedMaxTokensBeforeBackendClamp = (protocolMaxTokens ||
      defaultMaxTokens) as number
    let maxTokens = selectedMaxTokensBeforeBackendClamp
    let backendClampedFrom: number | undefined
    let backendClampedTo: number | undefined
    if (backendMaxTokens && maxTokens > backendMaxTokens) {
      backendClampedFrom = maxTokens
      backendClampedTo = backendMaxTokens
      maxTokens = backendMaxTokens
    }

    const protectedContextTokens =
      this.normalizePositiveInteger(input.protectedContextTokens) ?? 0
    const promptSystemTokens =
      this.normalizePositiveInteger(input.systemPromptTokens) ??
      this.countSystemPromptTokens(input.systemPrompt)
    const toolDefinitionTokens = this.tokenCounter.countJsonValue(
      input.toolDefinitions
    )
    const backendSystemPromptTokens =
      this.normalizePositiveInteger(input.backendSystemPromptTokens) ?? 0
    const fixedOverheadTokens =
      this.normalizePositiveInteger(input.fixedOverheadTokens) ?? 0
    const systemPromptTokens =
      protectedContextTokens +
      promptSystemTokens +
      toolDefinitionTokens +
      backendSystemPromptTokens +
      fixedOverheadTokens

    const maxOutputTokens =
      this.normalizePositiveInteger(input.maxOutputTokens) ?? 0
    const autoCompactTokenLimit = resolveAutoCompactTokenLimit({
      backend: input.backend,
      maxTokens,
      maxOutputTokens,
      requestedServiceTier: input.requestedServiceTier,
    })
    const predictiveCompactTokenLimit = resolvePredictiveCompactTokenLimit({
      backend: input.backend,
      maxTokens,
      maxOutputTokens,
      requestedServiceTier: input.requestedServiceTier,
    })

    return {
      maxTokens,
      systemPromptTokens,
      maxOutputTokens,
      autoCompactTokenLimit,
      predictiveCompactTokenLimit,
      backendClampedFrom,
      backendClampedTo,
      decision: {
        selectionSource,
        protocolMaxTokens,
        backendMaxTokens,
        defaultMaxTokens,
        selectedMaxTokensBeforeBackendClamp,
        backendClampedFrom,
        backendClampedTo,
        maxTokens,
        protectedContextTokens,
        promptSystemTokens,
        toolDefinitionTokens,
        backendSystemPromptTokens,
        fixedOverheadTokens,
        systemPromptTokens,
        maxOutputTokens,
        requestedServiceTier: input.requestedServiceTier,
        autoCompactTokenLimit,
        predictiveCompactTokenLimit,
      },
    }
  }

  projectMessages(
    messages: UnifiedMessage[],
    snapshot: ContextAttachmentSnapshot,
    budget: ContextProjectionBudget,
    options?: ContextProjectionOptions
  ): ContextCompactionResult {
    return this.contextManager.buildBackendMessagesFromMessages(
      messages,
      snapshot,
      this.buildCompactionOptions(budget, options)
    )
  }

  projectState(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    budget: ContextProjectionBudget,
    options?: ContextProjectionOptions
  ): ContextCompactionResult {
    return this.contextManager.buildBackendMessages(
      state,
      snapshot,
      this.buildCompactionOptions(budget, options)
    )
  }

  private buildCompactionOptions(
    budget: ContextProjectionBudget,
    options?: ContextProjectionOptions
  ): Parameters<ContextCompactionService["ensureWithinBudget"]>[2] {
    return {
      maxTokens: budget.maxTokens,
      systemPromptTokens: budget.systemPromptTokens,
      autoCompactTokenLimit: budget.autoCompactTokenLimit,
      predictiveCompactTokenLimit: budget.predictiveCompactTokenLimit,
      integrityMode: options?.integrityMode,
      pendingToolUseIds: options?.pendingToolUseIds,
      strategy: options?.strategy || "auto",
      dryRun: options?.dryRun,
    }
  }

  private countSystemPromptTokens(systemPrompt?: string): number {
    if (!systemPrompt) {
      return 0
    }
    return this.tokenCounter.countMessages([
      {
        role: "user",
        content: systemPrompt,
      } as UnifiedMessage,
    ])
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }
}
