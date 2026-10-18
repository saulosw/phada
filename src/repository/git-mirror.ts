import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CommandNotFoundError, CommandTimeoutError } from '../process/errors.js'
import { runCommand, runCommandBytes } from '../process/run-command.js'
import type { RunCommandBytesResult, RunCommandOptions } from '../process/run-command.js'
import { redactSecrets } from '../providers/redact-secrets.js'
import type { Checkout } from './checkout.js'
import {
  CheckoutUnavailableError,
  FETCH_TIMEOUT_MS,
  firstLine,
  GIT_READ_TIMEOUT_MS,
  GitCheckout,
  gitEnvironment,
} from './git-checkout.js'
import type { Run } from './git-checkout.js'
import { MirrorLockTimeoutError, withMirrorLock } from './mirror-lock.js'

export const BLOB_BATCH_BYTES = 32_000_000
export const LIST_MAX_OUTPUT = 64_000_000
export const KEEP_PULL_REFS = 20
export const HISTORY_DEPTH = 200
export const DEEPEN_TIMEOUT_MS = 30_000

const SHA = /^[0-9a-f]{40}$/
const PULL_REFS = 'refs/phada/pull/'
const NEWLINE = 0x0a
const NO_ACCESS =
  /repository not found|authentication failed|could not read username|access denied|not granted|permission denied|error: 40[34]/i

export type RunBytes = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => Promise<RunCommandBytesResult>

export interface TreeFile {
  path: string
  oid: string
  mode: string
  size: number
}

export interface GitMirrorOptions {
  dir: string
  owner: string
  repo: string
  token: string
  env: NodeJS.ProcessEnv
  remoteUrl?: string
  run?: Run
  runBytes?: RunBytes
  lockTimeoutMs?: number
  batchBytes?: number
  keepPullRefs?: number
}

export interface CheckoutOptions {
  deepenAs?: string
}

export interface GitMirror {
  readonly dir: string
  fetch(ref: string, keepAs: string): Promise<string>
  checkout(sha: string, options?: CheckoutOptions): Checkout
  deepen(sha: string, keepAs: string): Promise<boolean>
  listFiles(sha: string): Promise<TreeFile[]>
  readBlobs(files: readonly TreeFile[]): AsyncIterable<{ oid: string; bytes: Uint8Array }>
}

export async function openGitMirror(options: GitMirrorOptions): Promise<GitMirror> {
  const run = options.run ?? runCommand
  const env = gitEnvironment(options.env)
  if (!(await isBareRepository(options.dir))) {
    try {
      await mkdir(options.dir, { recursive: true, mode: 0o700 })
      const init = await run('git', ['init', '--bare', '-q', options.dir], {
        env,
        timeoutMs: GIT_READ_TIMEOUT_MS,
      })
      if (init.exitCode !== 0) {
        throw new CheckoutUnavailableError(
          'fetch-failed',
          `Could not prepare the repository mirror in ${options.dir}: ${firstLine(init.stderr)}`,
        )
      }
    } catch (error) {
      throw unavailable(error, options)
    }
  }
  return new GitMirrorRepository(options, run, options.runBytes ?? runCommandBytes, env)
}

class GitMirrorRepository implements GitMirror {
  readonly dir: string
  readonly #options: GitMirrorOptions
  readonly #run: Run
  readonly #runBytes: RunBytes
  readonly #env: NodeJS.ProcessEnv

  constructor(options: GitMirrorOptions, run: Run, runBytes: RunBytes, env: NodeJS.ProcessEnv) {
    this.dir = options.dir
    this.#options = options
    this.#run = run
    this.#runBytes = runBytes
    this.#env = env
  }

  async fetch(ref: string, keepAs: string): Promise<string> {
    const { owner, repo } = this.#options
    try {
      return await withMirrorLock(
        `${this.dir}.lock`,
        {
          timeoutMs: this.#options.lockTimeoutMs ?? FETCH_TIMEOUT_MS,
          staleMs: FETCH_TIMEOUT_MS + 30_000,
        },
        async () => {
          await this.#fetchLocked(ref, keepAs)
          const sha = await this.#resolve(keepAs)
          if (keepAs.startsWith(PULL_REFS)) await this.#dropOldPullRefs(keepAs)
          return sha
        },
      )
    } catch (error) {
      if (error instanceof MirrorLockTimeoutError) {
        throw new CheckoutUnavailableError(
          'timeout',
          `Another Phada process is updating the mirror of ${owner}/${repo}`,
        )
      }
      throw unavailable(error, { owner, repo })
    }
  }

  checkout(sha: string, options: CheckoutOptions = {}): Checkout {
    const keepAs = options.deepenAs
    return new GitCheckout(
      this.#run,
      this.dir,
      sha,
      this.#env,
      keepAs === undefined ? undefined : () => this.deepen(sha, keepAs),
    )
  }

  async deepen(sha: string, keepAs: string): Promise<boolean> {
    try {
      await withMirrorLock(
        `${this.dir}.lock`,
        { timeoutMs: DEEPEN_TIMEOUT_MS, staleMs: FETCH_TIMEOUT_MS + 30_000 },
        () => this.#fetchLocked(sha, keepAs, HISTORY_DEPTH, DEEPEN_TIMEOUT_MS),
      )
      return true
    } catch {
      return false
    }
  }

