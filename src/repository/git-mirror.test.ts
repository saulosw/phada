import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommandNotFoundError, CommandTimeoutError } from '../process/errors.js'
import type { RunCommandOptions, RunCommandResult } from '../process/run-command.js'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import { CheckoutUnavailableError } from './git-checkout.js'
import { openGitMirror } from './git-mirror.js'
import type { GitMirror, GitMirrorOptions, TreeFile } from './git-mirror.js'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
const ODD_NAME = 'quote"and\nnewline.ts'

let repository: LocalRepository
let parent: string

beforeAll(() => {
  repository = createLocalRepository(
    {
      'src/a.ts': 'export const a = 1\n',
      'nome com espaço.md': 'olá',
      [ODD_NAME]: 'odd\n',
      'bin/data.bin': Buffer.from([1, 2, 0, 3]),
      'empty.txt': '',
    },
    { symlinks: { 'link.txt': 'src/a.ts' }, submodules: ['vendor/lib'] },
  )
  parent = mkdtempSync(join(tmpdir(), 'phada-mirror-test-'))
})

afterAll(() => {
  repository.remove()
  rmSync(parent, { recursive: true, force: true })
})

let count = 0
function options(overrides: Partial<GitMirrorOptions> = {}): GitMirrorOptions {
  count += 1
  return {
    dir: join(parent, `m${count}`, 'shop.git'),
    owner: 'acme',
    repo: 'shop',
    token: TOKEN,
    env: process.env,
    remoteUrl: repository.url,
    ...overrides,
  }
}

async function all(mirror: GitMirror, files: readonly TreeFile[]) {
  const read: { oid: string; bytes: Uint8Array }[] = []
  for await (const blob of mirror.readBlobs(files)) read.push(blob)
  return read
}

