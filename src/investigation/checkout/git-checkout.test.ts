import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommandNotFoundError, CommandTimeoutError } from '../../process/errors.js'
import type { RunCommandOptions, RunCommandResult } from '../../process/run-command.js'
import { createLocalRepository } from '../../../test/support/git-repo.js'
import type { LocalRepository } from '../../../test/support/git-repo.js'
import { CheckoutError } from './checkout.js'
import type { Checkout } from './checkout.js'
import { CheckoutUnavailableError, openGitCheckout } from './git-checkout.js'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')

let repository: LocalRepository
let checkout: Checkout

beforeAll(async () => {
  repository = createLocalRepository(
    {
      'src/a.ts': 'export const a = 1\nexport const needle = 2\n',
      'src/b.ts': 'const NEEDLE = 3\n',
      'docs/guide.md': 'needle in docs\n',
      'nome com espaço.md': 'olá\n',
      'bin/data.bin': Buffer.from([1, 2, 0, 3]),
      'big.txt': 'x'.repeat(1_000_001),
    },
    { symlinks: { 'link.txt': '../../etc/passwd' }, submodules: ['vendor/lib'] },
  )
  checkout = await openGitCheckout({
    owner: 'acme',
    repo: 'shop',
    sha: repository.sha,
    token: TOKEN,
    env: process.env,
    remoteUrl: repository.url,
  })
})

afterAll(async () => {
  await checkout.close()
  repository.remove()
})

