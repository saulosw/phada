import { DEFAULT_CI, mergeConfig, resolveProvider } from '../config/merge-config.js'
import type { ResolvedRule } from '../config/merge-config.js'
import type { ConfigFile } from '../config/schema.js'
import { layerOrigin } from '../config/layer-label.js'
import type { ConfigLayer } from '../config/types.js'
import { resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchedRepoSettings } from '../config/watch-settings.js'
import { durationMs } from '../config/duration.js'
import { DEFAULT_MIN_CONFIDENCE } from '../review/run-review.js'
import type { PublishTarget } from '../watch/types.js'
import type { HistoryStore, ListedRun, RepoRecord, RunRecord } from '../store/history-store.js'
import { errorMessage } from './error-message.js'

export type RepositoryOrigin = 'watched' | 'own-config' | 'history'
export type SettingOrigin = 'global' | 'repository' | 'default'
export type RepositoryHistory = Pick<HistoryStore, 'status' | 'runs'>

export interface IndexFile {
  path: string
  bytes: number
}

export interface RepositoryReaders {
  configFile: string
  topLevelLayers(): Promise<ConfigLayer[]>
  userLayers(repo: string): Promise<ConfigLayer[]>
  userRepoConfigs(): Promise<string[]>
  history(): Promise<RepositoryHistory | undefined>
  indexFile(repo: string): Promise<IndexFile | null>
}

export interface RepositoryIndex {
  file: IndexFile | null
  indexedSha: string | null
  checkedAt: string | null
}

export interface ListedRepository {
  repo: string
  origins: RepositoryOrigin[]
  publish: PublishTarget | null
  index: RepositoryIndex
  lastReview: RunRecord | null
}

export interface RepositoryList {
  configFile: string
  configured: boolean
  configError: string | null
  watching: boolean
  repositories: ListedRepository[]
}

export type SettingValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'flag'; on: boolean }
  | { kind: 'duration'; ms: number }
  | { kind: 'list'; items: string[] }

export interface ConfigSetting {
  key: string
  value: SettingValue | null
  origin: SettingOrigin
}

export interface UserRule {
  key: string
  name: string
  text: string
  origin: SettingOrigin
}

export interface RelatedRepository {
  repo: string
  description?: string
  origin: SettingOrigin
}

export type RepositoryConfig =
  | { status: 'read'; settings: ConfigSetting[]; rules: UserRule[]; warnings: string[] }
  | { status: 'invalid'; error: string }

export interface RepositoryDetail {
  repo: string
  configFile: string
  origins: RepositoryOrigin[]
  config: RepositoryConfig
  watch: WatchedRepoSettings | null
  index: RepositoryIndex
  related: RelatedRepository[]
  reviews: { runs: ListedRun[]; total: number }
}

export const REVIEWS_PER_REPOSITORY = 5

interface LocalState {
  topLevel: { layers: ConfigLayer[] } | { error: string }
  watched: WatchedRepoSettings[]
  ownConfig: string[]
  history: RepositoryHistory | undefined
  records: Map<string, RepoRecord>
  lastRuns: Map<string, RunRecord>
}

export async function readRepositories(readers: RepositoryReaders): Promise<RepositoryList> {
  const state = await readLocalState(readers)
  const names = new Set([
    ...state.watched.map(({ repo }) => repo),
    ...state.ownConfig,
    ...state.records.keys(),
    ...state.lastRuns.keys(),
  ])
  const repositories = await Promise.all(
    [...names].map(async (repo) => ({
      repo,
      origins: originsOf(repo, state),
      publish: state.watched.find((entry) => entry.repo === repo)?.publish ?? null,
      index: await indexOf(repo, state, readers),
      lastReview: state.lastRuns.get(repo) ?? null,
    })),
  )
  repositories.sort(
    (a, b) => originRank(a.origins) - originRank(b.origins) || (a.repo < b.repo ? -1 : 1),
  )
  const configError = 'error' in state.topLevel ? state.topLevel.error : null
  return {
    configFile: readers.configFile,
    configured:
      configError !== null ||
      ('layers' in state.topLevel && state.topLevel.layers.length > 0) ||
      state.ownConfig.length > 0,
    configError,
    watching: state.watched.length > 0,
    repositories,
  }
}

