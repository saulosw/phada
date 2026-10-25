import { mergeConfig } from '../config/merge-config.js'
import type { ConfigLayer } from '../config/types.js'
import { DEFAULT_IGNORE } from '../context/ignore.js'
import { listContext } from '../context/list-context.js'
import { loadContext } from '../context/load-context.js'
import type { ContextReport, ContextSources } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import type { RepositoryInfo } from '../github/repository.js'
import { configuredLens } from './review-passes.js'
import type { ConfiguredLens } from './review-passes.js'
import { userRules } from './read-repositories.js'
import type { UserRule } from './read-repositories.js'

export interface RulesReaders {
  fetchPullRequest(number: number): Promise<Pick<PullRequest, 'diff' | 'baseSha'>>
  fetchRepository(): Promise<Pick<RepositoryInfo, 'empty' | 'defaultBranch'>>
  sourcesAt(ref: string): ContextSources
}

export type RulesTarget = { kind: 'pull-request'; number: number } | { kind: 'default-branch' }

export type RepositoryRules =
  | { status: 'empty' }
  | {
      status: 'read'
      target:
        | { kind: 'pull-request'; number: number; baseSha: string }
        | { kind: 'default-branch'; ref: string }
      report: ContextReport
      ignore: string[]
      lens: ConfiguredLens
    }

export interface LocalRules {
  lens: ConfiguredLens
  rules: UserRule[]
  warnings: string[]
}

export function localRules(userLayers: readonly ConfigLayer[]): LocalRules {
  const merged = mergeConfig(userLayers)
  return {
    lens: configuredLens(merged.review),
    rules: userRules(merged.rules),
    warnings: merged.warnings,
  }
}

export async function readRules(input: {
  target: RulesTarget
  userLayers: readonly ConfigLayer[]
  readers: RulesReaders
}): Promise<RepositoryRules> {
  const { target, userLayers, readers } = input
  if (target.kind === 'pull-request') {
    const { diff, baseSha } = await readers.fetchPullRequest(target.number)
    const loaded = await loadContext({
      diff,
      baseSha,
      userLayers,
      sources: await withTreeRead(readers.sourcesAt(baseSha)),
    })
    return {
      status: 'read',
      target: { kind: 'pull-request', number: target.number, baseSha },
      report: loaded.report,
      ignore: [...DEFAULT_IGNORE, ...loaded.ignore],
      lens: configuredLens(loaded.options.review),
    }
  }
  const info = await readers.fetchRepository()
  if (info.empty || info.defaultBranch === undefined) return { status: 'empty' }
  const ref = info.defaultBranch
  const listed = await listContext({
    ref,
    userLayers,
    sources: await withTreeRead(readers.sourcesAt(ref)),
  })
  return {
    status: 'read',
    target: { kind: 'default-branch', ref },
    report: listed.report,
    ignore: listed.ignore,
    lens: configuredLens(listed.review),
  }
}

async function withTreeRead(sources: ContextSources): Promise<ContextSources> {
  const tree = await sources.readTree()
  return { ...sources, readTree: async () => tree }
}
