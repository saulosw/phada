export interface ToolBudget {
  calls: number
  bytes: number
}

export const DEFAULT_TOOL_BUDGET: ToolBudget = { calls: 40, bytes: 512_000 }

export const BUDGET_EXHAUSTED = 'Budget exhausted: finish the review with what you have.'
