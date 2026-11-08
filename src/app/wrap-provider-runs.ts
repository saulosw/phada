import type { ReviewProvider, TokenUsage } from '../providers/types.js'

export type ProviderRun = 'review' | 'skill' | 'fix'

export type RunWrapper = <T extends { usage?: TokenUsage }>(
  run: ProviderRun,
  work: () => Promise<T>,
) => Promise<T>

export function wrapProviderRuns(provider: ReviewProvider, wrap: RunWrapper): ReviewProvider {
  const runSkill = provider.runSkill?.bind(provider)
  const fix = provider.fix?.bind(provider)
  return {
    id: provider.id,
    ...(provider.concurrency === undefined ? {} : { concurrency: provider.concurrency }),
    review: (prompt) => wrap('review', () => provider.review(prompt)),
    ...(runSkill === undefined
      ? {}
      : { runSkill: (request) => wrap('skill', () => runSkill(request)) }),
    ...(fix === undefined ? {} : { fix: (request) => wrap('fix', () => fix(request)) }),
  }
}