  async listFiles(sha: string): Promise<TreeFile[]> {
    const result = await this.#run('git', ['-C', this.dir, 'ls-tree', '-r', '-l', '-z', sha], {
      env: this.#env,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      maxOutputLength: LIST_MAX_OUTPUT,
    })
    if (result.exitCode !== 0) {
      throw new CheckoutUnavailableError(
        'fetch-failed',
        `Could not list the files of ${sha.slice(0, 7)}: ${firstLine(result.stderr)}`,
      )
    }
    return result.stdout.split('\0').flatMap((record) => {
      const tab = record.indexOf('\t')
      if (tab === -1) return []
      const [mode = '', , oid = '', size = ''] = record.slice(0, tab).split(/ +/)
      return [{ path: record.slice(tab + 1), oid, mode, size: size === '-' ? 0 : Number(size) }]
    })
  }

  async *readBlobs(files: readonly TreeFile[]): AsyncIterable<{ oid: string; bytes: Uint8Array }> {
    for (const batch of batches(files, this.#options.batchBytes ?? BLOB_BATCH_BYTES)) {
      const total = batch.reduce((sum, file) => sum + file.size, 0)
      const result = await this.#runBytes('git', ['-C', this.dir, 'cat-file', '--batch'], {
        env: this.#env,
        stdin: `${batch.map((file) => file.oid).join('\n')}\n`,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxOutputLength: total + 200 * batch.length + 1024,
      })
      if (result.exitCode !== 0) {
        throw new CheckoutUnavailableError(
          'fetch-failed',
          `Could not read files from the mirror: ${firstLine(result.stderr)}`,
        )
      }
      yield* parseBatch(result.stdout)
    }
  }

  async #fetchLocked(
    ref: string,
    keepAs: string,
    depth = 1,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<void> {
    const { owner, repo, token } = this.#options
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    const url = this.#options.remoteUrl ?? `https://github.com/${owner}/${repo}`
    const fetched = await this.#run(
      'git',
      [
        '-C',
        this.dir,
        'fetch',
        '--depth',
        String(depth),
        '--no-tags',
        '-q',
        url,
        `+${ref}:${keepAs}`,
      ],
      {
        env: {
          ...this.#env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
        },
        timeoutMs,
      },
    )
    if (fetched.exitCode !== 0) {
      const detail = firstLine(fetched.stderr).replaceAll(token, '').replaceAll(basic, '')
      throw new CheckoutUnavailableError(
        NO_ACCESS.test(fetched.stderr) ? 'no-access' : 'fetch-failed',
        `Could not fetch ${SHA.test(ref) ? ref.slice(0, 7) : ref} from ${owner}/${repo}: ${redactSecrets(detail) || `git exited with code ${fetched.exitCode}`}`,
      )
    }
  }

  async #dropOldPullRefs(kept: string): Promise<void> {
    const listed = await this.#run(
      'git',
      ['-C', this.dir, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', PULL_REFS],
      { env: this.#env, timeoutMs: GIT_READ_TIMEOUT_MS },
    )
    if (listed.exitCode !== 0) return
    const others = listed.stdout.split('\n').filter((ref) => ref !== '' && ref !== kept)
    const old = others.slice(Math.max((this.#options.keepPullRefs ?? KEEP_PULL_REFS) - 1, 0))
    if (old.length === 0) return
    await this.#run('git', ['-C', this.dir, 'update-ref', '--stdin'], {
      env: this.#env,
      stdin: old.map((ref) => `delete ${ref}\n`).join(''),
      timeoutMs: GIT_READ_TIMEOUT_MS,
    })
  }

  async #resolve(keepAs: string): Promise<string> {
    const result = await this.#run(
      'git',
      ['-C', this.dir, 'rev-parse', '--verify', '-q', `${keepAs}^{commit}`],
      { env: this.#env, timeoutMs: GIT_READ_TIMEOUT_MS },
    )
    const sha = result.stdout.trim()
    if (result.exitCode !== 0 || sha === '') {
      throw new CheckoutUnavailableError('fetch-failed', `Could not find ${keepAs} in the mirror`)
    }
    return sha
  }
}

async function isBareRepository(dir: string): Promise<boolean> {
  const [head, objects] = await Promise.all([
    stat(join(dir, 'HEAD')).catch(() => undefined),
    stat(join(dir, 'objects')).catch(() => undefined),
  ])
  return head?.isFile() === true && objects?.isDirectory() === true
}

function batches(files: readonly TreeFile[], limit: number): TreeFile[][] {
  const result: TreeFile[][] = []
  let current: TreeFile[] = []
  let size = 0
  for (const file of files) {
    if (current.length > 0 && size + file.size > limit) {
      result.push(current)
      current = []
      size = 0
    }
    current.push(file)
    size += file.size
  }
  if (current.length > 0) result.push(current)
  return result
}

function* parseBatch(output: Uint8Array): Generator<{ oid: string; bytes: Uint8Array }> {
  const decoder = new TextDecoder()
  let position = 0
  while (position < output.length) {
    const end = output.indexOf(NEWLINE, position)
    if (end === -1) return
    const [oid = '', type = '', size = ''] = decoder
      .decode(output.subarray(position, end))
      .split(' ')
    position = end + 1
    if (type === 'missing') continue
    const length = Number(size)
    yield { oid, bytes: output.slice(position, position + length) }
    position += length + 1
  }
}

function unavailable(error: unknown, { owner, repo }: { owner: string; repo: string }): unknown {
  if (error instanceof CommandNotFoundError) {
    return new CheckoutUnavailableError('git-missing', 'git was not found')
  }
  if (error instanceof CommandTimeoutError) {
    return new CheckoutUnavailableError(
      'timeout',
      `Fetching ${owner}/${repo} took more than ${error.timeoutMs / 1000}s`,
    )
  }
  return error
}
