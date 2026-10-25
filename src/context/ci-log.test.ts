import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { failedStepLog } from './ci-log.js'

const JOB_LOG = readFileSync(
  new URL('../../test/fixtures/github/job-log.txt', import.meta.url),
  'utf8',
)

function stamped(...lines: string[]): string {
  return lines.map((line, index) => `2026-10-21T09:10:${10 + index}.1234567Z ${line}`).join('\n')
}

describe('failedStepLog', () => {
  it('keeps the step that failed, from its ##[group]Run line to the error, without timestamps or colors', () => {
    const cut = failedStepLog(JOB_LOG, { truncated: 0 })
    const lines = cut.split('\n')

    expect(lines[0]).toBe('##[group]Run go mod tidy -diff')
    expect(lines[1]).toBe('go mod tidy -diff')
    expect(lines.at(-1)).toBe('##[error]Process completed with exit code 1.')
    expect(cut).toContain('-github.com/cli/oauth v1.2.2 h1:')
    expect(cut).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/)
    expect(cut).not.toContain('\u001b')
    expect(cut).not.toContain('Runner Image')
    expect(cut).not.toContain('actions/setup-go')
    expect(cut).not.toContain('Post job cleanup')
  })

  it('runs from the step of the first error to the last error', () => {
    const log = stamped(
      '##[group]Run npm ci',
      'added 10 packages',
      '##[endgroup]',
      '##[group]Run npm test',
      'FAIL src/a.test.ts',
      '##[error]expected 1 to be 2',
      'more output',
      '##[group]Run npm run lint',
      '##[error]Process completed with exit code 1.',
      'Post job cleanup.',
    )

    expect(failedStepLog(log, { truncated: 0 })).toBe(
      [
        '##[group]Run npm test',
        'FAIL src/a.test.ts',
        '##[error]expected 1 to be 2',
        'more output',
        '##[group]Run npm run lint',
        '##[error]Process completed with exit code 1.',
      ].join('\n'),
    )
  })

  it('keeps the whole log when no line is an error, and starts at the top without a step', () => {
    expect(failedStepLog(stamped('one', 'two'), { truncated: 0 })).toBe('one\ntwo')
    expect(failedStepLog(stamped('setup', '##[error]boom', 'after'), { truncated: 0 })).toBe(
      'setup\n##[error]boom',
    )
  })

  it('keeps only the final bytes of a long cut, from a whole line, saying how much it cut', () => {
    const cuts = { truncated: 0 }
    const cut = failedStepLog(JOB_LOG, cuts, { maxBytes: 300 })
    const [marker = '', ...rest] = cut.split('\n')
    const kept = rest.join('\n')

    expect(marker).toMatch(/^\[truncated by Phada: last \d+ of \d+ bytes\]$/)
    expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(300)
    expect(kept.endsWith('##[error]Process completed with exit code 1.')).toBe(true)
    expect(cuts.truncated).toBe(1)
    const whole = { truncated: 0 }
    expect(failedStepLog(JOB_LOG, whole)).toContain(`\n${rest[0] ?? ''}\n`)
    expect(whole.truncated).toBe(0)
  })

  it('drops the line cut in half at the start of a tail read with a range', () => {
    const log = `ad-of-a-line\n${stamped('##[group]Run make', '##[error]failed')}`

    expect(failedStepLog(log, { truncated: 0 }, { partial: true })).toBe(
      '##[group]Run make\n##[error]failed',
    )
  })
})