describe('GitMirror with a local repository', () => {
  it('fetches a commit into a persistent bare repository and keeps a ref to it', async () => {
    const opts = options()
    const mirror = await openGitMirror(opts)

    expect(await mirror.fetch(repository.sha, 'refs/phada/pull/1')).toBe(repository.sha)
    const ref = execFileSync('git', ['-C', opts.dir, 'rev-parse', 'refs/phada/pull/1'], {
      encoding: 'utf8',
    })
    expect(ref.trim()).toBe(repository.sha)

    const reopened = await openGitMirror(opts)
    expect(await reopened.checkout(repository.sha).readText('src/a.ts')).toBe(
      'export const a = 1\n',
    )
  })

  it('creates the cache folders readable only by you', async () => {
    const root = join(parent, `private-${count}`)
    await openGitMirror(options({ dir: join(root, 'repos', 'acme', 'shop.git') }))

    for (const dir of [root, join(root, 'repos'), join(root, 'repos', 'acme', 'shop.git')]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  it('fetches a branch name such as HEAD', async () => {
    const mirror = await openGitMirror(options())

    expect(await mirror.fetch('HEAD', 'refs/phada/index')).toBe(repository.sha)
  })

  it('fetches a later commit into the same mirror and still reads the earlier one', async () => {
    const local = createLocalRepository({ 'src/a.ts': 'one\n' })
    try {
      const mirror = await openGitMirror(options({ remoteUrl: local.url }))
      await mirror.fetch(local.sha, 'refs/phada/pull/1')
      const later = local.commit({ 'src/c.ts': 'x' })

      expect(await mirror.fetch(later, 'refs/phada/pull/1')).toBe(later)
      expect(await mirror.checkout(later).readText('src/c.ts')).toBe('x')
      expect((await mirror.listFiles(local.sha)).map((file) => file.path)).toEqual(['src/a.ts'])
    } finally {
      local.remove()
    }
  })

  it('keeps the refs of the most recent pull requests only', async () => {
    const opts = options({ keepPullRefs: 2 })
    const mirror = await openGitMirror(opts)
    for (const number of [1, 2, 3]) {
      await mirror.fetch(repository.sha, `refs/phada/pull/${number}`)
    }
    await mirror.fetch('HEAD', 'refs/phada/index')

    const refs = execFileSync(
      'git',
      ['-C', opts.dir, 'for-each-ref', '--format=%(refname)', 'refs/phada/'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
    expect(refs.filter((ref) => ref.startsWith('refs/phada/pull/'))).toHaveLength(2)
    expect(refs).toContain('refs/phada/pull/3')
    expect(refs).toContain('refs/phada/index')
  })

  it('lists every file of a commit with its exact path, mode, blob and size', async () => {
    const mirror = await openGitMirror(options())
    await mirror.fetch(repository.sha, 'refs/phada/pull/1')
    const files = await mirror.listFiles(repository.sha)

    expect(files.map((file) => file.path).sort()).toEqual(
      [
        'bin/data.bin',
        'empty.txt',
        'link.txt',
        'nome com espaço.md',
        ODD_NAME,
        'src/a.ts',
        'vendor/lib',
      ].sort(),
    )
    const byPath = new Map(files.map((file) => [file.path, file]))
    expect(byPath.get('nome com espaço.md')).toMatchObject({ mode: '100644', size: 4 })
    expect(byPath.get('link.txt')?.mode).toBe('120000')
    expect(byPath.get('vendor/lib')).toMatchObject({ mode: '160000', size: 0 })
    expect(byPath.get('src/a.ts')?.oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reads blobs as exact bytes, in order, across several batches', async () => {
    const mirror = await openGitMirror(options({ batchBytes: 5 }))
    await mirror.fetch(repository.sha, 'refs/phada/pull/1')
    const files = (await mirror.listFiles(repository.sha)).filter((file) =>
      ['nome com espaço.md', 'bin/data.bin', 'empty.txt', 'src/a.ts'].includes(file.path),
    )

    const read = await all(mirror, files)

    expect(read.map((blob) => blob.oid)).toEqual(files.map((file) => file.oid))
    const byOid = new Map(read.map((blob) => [blob.oid, blob.bytes]))
    const bytesOf = (path: string) => byOid.get(files.find((file) => file.path === path)?.oid ?? '')
    expect(bytesOf('nome com espaço.md')).toEqual(new Uint8Array(Buffer.from('olá')))
    expect(bytesOf('bin/data.bin')).toEqual(new Uint8Array([1, 2, 0, 3]))
    expect(bytesOf('empty.txt')).toEqual(new Uint8Array())
  })

  it('opens a checkout of the fetched commit that can search it', async () => {
    const mirror = await openGitMirror({
      dir: options().dir,
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      env: process.env,
      remoteUrl: repository.url,
    })
    const checkout = mirror.checkout(await mirror.fetch(repository.sha, 'refs/phada/pull/9'))

    expect(checkout.commit).toBe(repository.sha)
    expect(await checkout.grep('const a', {})).toEqual([
      { path: 'src/a.ts', line: 1, text: 'export const a = 1' },
    ])
    await checkout.close()
  })

  it('never writes the token to the mirror', async () => {
    const opts = options()
    const mirror = await openGitMirror(opts)
    await mirror.fetch(repository.sha, 'refs/phada/pull/1')

    const files = readdirSync(opts.dir, { recursive: true, encoding: 'utf8' })
      .map((name) => join(opts.dir, name))
      .filter((path) => !path.includes('/objects/'))
      .filter((path) => existsSync(path) && !isDirectory(path))
    for (const path of files) {
      const text = readFileSync(path, 'latin1')
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(BASIC)
    }
    expect(readFileSync(join(opts.dir, 'config'), 'utf8')).not.toContain('extraheader')
  })

  it('lets two fetches into the same mirror finish together', async () => {
    const opts = options()
    const [first, second] = await Promise.all([
      openGitMirror(opts).then((mirror) => mirror.fetch(repository.sha, 'refs/phada/pull/1')),
      openGitMirror(opts).then((mirror) => mirror.fetch('HEAD', 'refs/phada/index')),
    ])

    expect([first, second]).toEqual([repository.sha, repository.sha])
  })

  it('gives up when another process holds the mirror past the timeout', async () => {
    const opts = options({ lockTimeoutMs: 50 })
    const mirror = await openGitMirror(opts)
    writeFileSync(`${opts.dir}.lock`, 'busy')

    await expect(mirror.fetch(repository.sha, 'refs/phada/pull/1')).rejects.toMatchObject({
      name: 'CheckoutUnavailableError',
      reason: 'timeout',
      message: 'Another Phada process is updating the mirror of acme/shop',
    })
    rmSync(`${opts.dir}.lock`)
  })
})

function isDirectory(path: string): boolean {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}

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
const resolved = (sha: string) => (args: readonly string[]) =>
  args.includes('rev-parse') ? { ...ok, stdout: `${sha}\n` } : ok

describe('GitMirror fetch', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/u', GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN }

  it('fetches the ref into its keep-as ref with the token only in the environment', async () => {
    const { run, calls } = fakeRun(resolved('abc123'))
    const dir = join(parent, 'fake1', 'shop.git')
    const mirror = await openGitMirror({ dir, owner: 'acme', repo: 'shop', token: TOKEN, env, run })

    expect(await mirror.fetch('abc123', 'refs/phada/pull/7')).toBe('abc123')
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
      '+abc123:refs/phada/pull/7',
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
  })

  it('hands the signal of the caller to the git fetch', async () => {
    const { run, calls } = fakeRun(resolved('abc123'))
    const dir = join(parent, 'fake-signal', 'shop.git')
    const mirror = await openGitMirror({ dir, owner: 'acme', repo: 'shop', token: TOKEN, env, run })
    const cancel = new AbortController()

    await mirror.fetch('HEAD', 'refs/phada/index', { signal: cancel.signal })

    const fetch = calls.find((call) => call.args.includes('fetch'))
    expect(fetch?.options.signal).toBe(cancel.signal)
  })

  it('drops git variables that point git at another repository or change pathspecs', async () => {
    const { run, calls } = fakeRun(resolved('abc123'))
    const mirror = await openGitMirror({
      dir: join(parent, 'fake2', 'shop.git'),
      owner: 'acme',
      repo: 'shop',
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
    })
    await mirror.fetch('abc123', 'refs/phada/pull/7')
    for (const call of calls) {
      const keys = Object.keys(call.options.env ?? {}).filter((key) => key.startsWith('GIT_'))
      expect(
        keys.filter((key) => !key.startsWith('GIT_CONFIG_') && key !== 'GIT_TERMINAL_PROMPT'),
      ).toEqual(['GIT_SSH_COMMAND', 'GIT_SSL_CAINFO'])
    }
    const fetch = calls.find((call) => call.args.includes('fetch'))
    expect(fetch?.options.env?.GIT_CONFIG_COUNT).toBe('1')
    expect(fetch?.options.env?.GIT_CONFIG_PARAMETERS).toBeUndefined()
  })

  it('reports a failed fetch without the token and keeps the mirror', async () => {
    const dir = join(parent, 'fake3', 'shop.git')
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
    const mirror = await openGitMirror({ dir, owner: 'acme', repo: 'shop', token: TOKEN, env, run })
    const error = (await mirror
      .fetch('0123456789abcdef0123456789abcdef01234567', 'refs/phada/pull/7')
      .catch((caught: unknown) => caught)) as Error

    expect(error).toMatchObject({ name: 'CheckoutUnavailableError', reason: 'fetch-failed' })
    expect(error.message).toMatch(/^Could not fetch 0123456 from acme\/shop: fatal: could not read/)
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(BASIC)
    expect(error.message).not.toContain('more')
    expect(existsSync(dir)).toBe(true)
  })

  it.each([
    'remote: Repository not found.\nfatal: repository not found',
    'fatal: Authentication failed for https://github.com/acme/shop/',
    'remote: Write access to repository not granted.\nfatal: unable to access: The requested URL returned error: 403',
  ])('calls a fetch the remote refuses no access (%s)', async (stderr) => {
    const dir = join(parent, 'fake-denied', 'shop.git')
    const { run } = fakeRun((args) =>
      args.includes('fetch') ? { stdout: '', stderr, exitCode: 128, durationMs: 1 } : ok,
    )
    const mirror = await openGitMirror({ dir, owner: 'acme', repo: 'shop', token: TOKEN, env, run })

    await expect(mirror.fetch('refs/heads/main', 'refs/phada/default')).rejects.toMatchObject({
      name: 'CheckoutUnavailableError',
      reason: 'no-access',
    })
  })

  it.each([
    [new CommandNotFoundError('git'), 'git-missing'],
    [new CommandTimeoutError('git', 120_000), 'timeout'],
  ])('maps %s to %s', async (thrown, reason) => {
    const { run } = fakeRun((args) =>
      (args.includes('init') && reason === 'git-missing') || args.includes('fetch') ? thrown : ok,
    )
    const opening = openGitMirror({
      dir: join(parent, `fake-${reason}`, 'shop.git'),
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      env,
      run,
    }).then((mirror) => mirror.fetch('abc123', 'refs/phada/pull/7'))

    await expect(opening).rejects.toEqual(expect.objectContaining({ reason }))
  })

  it('is a CheckoutUnavailableError', () => {
    expect(new CheckoutUnavailableError('git-missing', 'x')).toBeInstanceOf(Error)
  })
})
