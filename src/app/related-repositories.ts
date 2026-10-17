import type { DeclaredRepository } from '../config/merge-config.js'
import { DEFAULT_IGNORE, matcher } from '../context/ignore.js'
import type { RepositoryInfo } from '../github/repository.js'
import { readPackages } from '../graph/packages.js'
import type { RepositoryPackages } from '../graph/packages.js'
import { linkRepositories, hasLink } from '../graph/repository-links.js'
import type { RepositoryLink } from '../graph/repository-links.js'
import { openRepositoryGraph } from '../graph/repository-graph.js'
import type { RepositoryGraph } from '../graph/types.js'
import type { Extractor } from '../repo-map/extract.js'
import type { Checkout } from '../repository/checkout.js'
import type { GitMirror, TreeFile } from '../repository/git-mirror.js'
import type { IndexStore } from '../store/index-store.js'
import { errorMessage } from './error-message.js'
import { DEPENDENCY_FOLDERS, indexCommit, KEEP_COMMITS } from './index-repository.js'
import { selectCandidates } from './select-related.js'
import type { RelatedCandidate, SkippedRepository } from './select-related.js'

export const RELATED_INDEX_BUDGET_MS = 60_000
export const RELATED_REF = 'refs/phada/default'

const NO_ACCESS =
  /repository not found|authentication failed|could not read username|access denied|permission denied|error: 40[34]/i

export interface RelatedAccess {
  openMirror(): Promise<GitMirror>
  openIndexStore(): Promise<IndexStore>
}

export interface RelatedEvents {
  warning(message: string): void
  indexing(total: number): void
  indexed(done: number, total: number): void
}

export interface RelatedDeps {
  readRepository(repo: string): Promise<RepositoryInfo>
  openRelated(repo: string): RelatedAccess
  extractor: Extractor
  now: () => number
  events: RelatedEvents
}

export interface OpenRelatedInput {
  declared: readonly DeclaredRepository[]
  reviewed: string
  pullRequestPrivate: boolean
  privateOnPublic: boolean
  reviewedPackages: RepositoryPackages
  index: boolean
}

export interface OpenedRelated {
  repo: string
  origin: string
  description?: string
  commit: string
  checkout: Checkout
  link: RepositoryLink
  graph?: RepositoryGraph
  order: number
  close(): Promise<void>
}

interface Fetched {
  candidate: RelatedCandidate
  access: RelatedAccess
  mirror: GitMirror
  sha: string
  files: TreeFile[]
  checkout: Checkout
  link: RepositoryLink
}

export async function openRelatedRepositories(
  input: OpenRelatedInput,
  deps: RelatedDeps,
): Promise<{ opened: OpenedRelated[]; skipped: SkippedRepository[] }> {
  const { events } = deps
  const infos = new Map<string, RepositoryInfo | 'no-access'>()
  await Promise.all(
    input.declared.map(async ({ repo }) => {
      if (repo.toLowerCase() === input.reviewed.toLowerCase()) return
      try {
        infos.set(repo, await deps.readRepository(repo))
      } catch (error) {
        infos.set(repo, 'no-access')
        events.warning(`${errorMessage(error)}: reviewing without it.`)
      }
    }),
  )
  const { candidates, skipped } = selectCandidates(input.declared, infos, input)
  for (const item of skipped) {
    if (item.reason === 'private-on-public') {
      events.warning(
        `${item.repo} is private and ${input.reviewed} is public: allow it in your own config with context.privateOnPublic.`,
      )
    }
    if (item.reason === 'empty')
      events.warning(`${item.repo} has no commits: reviewing without it.`)
  }
  const order = new Map(input.declared.map((item, index) => [item.repo, index]))
  const fetched = await Promise.all(
    candidates.map(async (candidate): Promise<Fetched | SkippedRepository> => {
      const { repo, origin } = candidate.declared
      try {
        const access = deps.openRelated(repo)
        const mirror = await access.openMirror()
        const sha = await mirror.fetch(
          `refs/heads/${candidate.info.defaultBranch ?? ''}`,
          RELATED_REF,
        )
        const files = await mirror.listFiles(sha)
        const checkout = mirror.checkout(sha)
        const packages = await checkoutPackages(files, checkout)
        return {
          candidate,
          access,
          mirror,
          sha,
          files,
          checkout,
          link: linkRepositories(input.reviewedPackages, packages),
        }
      } catch (error) {
        const message = errorMessage(error)
        if (NO_ACCESS.test(message)) {
          events.warning(`${message}: reviewing without it.`)
          return { repo, origin, reason: 'no-access', message }
        }
        events.warning(`${message}: run phada index ${repo} to prepare it.`)
        return { repo, origin, reason: 'fetch-failed', message }
      }
    }),
  )
  const deadline = deps.now() + RELATED_INDEX_BUDGET_MS
  const opened: OpenedRelated[] = []
  for (const item of fetched) {
    if (!('candidate' in item)) {
      skipped.push(item)
      continue
    }
    const { repo, origin, description } = item.candidate.declared
    const indexed =
      input.index && hasLink(item.link) ? await indexRelated(item, deadline, deps) : {}
    opened.push({
      repo,
      origin,
      ...(description === undefined ? {} : { description }),
      commit: item.sha,
      checkout: item.checkout,
      link: item.link,
      ...(indexed.graph === undefined ? {} : { graph: indexed.graph }),
      order: order.get(repo) ?? opened.length,
      close: async () => {
        indexed.store?.close()
        await item.checkout.close()
      },
    })
  }
  return { opened, skipped }
}

export function checkoutPackages(
  files: readonly TreeFile[],
  checkout: Checkout,
): Promise<RepositoryPackages> {
  return readPackages(new Set(files.map((file) => file.path)), (path) => checkout.readText(path))
}

async function indexRelated(
  item: Fetched,
  deadline: number,
  deps: RelatedDeps,
): Promise<{ graph?: RepositoryGraph; store?: IndexStore }> {
  const repo = item.candidate.declared.repo
  let store: IndexStore | undefined
  try {
    store = await item.access.openIndexStore()
    const result = await indexCommit(
      {
        sha: item.sha,
        ref: RELATED_REF,
        files: item.files,
        ignore: matcher([...DEFAULT_IGNORE, ...DEPENDENCY_FOLDERS]),
        deadline,
      },
      {
        mirror: item.mirror,
        store,
        extractor: deps.extractor,
        now: deps.now,
        events: { extracting: deps.events.indexing, extracted: deps.events.indexed },
      },
    )
    if (!result.complete) {
      const progress = `${result.extracted.toLocaleString('en-US')} of ${result.total.toLocaleString('en-US')} files`
      deps.events.warning(
        `Index of ${repo} is not ready (${progress}): reading it without its graph. Run phada index ${repo}, or the next review continues it.`,
      )
      store.close()
      return {}
    }
    store.prune(KEEP_COMMITS)
    const graph = await openRepositoryGraph({
      reader: store.reader(item.sha),
      readText: (path) => item.checkout.readText(path),
    })
    return { graph, store }
  } catch (error) {
    store?.close()
    deps.events.warning(
      `Could not use the graph of ${repo} (${errorMessage(error)}): reading it without it.`,
    )
    return {}
  }
}
