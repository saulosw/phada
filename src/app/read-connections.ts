import type { ConfigLayer } from '../config/types.js'
import type { PackageRef, RepositoryPackages } from '../graph/packages.js'
import { hasLink, linkRepositories } from '../graph/repository-links.js'
import type { MirrorOpening } from '../repository/git-mirror.js'
import type { IndexOpening } from '../store/index-store.js'
import { errorMessage } from './error-message.js'
import { declaredRelated, openLocalRepository } from './local-repository.js'
import type { NotIndexed } from './local-repository.js'

export type { PackageRef } from '../graph/packages.js'
export type { NotIndexed } from './local-repository.js'

export interface ConnectionReaders {
  repositories(): Promise<string[]>
  userLayers(repo: string): Promise<ConfigLayer[]>
  openIndex(repo: string): Promise<IndexOpening>
  openMirror(repo: string): Promise<MirrorOpening>
}

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
  const declared = declaredRelated(repo, userLayers, own.state === 'read' ? own.config : null)
  const related = await Promise.all(
    declared.related.map(async ({ repo: name, description }): Promise<Connection> => {
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
      configError: declared.configError,
      warnings: declared.warnings,
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
  const opening = await openLocalRepository(repo, readers)
  if (opening.state === 'not-indexed') return opening
  const { commit, index, packages, config } = opening.local
  index.close()
  return { state: 'read', commit, packages, config }
}
