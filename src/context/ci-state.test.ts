import { describe, expect, it } from 'vitest'
import type { CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import { ciEntries, ciSummary } from './ci-state.js'

const ALL = () => true

function run(name: string, overrides: Partial<CheckRun> = {}): CheckRun {
  return {
    id: name.length,
    name,
    status: 'completed',
    conclusion: 'success',
    title: null,
    summary: null,
    url: null,
    app: 'github-actions',
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function status(context: string, state: string): CommitStatus {
  return { context, state, description: null, url: null }
}

describe('ciEntries', () => {
  it('turns check runs and commit statuses into checks that pass, fail or are pending', () => {
    const entries = ciEntries(
      [
        run('test', {
          id: 11,
          conclusion: 'failure',
          title: 'Tests failed',
          summary: '2 failed',
          url: 'https://github.com/acme/shop/actions/runs/1/job/11',
          startedAt: '2026-10-20T10:00:00Z',
          completedAt: '2026-10-20T10:02:00Z',
        }),
        run('e2e', { id: 12, status: 'in_progress', conclusion: null }),
        run('lint', { id: 13, status: 'queued', conclusion: null, app: 'other-ci' }),
      ],
      [status('ci/build', 'success'), status('deploy', 'pending'), status('scan', 'error')],
      ALL,
    )

    expect(entries).toEqual([
      {
        name: 'test',
        kind: 'check-run',
        id: 11,
        actions: true,
        state: 'failing',
        conclusion: 'failure',
        title: 'Tests failed',
        summary: '2 failed',
        url: 'https://github.com/acme/shop/actions/runs/1/job/11',
        startedAt: '2026-10-20T10:00:00Z',
        completedAt: '2026-10-20T10:02:00Z',
      },
      {
        name: 'e2e',
        kind: 'check-run',
        id: 12,
        actions: true,
        state: 'pending',
        status: 'in_progress',
      },
      {
        name: 'lint',
        kind: 'check-run',
        id: 13,
        actions: false,
        state: 'pending',
        status: 'queued',
      },
      { name: 'ci/build', kind: 'status', actions: false, state: 'passing', conclusion: 'success' },
      { name: 'deploy', kind: 'status', actions: false, state: 'pending' },
      { name: 'scan', kind: 'status', actions: false, state: 'failing', conclusion: 'error' },
    ])
  })

  it.each([
    ['failure', 'failing'],
    ['timed_out', 'failing'],
    ['cancelled', 'failing'],
    ['action_required', 'failing'],
    ['startup_failure', 'failing'],
    ['success', 'passing'],
    ['neutral', 'passing'],
    ['skipped', 'passing'],
    ['stale', 'passing'],
  ])('reads the conclusion %s of a check run as %s', (conclusion, state) => {
    expect(ciEntries([run('job', { conclusion })], [], ALL)[0]?.state).toBe(state)
  })

  it('keeps only the checks that count', () => {
    const entries = ciEntries(
      [run('test'), run('docs')],
      [status('ci/build', 'success')],
      (name) => name !== 'docs',
    )

    expect(entries.map(({ name }) => name)).toEqual(['test', 'ci/build'])
  })
})

describe('ciSummary', () => {
  it('is none without checks that count', () => {
    expect(ciSummary([])).toEqual({ state: 'none', total: 0, failing: [], pending: [] })
    expect(ciSummary(ciEntries([run('test')], [], () => false)).state).toBe('none')
  })

  it('is failing when a check fails, even with others pending, and names them', () => {
    const entries = ciEntries(
      [
        run('test', { conclusion: 'failure' }),
        run('e2e', { status: 'in_progress', conclusion: null }),
        run('build'),
      ],
      [status('lint', 'failure')],
      ALL,
    )

    expect(ciSummary(entries)).toEqual({
      state: 'failing',
      total: 4,
      failing: ['test', 'lint'],
      pending: ['e2e'],
    })
  })

  it('is pending while a check runs and nothing failed, passing when every check is done', () => {
    const pending = ciEntries(
      [run('build'), run('e2e', { status: 'queued', conclusion: null })],
      [],
      ALL,
    )
    const passing = ciEntries([run('build'), run('docs', { conclusion: 'skipped' })], [], ALL)

    expect(ciSummary(pending).state).toBe('pending')
    expect(ciSummary(passing)).toEqual({ state: 'passing', total: 2, failing: [], pending: [] })
  })
})
