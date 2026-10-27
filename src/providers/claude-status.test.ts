import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkClaudeStatus } from './claude-status.js'

const FAKE = resolve('test/fixtures/bin/fake-claude-status')
const FAKE_SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phada-claude-status-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function check(mode: string, options: { command?: string; timeoutMs?: number } = {}) {
  return checkClaudeStatus({
    command: options.command ?? FAKE,
    env: {
      PATH: process.env.PATH,
      FAKE_STATUS_MODE: mode,
      FAKE_STATUS_CAPTURE: join(dir, 'capture.jsonl'),
      GITHUB_TOKEN: FAKE_SECRET,
      GH_TOKEN: FAKE_SECRET,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
}

describe('checkClaudeStatus', () => {
  it('reports the version and how the CLI is logged in', async () => {
    expect(await check('logged_in')).toEqual({
      provider: 'claude',
      install: { state: 'installed', version: '2.1.310' },
      login: { state: 'logged-in', method: 'claude.ai' },
    })
  })

  it('reports an API key login', async () => {
    expect((await check('api_key')).login).toEqual({ state: 'logged-in', method: 'api_key' })
  })

  it('keeps the account out of the result', async () => {
    const status = await check('odd_method')
    expect(status.login).toEqual({ state: 'logged-in', method: null })
    expect(JSON.stringify(status)).not.toContain('example')
  })

  it('reads a logged-out CLI from its JSON on exit 1', async () => {
    expect((await check('logged_out')).login).toEqual({ state: 'logged-out' })
  })

  it('reports a missing CLI as not installed', async () => {
    expect(await check('logged_in', { command: join(dir, 'no-such-claude') })).toEqual({
      provider: 'claude',
      install: { state: 'missing' },
      login: { state: 'unknown', problem: 'not-installed' },
    })
  })

  it('reports a CLI that does not answer in time', async () => {
    expect(await check('hang', { timeoutMs: 300 })).toEqual({
      provider: 'claude',
      install: { state: 'unknown', problem: 'timeout' },
      login: { state: 'unknown', problem: 'timeout' },
    })
  })

  it('reports unexpected output as a state', async () => {
    expect(await check('odd_output')).toEqual({
      provider: 'claude',
      install: { state: 'installed', version: null },
      login: { state: 'unknown', problem: 'unexpected-output' },
    })
  })

  it('reports a failing status command', async () => {
    expect((await check('crash')).login).toEqual({ state: 'unknown', problem: 'failed' })
  })

  it('runs the CLI without the GitHub tokens', async () => {
    await check('logged_in')
    const lines = (await readFile(join(dir, 'capture.jsonl'), 'utf8')).trim().split('\n')
    const captured = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(captured.map((entry) => entry.argv)).toEqual(
      expect.arrayContaining([['--version'], ['auth', 'status', '--json']]),
    )
    for (const entry of captured) {
      expect(entry.GITHUB_TOKEN).toBeUndefined()
      expect(entry.GH_TOKEN).toBeUndefined()
    }
  })
})
