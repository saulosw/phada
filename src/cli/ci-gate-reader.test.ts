import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import type { JobRecord } from '../watch/types.js'
import { ciGateReader } from './ci-gate-reader.js'
import type { CiGateReaderDeps } from './ci-gate-reader.js'

const A = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const JOB: JobRecord = {
  id: 1,
  repo: 'acme/shop',
  number: 3,
  headSha: A,
  status: 'queued',
  attempts: 0,
  notBefore: '2026-10-18T12:03:00.000Z',
  createdAt: '2026-10-18T12:00:00.000Z',
}
const run = (name: string, status: string, conclusion: string | null = null): CheckRun => ({
  id: 1,
  name,
  status,
  conclusion,
  title: null,
  summary: null,
  url: null,
  app: 'github-actions',
  startedAt: null,
  completedAt: null,
})

interface Fakes {
  user?: string
  repo?: string | null
  runs?: CheckRun[] | Error
  statuses?: CommitStatus[]
}

function reader(fakes: Fakes) {
  const reads: string[] = []
  const deps: CiGateReaderDeps = {
    env: { PHADA_CONFIG_HOME: '/cfg' },
    home: '/home/u',
    files: memoryFiles(fakes.user === undefined ? {} : { '/cfg/config.yml': fakes.user }),
    fetchPullRequestMetadata: async ({ number }) => {
      reads.push(`pull ${number}`)
      const { diff: _diff, ...pull } = pullRequestFixture({ number, baseSha: BASE })
      return pull
    },
    fetchRepositoryFile: async ({ path, ref }) => {
      reads.push(`file ${path} ${ref.slice(0, 1)}`)
      return fakes.repo ?? null
    },
    fetchCheckRuns: async ({ sha }) => {
      reads.push(`runs ${sha.slice(0, 1)}`)
      if (fakes.runs instanceof Error) throw fakes.runs
      return fakes.runs ?? []
    },
    fetchCommitStatuses: async () => fakes.statuses ?? [],
    fetchCheckAnnotations: async () => [],
    fetchJobLog: async () => {
      throw new Error('not read by the gate')
    },
  }
  return { read: ciGateReader(deps, 'token'), reads }
}

describe('ciGateReader', () => {
  it('reads the checks that count with the wait of the config, the repository root over the user', async () => {
    const { read, reads } = reader({
      user: 'ci:\n  wait: 30m\n  checks: [lint]\n',
      repo: 'ci:\n  wait: 20m\n  checks: [test]\n',
      runs: [run('test', 'in_progress'), run('lint', 'completed', 'failure')],
    })

    expect(await read(JOB)).toEqual({
      waitMs: 1_200_000,
      summary: { state: 'pending', total: 1, failing: [], pending: ['test'] },
    })
    expect(reads).toEqual(['pull 3', 'file .phada/config.yml b', 'runs a'])
  })

  it('reads the settings of a job once and its checks each time', async () => {
    const { read, reads } = reader({})

    expect(await read(JOB)).toEqual({
      waitMs: 900_000,
      summary: { state: 'none', total: 0, failing: [], pending: [] },
    })
    await read(JOB)
    expect(reads).toEqual(['pull 3', 'file .phada/config.yml b', 'runs a', 'runs a'])
  })

  it('has no gate with ci.read: false or ci.wait: 0s', async () => {
    expect(await reader({ user: 'ci:\n  read: false\n' }).read(JOB)).toBeUndefined()
    expect(await reader({ repo: 'ci:\n  wait: 0s\n' }).read(JOB)).toBeUndefined()
  })

  it('ignores an invalid repository config, as the review warns about it', async () => {
    expect(await reader({ user: 'ci:\n  wait: 1m\n', repo: 'ci: [' }).read(JOB)).toMatchObject({
      waitMs: 60_000,
    })
  })

  it('fails when the checks were not read, instead of taking them for none', async () => {
    await expect(reader({ runs: new Error('HTTP 403') }).read(JOB)).rejects.toThrow(
      'CI check runs were not read: HTTP 403',
    )
  })
})
