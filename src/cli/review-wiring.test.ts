import { describe, expect, it } from 'vitest'
import { GitHubPermissionError } from '../github/errors.js'
import { JobLogUnavailableError } from '../github/job-log.js'
import { ciReaders } from './review-wiring.js'

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
