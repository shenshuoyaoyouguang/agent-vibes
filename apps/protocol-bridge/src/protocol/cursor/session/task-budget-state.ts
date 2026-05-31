export interface SessionTaskBudgetState {
  type: "tokens"
  total: number
  remaining?: number
  updatedAt: number
  compactionDeductions: SessionTaskBudgetCompactionDeduction[]
}

export interface SessionTaskBudgetCompactionDeduction {
  compactionId: string
  preCompactContextTokens: number
  remainingBefore: number
  remainingAfter: number
  deductedAt: number
}

export interface TaskBudgetParam {
  type: "tokens"
  total: number
  remaining?: number
}

export function normalizeTaskBudgetTotal(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }
  if (typeof value !== "string") return undefined
  const match = value.trim().match(/-?\d+/)
  if (!match?.[0]) return undefined
  const parsed = Number.parseInt(match[0], 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

export function createSessionTaskBudgetState(params: {
  total: number
  now: number
}): SessionTaskBudgetState {
  return {
    type: "tokens",
    total: Math.floor(params.total),
    updatedAt: params.now,
    compactionDeductions: [],
  }
}

export function syncSessionTaskBudgetTotal(
  current: SessionTaskBudgetState | undefined,
  params: {
    total: number
    now: number
  }
): SessionTaskBudgetState {
  const total = Math.floor(params.total)
  if (!current || current.total !== total) {
    return createSessionTaskBudgetState({
      total,
      now: params.now,
    })
  }
  return {
    ...current,
    updatedAt: params.now,
  }
}

export function applyTaskBudgetCompactionDeduction(
  current: SessionTaskBudgetState | undefined,
  params: {
    compactionId: string
    preCompactContextTokens: number
    now: number
  }
): SessionTaskBudgetState | undefined {
  if (!current) return undefined
  if (
    current.compactionDeductions.some(
      (deduction) => deduction.compactionId === params.compactionId
    )
  ) {
    return current
  }

  const preCompactContextTokens = Math.max(
    0,
    Math.floor(params.preCompactContextTokens)
  )
  const remainingBefore = current.remaining ?? current.total
  const remainingAfter = Math.max(0, remainingBefore - preCompactContextTokens)

  return {
    ...current,
    remaining: remainingAfter,
    updatedAt: params.now,
    compactionDeductions: [
      ...current.compactionDeductions,
      {
        compactionId: params.compactionId,
        preCompactContextTokens,
        remainingBefore,
        remainingAfter,
        deductedAt: params.now,
      },
    ],
  }
}

export function toTaskBudgetParam(
  state: SessionTaskBudgetState | undefined
): TaskBudgetParam | undefined {
  if (!state) return undefined
  return {
    type: "tokens",
    total: state.total,
    ...(state.remaining !== undefined ? { remaining: state.remaining } : {}),
  }
}
