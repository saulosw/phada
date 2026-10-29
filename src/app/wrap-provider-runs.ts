import type { ReviewProvider, TokenUsage } from '../providers/types.js'

export type ProviderRun = 'review' | 'skill'

export type RunWrapper = <T extends { usage?: TokenUsage }>(
  run: ProviderRun,
  work: () => Promise<T>,
) => Promise<T>

export function wrapProviderRuns(provider: ReviewProvider, wrap: RunWrapper): ReviewProvider {
  const runSkill = provider.runSkill?.bind(provider)
  return {
    id: provider.id,
    review: (prompt) => wrap('review', () => provider.review(prompt)),
    ...(runSkill === undefined
      ? {}
      : { runSkill: (request) => wrap('skill', () => runSkill(request)) }),
  }
}
