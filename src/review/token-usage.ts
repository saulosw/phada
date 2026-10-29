import type { TokenUsage } from '../providers/types.js'
import type { PassUsage, RecheckReport } from './types.js'

export interface UsageReport {
  passes: PassUsage[]
  total?: TokenUsage
}

export function sumUsage(
  first: TokenUsage | undefined,
  second: TokenUsage | undefined,
): TokenUsage | undefined {
  if (first === undefined || second === undefined) return first ?? second
  const cached =
    first.cachedInputTokens === undefined && second.cachedInputTokens === undefined
      ? undefined
      : (first.cachedInputTokens ?? 0) + (second.cachedInputTokens ?? 0)
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    outputTokens: first.outputTokens + second.outputTokens,
  }
}

export function totalUsage(passes: readonly PassUsage[]): TokenUsage | undefined {
  return passes.reduce<TokenUsage | undefined>(
    (total, { usage }) => sumUsage(total, usage),
    undefined,
  )
}

export function usageReport(
  reviewPasses: readonly PassUsage[] | undefined,
  recheck: RecheckReport | undefined,
): UsageReport {
  const asked = recheck?.verdicts.some(({ by }) => by === 'ai') === true
  const passes: PassUsage[] = [
    ...(reviewPasses ?? []),
    ...(asked
      ? [
          {
            pass: 'recheck' as const,
            ...(recheck?.usage === undefined ? {} : { usage: recheck.usage }),
          },
        ]
      : []),
  ]
  const total = totalUsage(passes)
  return { passes, ...(total === undefined ? {} : { total }) }
}