export async function readRepository(
  readers: RepositoryReaders,
  name: string,
): Promise<RepositoryDetail> {
  const repo = name.toLowerCase()
  const state = await readLocalState(readers)
  const layers = await readers.userLayers(repo).then(
    (read) => ({ layers: read }),
    (error: unknown) => ({ error: errorMessage(error) }),
  )
  const merged = 'layers' in layers ? mergeConfig(layers.layers) : undefined
  return {
    repo,
    configFile: readers.configFile,
    origins: originsOf(repo, state),
    config:
      'layers' in layers && merged !== undefined
        ? {
            status: 'read',
            settings: userSettings(layers.layers),
            rules: userRules(merged.rules),
            warnings: merged.warnings,
          }
        : { status: 'invalid', error: 'error' in layers ? layers.error : '' },
    watch: state.watched.find((entry) => entry.repo === repo) ?? null,
    index: await indexOf(repo, state, readers),
    related: (merged?.repos ?? [])
      .map(({ repo: related, description, origin }) => ({
        repo: related,
        ...(description === undefined ? {} : { description }),
        origin: settingOrigin(origin),
      }))
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    reviews: state.history?.runs({ repo, limit: REVIEWS_PER_REPOSITORY }) ?? {
      runs: [],
      total: 0,
    },
  }
}

async function readLocalState(readers: RepositoryReaders): Promise<LocalState> {
  const [topLevel, ownConfig, history] = await Promise.all([
    readers.topLevelLayers().then(
      (layers) => ({ layers }),
      (error: unknown) => ({ error: errorMessage(error) }),
    ),
    readers.userRepoConfigs(),
    readers.history(),
  ])
  const status = history?.status()
  return {
    topLevel,
    watched: 'layers' in topLevel ? (resolveWatchSettings(topLevel.layers)?.repos ?? []) : [],
    ownConfig: ownConfig.map((repo) => repo.toLowerCase()),
    history,
    records: new Map((status?.repos ?? []).map((record) => [record.repo.toLowerCase(), record])),
    lastRuns: new Map((status?.lastRuns ?? []).map((run) => [run.repo.toLowerCase(), run])),
  }
}

const ORIGIN_ORDER: readonly RepositoryOrigin[] = ['watched', 'own-config', 'history']

function originRank([first]: readonly RepositoryOrigin[]): number {
  return first === undefined ? ORIGIN_ORDER.length : ORIGIN_ORDER.indexOf(first)
}

function originsOf(repo: string, state: LocalState): RepositoryOrigin[] {
  return [
    ...(state.watched.some((entry) => entry.repo === repo) ? (['watched'] as const) : []),
    ...(state.ownConfig.includes(repo) ? (['own-config'] as const) : []),
    ...(state.records.has(repo) || state.lastRuns.has(repo) ? (['history'] as const) : []),
  ]
}

async function indexOf(
  repo: string,
  state: LocalState,
  readers: RepositoryReaders,
): Promise<RepositoryIndex> {
  const record = state.records.get(repo)
  return {
    file: await readers.indexFile(repo),
    indexedSha: record?.indexedSha ?? null,
    checkedAt: record?.branchCheckedAt ?? null,
  }
}

export function userRules(rules: readonly ResolvedRule[]): UserRule[] {
  return rules.map(({ key, text, origin }) => ({
    key,
    name: layerOrigin(key).name,
    text,
    origin: settingOrigin(origin),
  }))
}

function settingOrigin(label: string): SettingOrigin {
  return layerOrigin(label).kind === 'repository' ? 'repository' : 'global'
}

type Read = (config: ConfigFile) => unknown

