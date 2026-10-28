import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import { mergeLayers } from '../context/load-context.js'
import { phadaFiles } from '../context/phada-paths.js'
import { readPackages } from '../graph/packages.js'
import type { PackageRef, RepositoryPackages } from '../graph/packages.js'
import { hasLink, linkRepositories } from '../graph/repository-links.js'
import type { LocalMirror, MirrorOpening, TreeFile } from '../repository/git-mirror.js'
import type { IndexOpening, IndexVersion } from '../store/index-store.js'
import { errorMessage } from './error-message.js'

export type { PackageRef } from '../graph/packages.js'

export interface ConnectionReaders {
  repositories(): Promise<string[]>
  userLayers(repo: string): Promise<ConfigLayer[]>
  openIndex(repo: string): Promise<IndexOpening>
  openMirror(repo: string): Promise<MirrorOpening>
}

export type NotIndexed =
  | { reason: 'no-index' }
  | { reason: 'empty' }
  | { reason: 'other-version'; found: IndexVersion; expected: IndexVersion }
  | { reason: 'unreadable'; error: string }
  | { reason: 'no-mirror' }
  | { reason: 'mirror-unreadable'; error: string }

export type ConnectionSource =
  { state: 'read'; commit: string } | { state: 'not-indexed'; why: NotIndexed }

export type RelatedLink =
  | { state: 'linked'; publishes: PackageRef[]; uses: PackageRef[] }
  | { state: 'no-link' }
  | { state: 'not-indexed'; why: NotIndexed }
  | { state: 'unknown' }

export interface Connection {
  repo: string
  description?: string
  link: RelatedLink
}

export type DeclaredConnections =
  | { status: 'read'; related: Connection[]; configError: string | null; warnings: string[] }
  | { status: 'invalid'; error: string }

export interface RepositoryConnections {
  repo: string
  source: ConnectionSource
  declared: DeclaredConnections
}

export interface Connections {
  repositories: RepositoryConnections[]
}

type LocalRead =
  | { state: 'read'; commit: string; packages: RepositoryPackages; config: string | null }
  | { state: 'not-indexed'; why: NotIndexed }

const ROOT_CONFIG = phadaFiles('').config

export async function readConnections(readers: ConnectionReaders): Promise<Connections> {
  const reads = new Map<string, Promise<LocalRead>>()
  const local = (repo: string): Promise<LocalRead> => {
    const key = repo.toLowerCase()
    const known = reads.get(key)
    if (known !== undefined) return known
    const read = readLocal(repo, readers)
    reads.set(key, read)
    return read
  }
  const repos = await readers.repositories()
  return {
    repositories: await Promise.all(repos.map((repo) => connectionsOf(repo, readers, local))),
  }
}

async function connectionsOf(
  repo: string,
  readers: ConnectionReaders,
  local: (repo: string) => Promise<LocalRead>,
): Promise<RepositoryConnections> {
  const own = await local(repo)
  const source: ConnectionSource =
    own.state === 'read' ? { state: 'read', commit: own.commit } : own
  let userLayers: ConfigLayer[]
  try {
    userLayers = await readers.userLayers(repo)
  } catch (error) {
    return { repo, source, declared: { status: 'invalid', error: errorMessage(error) } }
  }
  const parsed = own.state === 'read' && own.config !== null ? parseConfigText(own.config) : null
  const repositoryLayers: ConfigLayer[] =
    parsed?.ok === true
      ? [{ kind: 'repo-root', dir: '', configLabel: ROOT_CONFIG, config: parsed.config }]
      : []
  const merged = mergeLayers(userLayers, repositoryLayers)
  const declared = merged.repos.filter(
    (related) => related.repo.toLowerCase() !== repo.toLowerCase(),
  )
  const related = await Promise.all(
    declared.map(async ({ repo: name, description }): Promise<Connection> => {
      const other = await local(name)
      return {
        repo: name,
        ...(description === undefined ? {} : { description }),
        link: linkOf(own, other),
      }
    }),
  )
  return {
    repo,
    source,
    declared: {
      status: 'read',
      related,
      configError: parsed?.ok === false ? parsed.message : null,
      warnings: merged.warnings,
    },
  }
}

function linkOf(own: LocalRead, other: LocalRead): RelatedLink {
  if (other.state === 'not-indexed') return other
  if (own.state === 'not-indexed') return { state: 'unknown' }
  const link = linkRepositories(own.packages, other.packages)
  return hasLink(link)
    ? { state: 'linked', publishes: link.consumedByRelated, uses: link.consumedByReviewed }
    : { state: 'no-link' }
}

async function readLocal(repo: string, readers: ConnectionReaders): Promise<LocalRead> {
  const snapshot = await snapshotOf(repo, readers)
  if (typeof snapshot !== 'string') return { state: 'not-indexed', why: snapshot }
  let opening: MirrorOpening
  try {
    opening = await readers.openMirror(repo)
  } catch (error) {
    return notIndexed({ reason: 'mirror-unreadable', error: errorMessage(error) })
  }
  if (opening.status === 'missing') return notIndexed({ reason: 'no-mirror' })
  try {
    const files = await opening.mirror.listFiles(snapshot)
    const readText = textReader(opening.mirror, files)
    const paths = new Set(files.map((file) => file.path))
    return {
      state: 'read',
      commit: snapshot,
      packages: await readPackages(paths, readText),
      config: paths.has(ROOT_CONFIG) ? await readText(ROOT_CONFIG) : null,
    }
  } catch (error) {
    return notIndexed({ reason: 'mirror-unreadable', error: errorMessage(error) })
  }
}

async function snapshotOf(repo: string, readers: ConnectionReaders): Promise<string | NotIndexed> {
  let opening: IndexOpening
  try {
    opening = await readers.openIndex(repo)
  } catch (error) {
    return { reason: 'unreadable', error: errorMessage(error) }
  }
  switch (opening.status) {
    case 'missing':
      return { reason: 'no-index' }
    case 'unreadable':
      return { reason: 'unreadable', error: opening.error.message }
    case 'other-version':
      return { reason: 'other-version', found: opening.found, expected: opening.expected }
    case 'open': {
      const { snapshot } = opening.index
      opening.index.close()
      return snapshot === null ? { reason: 'empty' } : snapshot.sha
    }
  }
}

function notIndexed(why: NotIndexed): LocalRead {
  return { state: 'not-indexed', why }
}

function textReader(
  mirror: LocalMirror,
  files: readonly TreeFile[],
): (path: string) => Promise<string> {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const decoder = new TextDecoder()
  return async (path) => {
    const file = byPath.get(path)
    if (file === undefined) throw new Error(`${path} is not in the commit`)
    for await (const blob of mirror.readBlobs([file])) return decoder.decode(blob.bytes)
    throw new Error(`${path} is not in the mirror`)
  }
}
