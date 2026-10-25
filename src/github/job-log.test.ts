import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubPermissionError, GitHubRequestError } from './errors.js'
import {
  JOB_LOG_LIMIT_BYTES,
  JOB_LOG_TAIL_BYTES,
  JobLogTooLargeError,
  JobLogUnavailableError,
  fetchJobLog,
} from './job-log.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const BLOB = 'https://results.blob.core.windows.net/logs/job-logs.txt?sig=abc&se=2026'
const OPTIONS = { owner: 'acme', repo: 'shop', token: TOKEN, jobId: 119137909038 }

function readLog(api: FakeResponse[], blob: FakeResponse[] = []) {
  const fake = createFakeFetch(
    { 'api.github.com': api, 'results.blob.core.windows.net': blob },
    (call) => new URL(call.url).host,
  )
  return { read: fetchJobLog({ ...OPTIONS, fetch: fake.fetch }), calls: fake.calls }
}

const REDIRECT: FakeResponse = { status: 302, headers: { location: BLOB } }

describe('fetchJobLog', () => {
  it('follows the redirect itself and asks the blob for the last 512 KB without the token', async () => {
    const { read, calls } = readLog(
      [REDIRECT],
      [{ status: 206, headers: { 'content-range': 'bytes 1000-1999/2000' }, body: 'ine\nlast' }],
    )

    expect(await read).toEqual({ text: 'ine\nlast', partial: true })
    const [api, blob] = calls
    expect(api?.url).toBe('https://api.github.com/repos/acme/shop/actions/jobs/119137909038/logs')
    expect(api?.redirect).toBe('manual')
    expect(api?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(blob?.url).toBe(BLOB)
    expect(blob?.headers).toEqual({ range: `bytes=-${JOB_LOG_TAIL_BYTES}` })
    expect(JSON.stringify(blob)).not.toContain(TOKEN)
  })

  it('reads a log shorter than the range from its first byte', async () => {
    const { read } = readLog(
      [REDIRECT],
      [{ status: 206, headers: { 'content-range': 'bytes 0-9/10' }, body: 'whole log\n' }],
    )

    expect(await read).toEqual({ text: 'whole log\n', partial: false })
  })

  it('keeps the tail of the stream when the blob ignores the range', async () => {
    const body = `${'x'.repeat(JOB_LOG_TAIL_BYTES)}\nthe end`
    const { read } = readLog([REDIRECT], [{ status: 200, body }])

    const log = await read
    expect(log.partial).toBe(true)
    expect(log.text.length).toBe(JOB_LOG_TAIL_BYTES)
    expect(log.text.endsWith('\nthe end')).toBe(true)
  })

  it('gives up on a log above 10 MB when the blob ignores the range', async () => {
    const { read } = readLog(
      [REDIRECT],
      [{ status: 200, body: 'y'.repeat(JOB_LOG_LIMIT_BYTES + 1) }],
    )

    await expect(read).rejects.toBeInstanceOf(JobLogTooLargeError)
    await expect(
      readLog([REDIRECT], [{ status: 200, body: 'y'.repeat(JOB_LOG_LIMIT_BYTES + 1) }]).read,
    ).rejects.toThrow(
      'The log of job 119137909038 is above 10 MB and the server did not send only its end',
    )
  })

  it.each([404, 410])('says the log is gone on HTTP %i', async (status) => {
    const { read } = readLog([{ status, body: '{"message":"Gone"}' }])

    await expect(read).rejects.toBeInstanceOf(JobLogUnavailableError)
    await expect(readLog([{ status, body: '' }]).read).rejects.toThrow(
      'The log of job 119137909038 is not available (expired or deleted)',
    )
  })

  it('says the log is gone when the blob link expired', async () => {
    const { read } = readLog([REDIRECT], [{ status: 403, body: 'AuthenticationFailed' }])

    await expect(read).rejects.toBeInstanceOf(JobLogUnavailableError)
  })

  it('names the actions:read permission when GitHub denies the log', async () => {
    const { read } = readLog([{ status: 403, body: '{"message":"Must have admin rights"}' }])

    await expect(read).rejects.toBeInstanceOf(GitHubPermissionError)
    await expect(
      readLog([{ status: 403, body: '{"message":"Must have admin rights"}' }]).read,
    ).rejects.toThrow('the token needs the actions:read permission')
  })

  it('refuses a redirect that is not https', async () => {
    const { read, calls } = readLog([{ status: 302, headers: { location: 'http://evil.test/x' } }])

    await expect(read).rejects.toBeInstanceOf(GitHubRequestError)
    expect(calls).toHaveLength(1)
  })
})
