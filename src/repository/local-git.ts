import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CommandNotFoundError, CommandOutputTooLargeError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'
import type { RunCommandResult } from '../process/run-command.js'
import { FETCH_TIMEOUT_MS, firstLine, GIT_READ_TIMEOUT_MS, gitEnvironment } from './git-checkout.js'
import type { Run } from './git-checkout.js'

export type LocalGitErrorReason =
  | 'git-missing'
  | 'not-a-repository'
  | 'no-commits'
  | 'no-origin'
  | 'origin-not-github'
  | 'no-default-base'
  | 'unknown-base'
  | 'no-merge-base'
  | 'failed'

export interface LocalDiffStats {
  changedFiles: number
  additions: number
  deletions: number
}

export interface LocalCommitMessage {
  sha: string
  subject: string
  body: string
}

export interface LocalTree {
  entries: { path: string; size: number }[]
  truncated: boolean
}

export type LocalBase = { defaultBranch: string } | { ref: string }

export interface GitHubRepository {
  owner: string
  repo: string
}

export const DEFAULT_MAX_DIFF_BYTES = 1_000_000

const NEUTRAL_CONFIG = [
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'core.quotePath=true',
  '-c',
  'log.showSignature=false',
]
const PULL_REQUEST_DIFF = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  '--unified=3',
  '--inter-hunk-context=0',
  '--diff-algorithm=default',
  '--indent-heuristic',
  '--submodule=short',
  '--ignore-submodules=none',
  '-O/dev/null',
]

const SYMLINK_MODE = '120000'
const NOT_A_REPOSITORY = /not a git repository/i
const SYNTHETIC_IDENTITY = {
  GIT_AUTHOR_NAME: 'Phada',
  GIT_AUTHOR_EMAIL: 'phada@localhost',
  GIT_COMMITTER_NAME: 'Phada',
  GIT_COMMITTER_EMAIL: 'phada@localhost',
}
const LIST_OPTIONS: GitRunOptions = { timeoutMs: FETCH_TIMEOUT_MS, maxOutputLength: 64_000_000 }

const GITHUB_REMOTE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/:]+@)?github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
const URL_CREDENTIALS = /^([a-z][\w+.-]*:\/\/)[^@/]+@/i

export class LocalDiffTooLargeError extends Error {
  override readonly name = 'LocalDiffTooLargeError'
  readonly maxBytes: number
  readonly bytes?: number

  constructor(range: string, maxBytes: number, bytes?: number) {
    super(
      bytes === undefined
        ? `The diff of ${range} is above the limit of ${maxBytes} bytes.`
        : `The diff of ${range} has ${bytes} bytes, above the limit of ${maxBytes} bytes.`,
    )
    this.maxBytes = maxBytes
    this.bytes = bytes
  }
}

export class LocalGitError extends Error {
  override readonly name = 'LocalGitError'
  readonly reason: LocalGitErrorReason

  constructor(reason: LocalGitErrorReason, message: string) {
    super(message)
    this.reason = reason
  }
}

export interface LocalGitOptions {
  dir: string
  env: NodeJS.ProcessEnv
  run?: Run
}

