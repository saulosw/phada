import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { fetchCheckAnnotations, fetchCheckRuns } from './check-runs.js'
import { GitHubPermissionError, GitHubRateLimitError } from './errors.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const SHA = 'a'.repeat(40)
const JSON_ACCEPT = 'application/vnd.github+json'
const OPTIONS = { owner: 'acme', repo: 'shop', token: TOKEN }

const run = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `job ${id}`,
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/acme/shop/actions/runs/1/job/${id}`,
  output: { title: null, summary: null },
  app: { slug: 'github-actions' },
  ...overrides,
})

describe('fetchCheckRuns', () => {
  it('reads every page of the check runs of a commit', async () => {
    const next = `<https://api.github.com/repositories/9/commits/${SHA}/check-runs?per_page=100&page=2>; rel="next"`
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          headers: { link: next },
          body: JSON.stringify({
            total_count: 2,
            check_runs: [
              run(11, {
                name: 'test',
                conclusion: 'failure',
                output: { title: 'Tests failed', summary: '2 of 40 failed' },
                started_at: '2026-10-20T10:00:00Z',
                completed_at: '2026-10-20T10:02:00Z',
              }),
            ],
          }),
        },
        {
          status: 200,
          body: JSON.stringify({
            total_count: 2,
            check_runs: [
              run(12, { name: 'e2e', status: 'in_progress', conclusion: null, app: null }),
            ],
          }),
        },
      ],
    })

    const runs = await fetchCheckRuns({ ...OPTIONS, sha: SHA, fetch })

    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/acme/shop/commits/${SHA}/check-runs?per_page=100`,
      `https://api.github.com/repositories/9/commits/${SHA}/check-runs?per_page=100&page=2`,
    ])
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(runs).toEqual([
      {
        id: 11,
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        title: 'Tests failed',
        summary: '2 of 40 failed',
        url: 'https://github.com/acme/shop/actions/runs/1/job/11',
        app: 'github-actions',
        startedAt: '2026-10-20T10:00:00Z',
        completedAt: '2026-10-20T10:02:00Z',
      },
      {
        id: 12,
        name: 'e2e',
        status: 'in_progress',
        conclusion: null,
        title: null,
        summary: null,
        url: 'https://github.com/acme/shop/actions/runs/1/job/12',
        app: null,
        startedAt: null,
        completedAt: null,
      },
    ])
  })

  it('names the checks:read permission when GitHub denies the read', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        { status: 403, body: '{"message":"Resource not accessible by personal access token"}' },
      ],
    })

    const read = fetchCheckRuns({ ...OPTIONS, sha: SHA, fetch })

    await expect(read).rejects.toBeInstanceOf(GitHubPermissionError)
    await expect(fetchCheckRuns({ ...OPTIONS, sha: SHA, fetch: deny() })).rejects.toThrow(
      'GitHub denied reading the check runs (HTTP 403): the token needs the checks:read permission. GitHub says: Resource not accessible by personal access token',
    )
  })

  it('keeps a rate limit on a 403 as a rate limit', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: '{"message":"x"}' },
      ],
    })

    await expect(fetchCheckRuns({ ...OPTIONS, sha: SHA, fetch })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    )
  })
})

describe('fetchCheckAnnotations', () => {
  it('reads the annotations of a check run with their place, level and message', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          body: JSON.stringify([
            {
              path: 'src/cart.ts',
              start_line: 12,
              end_line: 12,
              annotation_level: 'failure',
              title: 'cart.test.ts',
              message: 'expected 3 to be 2',
            },
            {
              path: '.github',
              start_line: 1,
              end_line: 1,
              annotation_level: 'notice',
              title: null,
              message: 'The runner uses ubuntu-24.04',
            },
          ]),
        },
      ],
    })

    const annotations = await fetchCheckAnnotations({ ...OPTIONS, checkRunId: 11, fetch })

    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/shop/check-runs/11/annotations?per_page=50',
    )
    expect(annotations).toEqual([
      {
        path: 'src/cart.ts',
        line: 12,
        level: 'failure',
        title: 'cart.test.ts',
        message: 'expected 3 to be 2',
      },
      {
        path: '.github',
        line: 1,
        level: 'notice',
        title: null,
        message: 'The runner uses ubuntu-24.04',
      },
    ])
  })

  it('names the checks:read permission when GitHub denies the annotations', async () => {
    await expect(
      fetchCheckAnnotations({ ...OPTIONS, checkRunId: 11, fetch: deny() }),
    ).rejects.toThrow(
      'GitHub denied reading the check run annotations (HTTP 403): the token needs the checks:read permission.',
    )
  })
})

function deny(): typeof globalThis.fetch {
  return createFakeFetch({
    [JSON_ACCEPT]: [
      { status: 403, body: '{"message":"Resource not accessible by personal access token"}' },
    ],
  }).fetch
}
