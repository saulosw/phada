import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkCodexStatus } from './codex-status.js'

const FAKE = resolve('test/fixtures/bin/fake-codex-status')
const FAKE_SECRET = `ghp_${'A1b2C3d4E5'.repeat(4)}`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phada-codex-status-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function check(mode: string, options: { command?: string; timeoutMs?: number } = {}) {
  return checkCodexStatus({
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

describe('checkCodexStatus', () => {
  it('reports the version and how the CLI is logged in', async () => {
    expect(await check('logged_in')).toEqual({
      provider: 'codex',
      install: { state: 'installed', version: '0.160.0' },
      login: { state: 'logged-in', method: 'chatgpt' },
    })
  })

  it('reports an API key login without the key', async () => {
    const status = await check('api_key')
    expect(status.login).toEqual({ state: 'logged-in', method: 'api-key' })
    expect(JSON.stringify(status)).not.toContain('sk-')
  })

  it('reports a logged-out CLI', async () => {
    expect((await check('logged_out')).login).toEqual({ state: 'logged-out' })
  })

  it('reports a missing CLI as not installed', async () => {
    expect(await check('logged_in', { command: join(dir, 'no-such-codex') })).toEqual({
      provider: 'codex',
      install: { state: 'missing' },
      login: { state: 'unknown', problem: 'not-installed' },
    })
  })

  it('reports a CLI that does not answer in time', async () => {
    expect(await check('hang', { timeoutMs: 300 })).toEqual({
      provider: 'codex',
      install: { state: 'unknown', problem: 'timeout' },
      login: { state: 'unknown', problem: 'timeout' },
    })
  })

  it('reports unexpected output as a state', async () => {
    expect((await check('odd_output')).login).toEqual({
      state: 'unknown',
      problem: 'unexpected-output',
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
      expect.arrayContaining([['--version'], ['login', 'status']]),
    )
    for (const entry of captured) {
      expect(entry.GITHUB_TOKEN).toBeUndefined()
      expect(entry.GH_TOKEN).toBeUndefined()
    }
  })
})
