import { describe, expect, it } from 'vitest'
import { CommandNotFoundError, CommandTimeoutError } from '../process/errors.js'
import type { RunCommandOptions, RunCommandResult } from '../process/run-command.js'
import { ghTokenReader, readGitHubToken } from './github-token.js'

const GH_TOKEN_VALUE = 'gho_fromgh123'

interface Call {
  command: string
  args: readonly string[]
  options: RunCommandOptions
}

type Answer = Partial<RunCommandResult> | Error

function fakeGh(answers: { token?: Answer; status?: Answer }) {
  const calls: Call[] = []
  const run = async (command: string, args: readonly string[], options: RunCommandOptions = {}) => {
    calls.push({ command, args, options })
    const answer = args[1] === 'token' ? answers.token : answers.status
    if (answer instanceof Error) throw answer
    return { stdout: '', stderr: '', exitCode: 1, durationMs: 1, ...answer }
  }
  return { run, calls }
}

const OLD_GH = {
  exitCode: 1,
  stderr: 'unknown flag: --hostname\n\nUsage:  gh auth <command> [flags]\n',
}

describe('readGitHubToken', () => {
  it.each([
    ['GITHUB_TOKEN', { GITHUB_TOKEN: 'ghp_env', GH_TOKEN: 'ghp_other' }, 'ghp_env'],
    ['GH_TOKEN when GITHUB_TOKEN is blank', { GITHUB_TOKEN: '  ', GH_TOKEN: 'ghp_gh\n' }, 'ghp_gh'],
  ])('reads %s before asking gh', async (_case, env, expected) => {
    let asked = 0
    const token = await readGitHubToken({
      env,
      ghToken: async () => {
        asked += 1
        return GH_TOKEN_VALUE
      },
    })
    expect(token).toBe(expected)
    expect(asked).toBe(0)
  })

  it.each([{}, { GITHUB_TOKEN: '', GH_TOKEN: ' \n' }])(
    'asks gh when the environment has no token (%j)',
    async (env) => {
      expect(await readGitHubToken({ env, ghToken: async () => GH_TOKEN_VALUE })).toBe(
        GH_TOKEN_VALUE,
      )
    },
  )

  it('has no token when neither the environment nor gh has one', async () => {
    expect(await readGitHubToken({ env: {}, ghToken: async () => undefined })).toBeUndefined()
  })
})

describe('ghTokenReader', () => {
  it('reads gh auth token for github.com, trimmed, with the environment without tokens', async () => {
    const gh = fakeGh({ token: { exitCode: 0, stdout: `${GH_TOKEN_VALUE}\n` } })
    const read = ghTokenReader({ HOME: '/home/u', PATH: '/bin', GH_TOKEN: '' }, gh.run)

    expect(await read()).toBe(GH_TOKEN_VALUE)
    expect(gh.calls).toEqual([
      {
        command: 'gh',
        args: ['auth', 'token', '--hostname', 'github.com'],
        options: { env: { HOME: '/home/u', PATH: '/bin' }, timeoutMs: 10_000 },
      },
    ])
  })

  it.each([
    ['stderr, as gh 2.4.0 prints it', { exitCode: 0, stderr: `  ✓ Token: ${GH_TOKEN_VALUE}\n` }],
    ['stdout, as newer gh prints it', { exitCode: 0, stdout: `  - Token: ${GH_TOKEN_VALUE}\n` }],
  ])('falls back to gh auth status --show-token on an old gh, reading %s', async (_c, status) => {
    const gh = fakeGh({ token: OLD_GH, status })
    expect(await ghTokenReader({}, gh.run)()).toBe(GH_TOKEN_VALUE)
    expect(gh.calls.map((call) => call.args)).toEqual([
      ['auth', 'token', '--hostname', 'github.com'],
      ['auth', 'status', '--show-token', '--hostname', 'github.com'],
    ])
    expect(gh.calls[1]?.options.timeoutMs).toBe(10_000)
  })

  it.each<[string, { token?: Answer; status?: Answer }]>([
    ['gh is not installed', { token: new CommandNotFoundError('gh') }],
    ['gh does not answer in time', { token: new CommandTimeoutError('gh', 10_000) }],
    [
      'gh is logged out',
      {
        token: { exitCode: 1, stderr: 'no oauth token found for github.com\n' },
        status: { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.\n' },
      },
    ],
    [
      'the old gh prints no token',
      { token: OLD_GH, status: { exitCode: 0, stderr: 'github.com\n' } },
    ],
    ['gh auth token prints nothing', { token: { exitCode: 0, stdout: ' \n' } }],
    [
      'the fallback fails',
      { token: OLD_GH, status: new Error(`gh crashed with Token: ${GH_TOKEN_VALUE}`) },
    ],
  ])('has no token when %s', async (_case, answers) => {
    expect(await ghTokenReader({}, fakeGh(answers).run)()).toBeUndefined()
  })

  it('asks gh once per reader', async () => {
    const gh = fakeGh({ token: { exitCode: 0, stdout: GH_TOKEN_VALUE } })
    const read = ghTokenReader({}, gh.run)
    await Promise.all([read(), read()])
    await read()
    expect(gh.calls).toHaveLength(1)
  })
})