describe('openGitCheckout with a local repository', () => {
  it('reads files of the commit', async () => {
    expect(checkout.commit).toBe(repository.sha)
    expect(await checkout.readText('src/a.ts')).toBe(
      'export const a = 1\nexport const needle = 2\n',
    )
    expect(await checkout.readText('nome com espaço.md')).toBe('olá\n')
  })

  it.each([
    ['src', 'directory'],
    ['link.txt', 'symlink'],
    ['vendor/lib', 'submodule'],
    ['bin/data.bin', 'binary'],
    ['big.txt', 'too-large'],
    ['src/missing.ts', 'not-found'],
    ['src/a', 'not-found'],
  ])('refuses to read %s (%s)', async (path, reason) => {
    await expect(checkout.readText(path)).rejects.toMatchObject({
      name: 'CheckoutError',
      reason,
    })
  })

  it('greps the commit', async () => {
    expect(await checkout.grep('needle', {})).toEqual([
      { path: 'docs/guide.md', line: 1, text: 'needle in docs' },
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
    ])
    expect(await checkout.grep('needle', { path: '**/*.ts' })).toEqual([
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
    ])
    expect(await checkout.grep('needle', { path: 'src', ignoreCase: true })).toEqual([
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
      { path: 'src/b.ts', line: 1, text: 'const NEEDLE = 3' },
    ])
    expect(await checkout.grep('nothing-matches-this', {})).toEqual([])
  })

  it('treats a glob without a folder as matching in every folder', async () => {
    expect(await checkout.grep('needle', { path: '*.ts' })).toEqual([
      { path: 'src/a.ts', line: 2, text: 'export const needle = 2' },
    ])
  })

  it('reports an invalid pattern', async () => {
    await expect(checkout.grep('(', {})).rejects.toMatchObject({ reason: 'invalid-pattern' })
  })

  it('lists folders', async () => {
    expect(await checkout.listDir('')).toEqual([
      { name: 'big.txt', kind: 'file' },
      { name: 'bin', kind: 'dir' },
      { name: 'docs', kind: 'dir' },
      { name: 'link.txt', kind: 'symlink' },
      { name: 'nome com espaço.md', kind: 'file' },
      { name: 'src', kind: 'dir' },
      { name: 'vendor', kind: 'dir' },
    ])
    expect(await checkout.listDir('vendor')).toEqual([{ name: 'lib', kind: 'submodule' }])
    await expect(checkout.listDir('src/a.ts')).rejects.toMatchObject({ reason: 'not-directory' })
    await expect(checkout.listDir('nope')).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('throws a CheckoutError', async () => {
    await expect(checkout.readText('src')).rejects.toBeInstanceOf(CheckoutError)
  })
})

interface Recorded {
  command: string
  args: readonly string[]
  options: RunCommandOptions
}

function fakeRun(answer: (args: readonly string[]) => RunCommandResult | Error) {
  const calls: Recorded[] = []
  const run = async (command: string, args: readonly string[], options: RunCommandOptions = {}) => {
    calls.push({ command, args, options })
    const result = answer(args)
    if (result instanceof Error) throw result
    return result
  }
  return { run, calls }
}

const ok: RunCommandResult = { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }

describe('openGitCheckout fetch', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN }

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'phada-checkout-test-'))
  }

  it('fetches the exact commit with the token only in the environment', async () => {
    const { run, calls } = fakeRun(() => ok)
    const dir = tempDir()
    const opened = await openGitCheckout({
      owner: 'acme',
      repo: 'shop',
      sha: 'abc123',
      token: TOKEN,
      env,
      run,
      makeTempDir: async () => dir,
    })
    const fetch = calls.find((call) => call.args.includes('fetch'))
    expect(fetch?.args).toEqual([
      '-C',
      dir,
      'fetch',
      '--depth',
      '1',
      '--no-tags',
      '-q',
      'https://github.com/acme/shop',
      'abc123',
    ])
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN)
      expect(call.args.join(' ')).not.toContain(BASIC)
      expect(call.options.env?.GITHUB_TOKEN).toBeUndefined()
      expect(call.options.env?.GH_TOKEN).toBeUndefined()
    }
    expect(fetch?.options.env).toMatchObject({
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
    })
    expect(fetch?.options.timeoutMs).toBe(120_000)
    await opened.close()
    expect(existsSync(dir)).toBe(false)
  })

  it('drops git variables that point git at another repository or change pathspecs', async () => {
    const { run, calls } = fakeRun(() => ok)
    const opened = await openGitCheckout({
      owner: 'acme',
      repo: 'shop',
      sha: 'abc123',
      token: TOKEN,
      env: {
        ...env,
        GIT_DIR: '/home/u/project/.git',
        GIT_WORK_TREE: '/home/u/project',
        GIT_INDEX_FILE: '/home/u/project/.git/index',
        GIT_OBJECT_DIRECTORY: '/x',
        GIT_GLOB_PATHSPECS: '1',
        GIT_CONFIG_PARAMETERS: "'url.x.insteadof'='y'",
        GIT_CONFIG_COUNT: '3',
        GIT_SSH_COMMAND: 'ssh -i key',
        GIT_SSL_CAINFO: '/etc/ca.pem',
      },
      run,
      makeTempDir: async () => tempDir(),
    })
    for (const call of calls) {
      const keys = Object.keys(call.options.env ?? {}).filter((key) => key.startsWith('GIT_'))
      expect(
        keys.filter((key) => !key.startsWith('GIT_CONFIG_') && key !== 'GIT_TERMINAL_PROMPT'),
      ).toEqual(['GIT_SSH_COMMAND', 'GIT_SSL_CAINFO'])
    }
    const fetch = calls.find((call) => call.args.includes('fetch'))
    expect(fetch?.options.env?.GIT_CONFIG_COUNT).toBe('1')
    expect(fetch?.options.env?.GIT_CONFIG_PARAMETERS).toBeUndefined()
    expect(fetch?.options.env?.GIT_SSH_COMMAND).toBe('ssh -i key')
    await opened.close()
  })

  it('reports a failed fetch without the token and removes the folder', async () => {
    const dir = tempDir()
    const { run } = fakeRun((args) =>
      args.includes('fetch')
        ? {
            stdout: '',
            stderr: `\nfatal: could not read from https://github.com/acme/shop (Authorization: Basic ${BASIC}) token ${TOKEN}\nmore`,
            exitCode: 128,
            durationMs: 1,
          }
        : ok,
    )
    const opening = openGitCheckout({
      owner: 'acme',
      repo: 'shop',
      sha: 'abc123',
      token: TOKEN,
      env,
      run,
      makeTempDir: async () => dir,
    })
    await expect(opening).rejects.toMatchObject({
      name: 'CheckoutUnavailableError',
      reason: 'fetch-failed',
    })
    const error = (await opening.catch((caught: unknown) => caught)) as Error
    expect(error.message).toMatch(/^Could not fetch the pull request head: fatal: could not read/)
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(BASIC)
    expect(error.message).not.toContain('more')
    expect(existsSync(dir)).toBe(false)
  })

  it.each([
    [new CommandNotFoundError('git'), 'git-missing'],
    [new CommandTimeoutError('git', 120_000), 'timeout'],
  ])('maps %s to %s', async (thrown, reason) => {
    const dir = tempDir()
    const { run } = fakeRun((args) =>
      (args.includes('init') && reason === 'git-missing') || args.includes('fetch') ? thrown : ok,
    )
    await expect(
      openGitCheckout({
        owner: 'acme',
        repo: 'shop',
        sha: 'abc123',
        token: TOKEN,
        env,
        run,
        makeTempDir: async () => dir,
      }),
    ).rejects.toEqual(expect.objectContaining({ reason }))
    expect(existsSync(dir)).toBe(false)
  })

  it('is a CheckoutUnavailableError', () => {
    expect(new CheckoutUnavailableError('git-missing', 'x')).toBeInstanceOf(Error)
  })
})
