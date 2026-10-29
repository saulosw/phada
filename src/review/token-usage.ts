import type { TokenUsage } from '../providers/types.js'
import type { PassUsage } from './types.js'

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
