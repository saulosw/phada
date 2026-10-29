import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { reviewState } from '../../test/support/review-state.js'
import { reviewAndPublish } from '../app/review-and-publish.js'
import type { ReviewProgress } from '../app/review-progress.js'
import { GitHubPermissionError } from '../github/errors.js'
import { JobLogUnavailableError } from '../github/job-log.js'
import { createExtractor } from '../repo-map/extract.js'
import { openIndexStore } from '../store/index-store.js'
import { openObservedStore } from '../store/observed-store.js'
import {
  ciReaders,
  pullRequestReviewDeps,
  renderReview,
  reviewAndPublishEvents,
} from './review-wiring.js'
import type { ReviewWiringDeps } from './review-wiring.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-review-wiring-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TARGET = { owner: 'acme', repo: 'shop', number: 12, token: 't' }

describe('ciReaders', () => {
  it('tells a permission GitHub denied apart from other failures', () => {
    const unused = () => Promise.reject(new Error('not called'))
    const readers = ciReaders(
      {
        fetchCheckRuns: unused,
        fetchCommitStatuses: unused,
        fetchCheckAnnotations: unused,
        fetchJobLog: unused,
      },
      { owner: 'acme', repo: 'shop', number: 1, token: 't' },
    )

    expect(
      readers.permissionDenied(new GitHubPermissionError('the job logs', 'actions:read')),
    ).toBe(true)
    expect(readers.permissionDenied(new Error('timeout'))).toBe(false)
    expect(readers.permissionDenied(Object.assign(new Error('x'), { permission: 'a' }))).toBe(false)
    expect(readers.logUnavailable(new JobLogUnavailableError(4))).toBe(true)
    expect(readers.logUnavailable(new Error('timeout'))).toBe(false)
  })
})

function wiringDeps(): ReviewWiringDeps {
  return {
    env: { PHADA_CACHE_HOME: '/cache' },
    version: '1.2.3',
    home: '/home/u',
    files: memoryFiles(),
    fetchRepositoryTree: async () => ({ entries: [], truncated: false }),
    fetchRepositoryFile: async () => null,
    fetchCheckRuns: async () => [],
    fetchCommitStatuses: async () => [],
    fetchCheckAnnotations: async () => [],
    fetchJobLog: () => Promise.reject(new Error('no job log in this test')),
    fetchRepository: () => Promise.reject(new Error('no related repositories in this test')),
    openMirror: async () => memoryMirror({ 'src/shop.ts': 'export function spend() {}\n' }),
    openIndexStore: () => openIndexStore(join(dir, 'index.sqlite')),
    openObservedStore: () => openObservedStore(join(dir, 'observed.sqlite')),
    createExtractor,
    createProvider: () => ({
      id: 'fake-cli',
      review: async () => ({ text: reviewReportJson({ findings: [] }), durationMs: 1 }),
    }),
    runsSkills: () => false,
  }
}

describe('the review progress', () => {
  it('reports each step of a review as an event, from the fetch to the publication', async () => {
    const events: ReviewProgress[] = []
    const progress = (event: ReviewProgress) => events.push(event)
    const deps = wiringDeps()

    await reviewAndPublish(
      {
        ref: TARGET,
        mode: 'manual',
        force: false,
        dryRun: false,
        publish: true,
        options: {},
        userLayers: [],
        mcp: { names: [], declared: [] },
      },
      {
        fetchPullRequest: async () => pullRequestFixture(),
        fetchReviewState: async () => reviewState(),
        fetchPullComments: async () => [],
        ci: ciReaders(deps, TARGET),
        reviewDeps: (pullRequest) =>
          pullRequestReviewDeps(deps, TARGET, { provider: 'fake' }, pullRequest, progress),
        render: renderReview,
        createReview: async () => ({ url: 'https://github.com/acme/shop/pull/12#review' }),
        compare: async () => [],
        replyAndResolve: async () => undefined,
        events: reviewAndPublishEvents(progress, () => undefined),
      },
    )

    expect(events.map(({ kind }) => kind)).toEqual([
      'fetched',
      'contextLoaded',
      'conversationRead',
      'ciRead',
      'indexing',
      'indexed',
      'impactReady',
      'relatedReady',
      'aiStarted',
      'aiFinished',
      'publishing',
    ])
    expect(events).toContainEqual({ kind: 'aiStarted', provider: 'fake-cli', run: 'review' })
  })
})