export function userSettings(layers: readonly ConfigLayer[]): ConfigSetting[] {
  const ordered: [ConfigLayer | undefined, SettingOrigin][] = [
    [layers.find((layer) => layer.kind === 'user-repo'), 'repository'],
    [layers.find((layer) => layer.kind === 'user'), 'global'],
  ]
  const first = <T>(
    key: string,
    read: (config: ConfigFile) => T | undefined,
    toValue: (value: T) => SettingValue,
    fallback: SettingValue | null = null,
  ): ConfigSetting => {
    for (const [layer, origin] of ordered) {
      const value = layer === undefined ? undefined : read(layer.config)
      if (value !== undefined) return { key, value: toValue(value), origin }
    }
    return { key, value: fallback, origin: 'default' }
  }
  const each = (key: string, read: (config: ConfigFile) => string[] | undefined) =>
    ordered.flatMap(([layer, origin]): ConfigSetting[] => {
      const items = layer === undefined ? undefined : read(layer.config)
      return items === undefined || items.length === 0
        ? []
        : [{ key, value: { kind: 'list', items }, origin }]
    })
  const text = (value: string): SettingValue => ({ kind: 'text', text: value })
  const flag = (on: boolean): SettingValue => ({ kind: 'flag', on })
  const duration = (value: string): SettingValue => ({ kind: 'duration', ms: durationMs(value) })
  const list = (items: string[]): SettingValue => ({ kind: 'list', items })
  return [
    ...providerSettings(ordered),
    first('language', (config) => config.language, text, text('en')),
    first(
      'minConfidence',
      (config) => config.minConfidence,
      (value) => ({ kind: 'number', value }),
      { kind: 'number', value: DEFAULT_MIN_CONFIDENCE },
    ),
    first('verify', (config) => config.verify, flag, flag(true)),
    first('investigate', (config) => config.investigate, flag, flag(true)),
    first('resolveThreads', (config) => config.resolveThreads, flag, flag(true)),
    first('conversation', (config) => config.conversation, flag, flag(true)),
    first('ci.read', (config) => config.ci?.read, flag, flag(DEFAULT_CI.read)),
    first('ci.wait', (config) => config.ci?.wait, duration, {
      kind: 'duration',
      ms: DEFAULT_CI.waitMs,
    }),
    first('ci.onFailure', (config) => config.ci?.onFailure, text, text(DEFAULT_CI.onFailure)),
    first('ci.checks', (config) => config.ci?.checks, list),
    first('context.defaults', (config) => config.context?.defaults, flag, flag(true)),
    first(
      'context.privateOnPublic',
      (config) => config.context?.privateOnPublic,
      flag,
      flag(false),
    ),
    first(
      'review.prompt',
      (config) => config.review?.prompt,
      (prompt) => text(`${prompt.file} (${prompt.mode ?? 'append'})`),
    ),
    first(
      'review.skills',
      (config) => (config.review?.skills?.length === 0 ? undefined : config.review?.skills),
      (skills) => list(skills.map((entry) => (typeof entry === 'string' ? entry : entry.name))),
    ),
    first(
      'review.commands',
      (config) => config.review?.commands,
      (commands) => (Array.isArray(commands) ? list(commands) : text(commands)),
    ),
    first('review.readDirs', (config) => config.review?.readDirs, list),
    first('review.timeout', (config) => config.review?.timeout, duration),
    ...each('mcp', (config) =>
      config.mcp?.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
    ),
    ...each('ignore', (config) => config.ignore),
    ...each('disabledRules', (config) => config.disabledRules),
    ...each('localFiles', (config) => config.localFiles),
    ...each('context.files', (config) => config.context?.files?.map(({ path }) => path)),
  ]
}

function providerSettings(ordered: readonly [ConfigLayer | undefined, SettingOrigin][]) {
  const layers = ordered.flatMap(([layer]) => (layer === undefined ? [] : [layer]))
  const choice = resolveProvider({}, layers)
  const originOf = (read: Read): SettingOrigin =>
    ordered.find(([layer]) => layer !== undefined && read(layer.config) !== undefined)?.[1] ??
    'default'
  const providerOrigin = originOf((config) => config.provider)
  const modelOrigin =
    choice.model === undefined
      ? 'default'
      : (ordered.find(([layer]) => layer?.config.model === choice.model)?.[1] ?? 'default')
  return [
    {
      key: 'provider',
      value: { kind: 'text', text: choice.provider },
      origin: providerOrigin,
    },
    {
      key: 'model',
      value: choice.model === undefined ? null : { kind: 'text', text: choice.model },
      origin: modelOrigin,
    },
  ] satisfies ConfigSetting[]
}
