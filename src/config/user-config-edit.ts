import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, Node, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import { parseConfigText } from './parse-config.js'
import type { ConfigFile } from './schema.js'

export type SettingKey = 'provider' | 'model' | 'language'

export type UserConfigChange =
  | { kind: 'set'; key: SettingKey; value: string }
  | { kind: 'unset'; key: SettingKey }
  | { kind: 'watch'; repo: string }
  | { kind: 'unwatch'; repo: string }
  | { kind: 'publish'; repo: string; publish: boolean }

export type ValueChange =
  | { key: SettingKey; before: string | null; after: string | null }
  | { key: 'watch.repos'; added: string[]; removed: string[] }
  | { key: 'publish'; repo: string; before: boolean; after: boolean }

export interface UserConfigPlan {
  path: string
  exists: boolean
  before: string | null
  text: string
  changes: ValueChange[]
}

type ChangeRefusal =
  | { ok: false; reason: 'last-watched-repo'; repo: string; settings: string[] }
  | { ok: false; reason: 'not-watched'; repo: string }

export type PlannedUserConfig =
  | { ok: true; plan: UserConfigPlan }
  | { ok: false; reason: 'invalid-config' | 'invalid-result'; message: string }
  | { ok: false; reason: 'ollama-without-model' }
  | ChangeRefusal

export interface UserConfigEdit {
  path: string
  current: string | null
  template: string
  changes: readonly UserConfigChange[]
}

const SETTING_KEYS: readonly SettingKey[] = ['provider', 'model', 'language']
const WATCH_REPOS = ['watch', 'repos']

export function planUserConfigEdit(edit: UserConfigEdit): PlannedUserConfig {
  const { path, current } = edit
  const withTemplate = (text: string) => (current === null ? `${text}\n${edit.template}` : text)
  const parsedBefore = parseConfigText(current ?? '')
  if (!parsedBefore.ok) {
    return { ok: false, reason: 'invalid-config', message: parsedBefore.message }
  }
  const doc = parseDocument(current ?? '')
  for (const change of edit.changes) {
    const refusal = applyChange(doc, change)
    if (refusal !== undefined) return refusal
  }
  const rendered = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
  const parsedAfter = parseConfigText(rendered)
  if (!parsedAfter.ok) {
    return { ok: false, reason: 'invalid-result', message: parsedAfter.message }
  }
  if (ollamaWithoutModel(parsedBefore.config, parsedAfter.config, edit.changes)) {
    return { ok: false, reason: 'ollama-without-model' }
  }
  const changes = valueChanges(parsedBefore.config, parsedAfter.config)
  return {
    ok: true,
    plan: {
      path,
      exists: current !== null,
      before: current,
      text: changes.length === 0 && current !== null ? current : withTemplate(rendered),
      changes,
    },
  }
}

function applyChange(doc: Document, change: UserConfigChange): ChangeRefusal | undefined {
  switch (change.kind) {
    case 'set':
      doc.set(change.key, change.value)
      return undefined
    case 'unset':
      if (isMap(doc.contents)) doc.delete(change.key)
      return undefined
    case 'watch':
      return watch(doc, change.repo)
    case 'unwatch':
      return unwatch(doc, change.repo)
    case 'publish':
      return setPublish(doc, change.repo, change.publish)
  }
}

function watch(doc: Document, repo: string): undefined {
  const repos = watchedRepos(doc)
  if (repos === undefined) doc.setIn(WATCH_REPOS, [repo])
  else if (indexOfRepo(repos, repo) === -1) repos.add(doc.createNode(repo))
  return undefined
}

function unwatch(doc: Document, repo: string): ChangeRefusal | undefined {
  const repos = watchedRepos(doc)
  const index = repos === undefined ? -1 : indexOfRepo(repos, repo)
  if (repos === undefined || index === -1) return undefined
  if (repos.items.length > 1) {
    repos.delete(index)
    return undefined
  }
  const watchBlock = doc.get('watch')
  const settings = isMap(watchBlock)
    ? watchBlock.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key))
    : []
  const others = settings.filter((key) => key !== 'repos')
  if (others.length > 0) return { ok: false, reason: 'last-watched-repo', repo, settings: others }
  doc.delete('watch')
  return undefined
}

