import type { ProviderName } from '../providers/types.js'
import type { AutomationView } from './read-automation.js'
import type { Fact, GitHubTokenSource, HomeLocal, HomeSlow } from './read-home.js'
import { nextStep } from './read-provider.js'
import type { NextStep } from './read-provider.js'
import type { QueueJob, QueueView } from './read-queue.js'

export type Recommendation =
  | { kind: 'checking'; github: boolean; ai: boolean }
  | { kind: 'fix-config'; file: string; error: string }
  | { kind: 'github-token'; command: string }
  | { kind: 'github-refused'; source: GitHubTokenSource; command: string }
  | { kind: 'init'; command: string }
  | { kind: 'ai'; provider: ProviderName; step: NextStep; command: string }
  | { kind: 'paused'; until: string; reason: string; command: string }
  | { kind: 'failed-jobs'; count: number; ref: string; error: string | null; command: string }
  | { kind: 'ci-skipped'; count: number; ref: string; failing: string[]; command: string }
  | { kind: 'index'; repo: string; count: number; command: string }
  | { kind: 'slack-tokens'; missing: string[]; command: string }
  | { kind: 'watch'; command: string }
  | { kind: 'review'; command: string }

export const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000

const GH_LOGIN = 'gh auth login'

export function recommend(local: HomeLocal, slow: HomeSlow, now: Date): Recommendation {
  const checking = (): Recommendation => ({
    kind: 'checking',
    github: slow.github.status === 'loading',
    ai: slow.providers.status === 'loading',
  })
  const automation = ready(local.automation)
  if (automation?.configError != null) {
    return { kind: 'fix-config', file: automation.configFile, error: automation.configError }
  }
  if (slow.github.status === 'loading') return checking()
  const github = ready(slow.github)
  if (github !== undefined && github.source === null) {
    return { kind: 'github-token', command: GH_LOGIN }
  }
  if (github?.source != null && github.account.state === 'refused') {
    return { kind: 'github-refused', source: github.source, command: GH_LOGIN }
  }
  if (automation !== undefined && !automation.configured) {
    return { kind: 'init', command: 'phada init --global' }
  }
  if (slow.providers.status === 'loading') return checking()
  const ai = aiStep(local, slow)
  if (ai !== undefined) return ai
  const queue = ready(local.queue)
  if (queue?.pause != null) {
    return {
      kind: 'paused',
      until: queue.pause.until,
      reason: queue.pause.reason,
      command: 'phada watch --status',
    }
  }
  const failed = queue === undefined ? [] : recentFailures(queue, now)
  const [lastFailed] = failed
  if (lastFailed !== undefined) {
    const ref = refOf(lastFailed)
    return {
      kind: 'failed-jobs',
      count: failed.length,
      ref,
      error: lastFailed.job.error ?? null,
      command: `phada review ${ref}`,
    }
  }
  const [skipped] = queue?.skippedForCi ?? []
  if (skipped !== undefined) {
    const ref = refOf(skipped)
    return {
      kind: 'ci-skipped',
      count: queue?.skippedForCi.length ?? 0,
      ref,
      failing: skipped.job.ciFailing ?? [],
      command: `phada review ${ref}`,
    }
  }
  const unindexed = (ready(local.repositories)?.repositories ?? []).filter(
    ({ origins, index }) => origins.includes('watched') && index.file === null,
  )
  const [first] = unindexed
  if (first !== undefined) {
    return {
      kind: 'index',
      repo: first.repo,
      count: unindexed.length,
      command: `phada index ${first.repo}`,
    }
  }
  const slackTokens = missingSlackTokens(automation)
  if (slackTokens.length > 0 && queue?.holder == null) {
    return {
      kind: 'slack-tokens',
      missing: slackTokens.map(({ variable }) => variable),
      command: `export ${slackTokens.map(({ variable, example }) => `${variable}=${example}`).join(' ')}`,
    }
  }
  if (automation?.watch != null && queue !== undefined && queue.holder === null) {
    return { kind: 'watch', command: 'phada watch' }
  }
  return { kind: 'review', command: 'phada review owner/repo#N' }
}

function missingSlackTokens(
  automation: AutomationView | undefined,
): { variable: string; example: string }[] {
  const tokens = automation?.sources.slack?.tokens
  if (tokens === undefined) return []
  return [
    { ...tokens.bot, example: 'xoxb-…' },
    { ...tokens.app, example: 'xapp-…' },
  ].filter(({ set }) => !set)
}

function aiStep(local: HomeLocal, slow: HomeSlow): Recommendation | undefined {
  const report = ready(slow.providers)
  if (report === undefined) return undefined
  const choice = ready(local.setup)?.choice ?? report.choice
  const status = report.providers.find(({ provider }) => provider === choice.provider)
  const step =
    status === undefined ? undefined : nextStep({ ...status, chosen: true }, choice.model)
  return step === undefined
    ? undefined
    : { kind: 'ai', provider: choice.provider, step, command: step.command }
}

export function recentFailures(queue: QueueView, now: Date): QueueJob[] {
  return queue.failed.filter(
    ({ job }) => now.getTime() - Date.parse(job.finishedAt ?? job.createdAt) < RECENT_FAILURE_MS,
  )
}

function refOf({ job }: QueueJob): string {
  return `${job.repo}#${job.number}`
}

function ready<T>(fact: Fact<T>): T | undefined {
  return fact.status === 'ready' ? fact.value : undefined
}