export async function openLocalGit(options: LocalGitOptions): Promise<LocalGit> {
  const run = options.run ?? runCommand
  const env = { ...gitEnvironment(options.env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  const result = await runGit(run, options.dir, ['rev-parse', '--show-toplevel'], env)
  const root = result.stdout.trim()
  if (result.exitCode !== 0 || root === '') {
    throw new LocalGitError(
      'not-a-repository',
      `${options.dir} is not inside a git repository${notARepositoryDetail(result.stderr)}`,
    )
  }
  return new LocalGit(run, root, env)
}

export class LocalGit {
  readonly root: string
  readonly #run: Run
  readonly #env: NodeJS.ProcessEnv

  constructor(run: Run, root: string, env: NodeJS.ProcessEnv) {
    this.#run = run
    this.root = root
    this.#env = env
  }

  async branch(): Promise<string | undefined> {
    const result = await this.#try(['symbolic-ref', '--short', '-q', 'HEAD'])
    const name = result.stdout.trim()
    return result.exitCode === 0 && name !== '' ? name : undefined
  }

  async head(): Promise<string> {
    const result = await this.#try(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
    if (result.exitCode !== 0) {
      throw new LocalGitError('no-commits', `The repository at ${this.root} has no commits yet.`)
    }
    return result.stdout.trim()
  }

  async origin(): Promise<GitHubRepository> {
    const result = await this.#try(['remote', 'get-url', 'origin'])
    if (result.exitCode !== 0) {
      throw new LocalGitError(
        'no-origin',
        `The repository at ${this.root} has no origin remote: ${firstLine(result.stderr)}`,
      )
    }
    const url = result.stdout.trim()
    const match = GITHUB_REMOTE.exec(url)
    if (match === null) {
      throw new LocalGitError(
        'origin-not-github',
        `The origin remote (${url.replace(URL_CREDENTIALS, '$1')}) is not a GitHub repository.`,
      )
    }
    return { owner: match[1] ?? '', repo: match[2] ?? '' }
  }

  async mergeBase(head: string, base: LocalBase): Promise<string> {
    const target =
      'defaultBranch' in base
        ? await this.#defaultBranchCommit(base.defaultBranch)
        : await this.#baseCommit(base.ref)
    const result = await this.#try(['merge-base', head, target])
    const sha = result.stdout.trim()
    if (result.exitCode !== 0 || sha === '') {
      const name = 'defaultBranch' in base ? `origin/${base.defaultBranch}` : base.ref
      throw new LocalGitError(
        'no-merge-base',
        `${head} and ${name} have no commit in common${detail(result.stderr)}`,
      )
    }
    return sha
  }

  async diff(base: string, head: string, options: { maxBytes?: number } = {}): Promise<string> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DIFF_BYTES
    const range = `${base.slice(0, 7)}..${head.slice(0, 7)}`
    let result: RunCommandResult
    try {
      result = await runGit(
        this.#run,
        this.root,
        ['diff', ...PULL_REQUEST_DIFF, base, head, '--'],
        this.#env,
        { timeoutMs: FETCH_TIMEOUT_MS, maxOutputLength: maxBytes + 1 },
      )
    } catch (error) {
      if (error instanceof CommandOutputTooLargeError)
        throw new LocalDiffTooLargeError(range, maxBytes)
      throw error
    }
    if (result.exitCode !== 0) {
      throw new LocalGitError('failed', `git diff ${range} failed${detail(result.stderr)}`)
    }
    const bytes = Buffer.byteLength(result.stdout)
    if (bytes > maxBytes) throw new LocalDiffTooLargeError(range, maxBytes, bytes)
    return result.stdout
  }

  async stats(base: string, head: string): Promise<LocalDiffStats> {
    const numstat = await this.#must([
      'diff',
      '--numstat',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      base,
      head,
      '--',
    ])
    const stats = { changedFiles: 0, additions: 0, deletions: 0 }
    for (const line of numstat.split('\n')) {
      if (line === '') continue
      const [added = '', deleted = ''] = line.split('\t')
      stats.changedFiles += 1
      stats.additions += Number(added) || 0
      stats.deletions += Number(deleted) || 0
    }
    return stats
  }

  async commitMessages(base: string, head: string): Promise<LocalCommitMessage[]> {
    const log = await this.#must([
      'log',
      '--reverse',
      '--format=%H%x1f%s%x1f%b%x1e',
      `${base}..${head}`,
    ])
    return log.split('\x1e').flatMap((record) => {
      const [sha = '', subject = '', body = ''] = record.replace(/^\n/, '').split('\x1f')
      return sha === '' ? [] : [{ sha, subject, body: body.trim() }]
    })
  }

  async readTree(sha: string): Promise<LocalTree> {
    const listing = await this.#must(['ls-tree', '-r', '-l', '-z', sha], LIST_OPTIONS)
    const entries = listing.split('\0').flatMap((record) => {
      const tab = record.indexOf('\t')
      if (tab === -1) return []
      const [mode = '', type = '', , size = ''] = record.slice(0, tab).split(/ +/)
      if (type !== 'blob' || mode === SYMLINK_MODE) return []
      return [{ path: record.slice(tab + 1), size: Number(size) }]
    })
    return { entries, truncated: false }
  }

  async readFile(sha: string, path: string): Promise<string | null> {
    const object = `${sha}:${path}`
    const type = await this.#try(['cat-file', '-t', object])
    if (type.exitCode !== 0 || type.stdout.trim() !== 'blob') return null
    return this.#must(['cat-file', 'blob', object])
  }

  async commitWorkingTree(message: string): Promise<string | undefined> {
    const head = await this.head()
    const index = resolve(
      this.root,
      (await this.#must(['rev-parse', '--git-path', 'index'])).trim(),
    )
    const scratch = await mkdtemp(join(tmpdir(), 'phada-index-'))
    try {
      const scratchIndex = join(scratch, 'index')
      await copyFile(index, scratchIndex).catch((error: unknown) => {
        if (!isMissing(error)) throw error
      })
      const withIndex = { env: { GIT_INDEX_FILE: scratchIndex } }
      await this.#must(['add', '-A', '--', '.'], { ...withIndex, timeoutMs: FETCH_TIMEOUT_MS })
      const tree = (await this.#must(['write-tree'], withIndex)).trim()
      const headTree = (await this.#must(['rev-parse', `${head}^{tree}`])).trim()
      if (tree === headTree) return undefined
      const date = (await this.#must(['show', '-s', '--format=%cI', head])).trim()
      const commit = await this.#must(
        ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', message],
        { env: { ...SYNTHETIC_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
      )
      return commit.trim()
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async #must(args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    const result = await runGit(
      this.#run,
      this.root,
      args,
      { ...this.#env, ...options.env },
      options,
    )
    if (result.exitCode !== 0) {
      throw new LocalGitError('failed', `git ${args[0]} failed${detail(result.stderr)}`)
    }
    return result.stdout
  }

  async #defaultBranchCommit(branch: string): Promise<string> {
    const sha = await this.#commitOf(`refs/remotes/origin/${branch}`)
    if (sha === undefined) {
      throw new LocalGitError(
        'no-default-base',
        `origin/${branch} is not in this repository; run git fetch origin, or pass --base.`,
      )
    }
    return sha
  }

  async #baseCommit(ref: string): Promise<string> {
    const sha = ref.startsWith('-') ? undefined : await this.#commitOf(ref)
    if (sha === undefined) {
      throw new LocalGitError('unknown-base', `The base ${ref} is not a commit in this repository.`)
    }
    return sha
  }

  async #commitOf(ref: string): Promise<string | undefined> {
    const result = await this.#try(['rev-parse', '--verify', '-q', `${ref}^{commit}`])
    const sha = result.stdout.trim()
    return result.exitCode === 0 && sha !== '' ? sha : undefined
  }

  #try(args: readonly string[]): Promise<RunCommandResult> {
    return runGit(this.#run, this.root, args, this.#env)
  }
}

interface GitRunOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputLength?: number
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function notARepositoryDetail(stderr: string): string {
  const line = firstLine(stderr)
  return line === '' || NOT_A_REPOSITORY.test(line) ? '' : `: ${line}`
}

function detail(stderr: string): string {
  const line = firstLine(stderr)
  return line === '' ? '.' : `: ${line}`
}

async function runGit(
  run: Run,
  dir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: GitRunOptions = {},
): Promise<RunCommandResult> {
  try {
    return await run('git', ['-C', dir, ...NEUTRAL_CONFIG, ...args], {
      env,
      timeoutMs: options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
      ...(options.maxOutputLength === undefined
        ? {}
        : { maxOutputLength: options.maxOutputLength }),
    })
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      throw new LocalGitError(
        'git-missing',
        'git was not found; install git to review local changes.',
      )
    }
    throw error
  }
}