function setPublish(doc: Document, repo: string, publish: boolean): ChangeRefusal | undefined {
  const repos = watchedRepos(doc)
  const index = repos === undefined ? -1 : indexOfRepo(repos, repo)
  if (repos === undefined || index === -1) return { ok: false, reason: 'not-watched', repo }
  const entry = repos.items[index]
  if (isMap(entry)) {
    if (publish) entry.delete('publish')
    else entry.set('publish', false)
    const name = entry.get('repo', true)
    if (entry.items.length === 1 && isScalar(name)) {
      repos.items[index] = asPlainName(doc, entry, name)
    }
  } else if (isScalar(entry) && !publish) {
    repos.items[index] = asObject(doc, entry)
  }
  return undefined
}

function asObject(doc: Document, entry: Scalar): Node {
  const object = doc.createNode({ repo: entry.value, publish: false })
  const name = object.get('repo', true)
  if (isScalar(name)) name.comment = entry.comment
  object.commentBefore = entry.commentBefore
  object.spaceBefore = entry.spaceBefore
  return object
}

function asPlainName(doc: Document, entry: YAMLMap, name: Scalar): Node {
  const plain = doc.createNode(name.value)
  plain.comment = name.comment ?? entry.comment
  plain.commentBefore = entry.commentBefore
  plain.spaceBefore = entry.spaceBefore
  return plain
}

function watchedRepos(doc: Document): YAMLSeq | undefined {
  const repos = doc.getIn(WATCH_REPOS)
  return isSeq(repos) ? repos : undefined
}

function indexOfRepo(repos: YAMLSeq, repo: string): number {
  const wanted = repo.trim().toLowerCase()
  return repos.items.findIndex((item) => {
    const name = isScalar(item) ? item.value : isMap(item) ? item.get('repo') : undefined
    return typeof name === 'string' && name.trim().toLowerCase() === wanted
  })
}

function ollamaWithoutModel(
  before: ConfigFile,
  after: ConfigFile,
  changes: readonly UserConfigChange[],
): boolean {
  if (after.provider !== 'ollama') return false
  if (after.model === undefined) return true
  const switched = before.provider !== 'ollama'
  return switched && !changes.some((change) => change.kind === 'set' && change.key === 'model')
}

function valueChanges(before: ConfigFile, after: ConfigFile): ValueChange[] {
  return [...settingChanges(before, after), ...watchChanges(before, after)]
}

function settingChanges(before: ConfigFile, after: ConfigFile): ValueChange[] {
  return SETTING_KEYS.flatMap((key) => {
    const was = before[key] ?? null
    const now = after[key] ?? null
    return was === now ? [] : [{ key, before: was, after: now }]
  })
}

function watchChanges(before: ConfigFile, after: ConfigFile): ValueChange[] {
  const was = publishByRepo(before)
  const now = publishByRepo(after)
  const added = [...now.values()].filter(({ key }) => !was.has(key)).map(({ name }) => name)
  const removed = [...was.values()].filter(({ key }) => !now.has(key)).map(({ name }) => name)
  const publish = [...now.values()].flatMap(({ key, name, publish: after }) => {
    const earlier = was.get(key)
    return earlier === undefined || earlier.publish === after
      ? []
      : [{ key: 'publish' as const, repo: name, before: earlier.publish, after }]
  })
  return [
    ...(added.length + removed.length === 0
      ? []
      : [{ key: 'watch.repos' as const, added, removed }]),
    ...publish,
  ]
}

interface WatchedEntry {
  key: string
  name: string
  publish: boolean
}

function publishByRepo(config: ConfigFile): Map<string, WatchedEntry> {
  return new Map(
    (config.watch?.repos ?? []).map((entry) => {
      const name = typeof entry === 'string' ? entry : entry.repo
      const publish = typeof entry === 'string' || entry.publish !== false
      return [name.toLowerCase(), { key: name.toLowerCase(), name, publish }]
    }),
  )
}
