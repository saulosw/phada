import { readCheckEntries } from '../app/read-ci.js'
import type { PullCi } from '../app/watch-repositories.js'
import type { LocalFileSystem } from '../config/local-files.js'
import type { CiSettings } from '../config/merge-config.js'
import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import { loadUserLayers } from '../config/user-config.js'
import { mergeLayers } from '../context/load-context.js'
import { phadaFiles } from '../context/phada-paths.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { FetchPullRequestOptions, PullRequestMetadata } from '../github/pull-request.js'
import { ciSummary } from '../context/ci-state.js'
import { DEFAULT_CI_WAIT_MS } from '../watch/ci-gate.js'
import type { JobRecord } from '../watch/types.js'
import type { ContextReaders } from './context-sources.js'
import { ciReaders } from './review-wiring.js'
import type { CiReaderDeps } from './review-wiring.js'

export interface CiGateReaderDeps
  extends CiReaderDeps, Pick<ContextReaders, 'fetchRepositoryFile'> {
  env: NodeJS.ProcessEnv
  home: string
  files: LocalFileSystem
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
}

const REMEMBERED_JOBS = 100

export function ciGateReader(
  deps: CiGateReaderDeps,
  token: string,
): (job: JobRecord) => Promise<PullCi | undefined> {
  const remembered = new Map<number, CiSettings>()
  return async (job) => {
    const settings = remembered.get(job.id) ?? (await pullCiSettings(job, token, deps))
    remembered.delete(job.id)
    remembered.set(job.id, settings)
    const oldest = remembered.keys().next().value
    if (remembered.size > REMEMBERED_JOBS && oldest !== undefined) remembered.delete(oldest)
    const waitMs = settings.waitMs ?? DEFAULT_CI_WAIT_MS
    const onFailure = settings.onFailure ?? 'review'
    if (settings.read === false || (waitMs === 0 && onFailure === 'review')) return undefined
    const target = splitRepoName(job.repo)
    const warnings: string[] = []
    const entries = await readCheckEntries(
      ciReaders(deps, { ...target, number: job.number, token }),
      job.headSha,
      settings.checks,
      (message) => warnings.push(message),
    )
    if (warnings.length > 0) throw new Error(warnings.join('; '))
    return {
      waitMs,
      onFailure,
      summary: ciSummary(entries),
      checks: entries.map(({ name, state }) => ({ name, state })),
    }
  }
}

async function pullCiSettings(
  job: JobRecord,
  token: string,
  deps: CiGateReaderDeps,
): Promise<CiSettings> {
  const target = splitRepoName(job.repo)
  const [userLayers, pull] = await Promise.all([
    loadUserLayers({ env: deps.env, home: deps.home, files: deps.files, ...target }),
    deps.fetchPullRequestMetadata({ ...target, number: job.number, token }),
  ])
  const { config } = phadaFiles('')
  const text = await deps.fetchRepositoryFile({ ...target, token, path: config, ref: pull.baseSha })
  const parsed = text === null ? undefined : parseConfigText(text)
  const repositoryLayers: ConfigLayer[] =
    parsed?.ok === true
      ? [{ kind: 'repo-root', dir: '', configLabel: config, config: parsed.config }]
      : []
  return mergeLayers(userLayers, repositoryLayers).ci
}
