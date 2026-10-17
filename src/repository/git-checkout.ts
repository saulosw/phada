import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CommandOutputTooLargeError } from '../process/errors.js'
import type { RunCommandOptions, RunCommandResult } from '../process/run-command.js'
import { CheckoutError } from './checkout.js'
import type {
  BlameRange,
  Checkout,
  DirEntry,
  DirEntryKind,
  FileHistory,
  GrepMatch,
  GrepOptions,
  HistoryCommit,
  LineRange,
} from './checkout.js'

export const FETCH_TIMEOUT_MS = 120_000
export const GIT_READ_TIMEOUT_MS = 20_000
export const READ_MAX_FILE_BYTES = 1_000_000
export const GREP_MAX_OUTPUT = 2_000_000
export const HISTORY_COMMITS = 10

const BINARY_PROBE_LENGTH = 8000
const LOG_FORMAT = '--format=%H%x1f%ad%x1f%an%x1f%s%x1e'
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)/
const GITHUB_TOKEN_KEYS: ReadonlySet<string> = new Set(['GITHUB_TOKEN', 'GH_TOKEN'])
const KEPT_GIT_VARIABLES = /^GIT_(SSH|ASKPASS|SSL_|HTTP_|PROXY_|CURL_)/
const GLOB_CHARS = /[*?[\]{}]/
const KIND_BY_MODE: Readonly<Record<string, DirEntryKind>> = {
  '040000': 'dir',
  '120000': 'symlink',
  '160000': 'submodule',
}

export type Run = (
  command: string,
  args: readonly string[],
  options?: RunCommandOptions,
) => Promise<RunCommandResult>

export type CheckoutUnavailableReason = 'git-missing' | 'fetch-failed' | 'no-access' | 'timeout'

export class CheckoutUnavailableError extends Error {
  override readonly name = 'CheckoutUnavailableError'
  readonly reason: CheckoutUnavailableReason

  constructor(reason: CheckoutUnavailableReason, message: string) {
    super(message)
    this.reason = reason
  }
}

interface TreeEntry {
  mode: string
  type: string
  oid: string
  name: string
}

export class GitCheckout implements Checkout {
  readonly commit: string
  readonly #run: Run
  readonly #dir: string
  readonly #env: NodeJS.ProcessEnv
  readonly #deepen: (() => Promise<boolean>) | undefined
  #deepened: Promise<boolean> | undefined

  constructor(
    run: Run,
    dir: string,
    commit: string,
    env: NodeJS.ProcessEnv,
    deepen?: () => Promise<boolean>,
  ) {
    this.#run = run
    this.#dir = dir
    this.commit = commit
    this.#env = env
    this.#deepen = deepen
  }

  async readText(path: string): Promise<string> {
    const entry = await this.#entry(path)
    if (entry.type === 'tree') throw new CheckoutError('directory', `${path} is a folder`)
    if (entry.mode === '120000') throw new CheckoutError('symlink', `${path} is a symbolic link`)
    if (entry.mode === '160000') throw new CheckoutError('submodule', `${path} is a submodule`)
    const size = Number((await this.#git(['cat-file', '-s', entry.oid])).trim())
    if (size > READ_MAX_FILE_BYTES) {
      throw new CheckoutError('too-large', `${path} has ${size} bytes; search it with grep instead`)
    }
    const text = await this.#git(['cat-file', 'blob', entry.oid])
    if (text.slice(0, BINARY_PROBE_LENGTH).includes('\0')) {
      throw new CheckoutError('binary', `${path} is a binary file`)
    }
    return text
  }

  async grep(pattern: string, { path, ignoreCase }: GrepOptions): Promise<GrepMatch[]> {
    const pathspec =
      path === undefined || path === ''
        ? []
        : [
            GLOB_CHARS.test(path)
              ? `:(glob)${path.includes('/') ? '' : '**/'}${path}`
              : `:(literal)${path}`,
          ]
    let result: RunCommandResult
    try {
      result = await this.#run(
        'git',
        [
          '-C',
          this.#dir,
          'grep',
          '-n',
          '-I',
          '-z',
          '--no-color',
          '-E',
          ...(ignoreCase === true ? ['-i'] : []),
          '-e',
          pattern,
          this.commit,
          '--',
          ...pathspec,
        ],
        { env: this.#env, timeoutMs: GIT_READ_TIMEOUT_MS, maxOutputLength: GREP_MAX_OUTPUT },
      )
    } catch (error) {
      if (error instanceof CommandOutputTooLargeError) {
        throw new CheckoutError(
          'too-many-matches',
          'Too many matches; narrow the pattern or the path',
        )
      }
      throw error
    }
    if (result.exitCode === 1) return []
    if (result.exitCode !== 0) {
      throw new CheckoutError('invalid-pattern', `Invalid pattern: ${firstLine(result.stderr)}`)
    }
    const prefix = `${this.commit}:`
    return result.stdout.split('\n').flatMap((line) => {
      const [file = '', number = '', ...text] = line.split('\0')
      if (!file.startsWith(prefix) || number === '') return []
      return [{ path: file.slice(prefix.length), line: Number(number), text: text.join('\0') }]
    })
  }

  async listDir(path: string): Promise<DirEntry[]> {
    let tree = this.commit
    if (path !== '') {
      const entry = await this.#entry(path)
      if (entry.type !== 'tree') throw new CheckoutError('not-directory', `${path} is not a folder`)
      tree = entry.oid
    }
    const entries = parseTree(await this.#git(['ls-tree', '-z', tree]))
    return entries.map(({ mode, name }) => ({ name, kind: KIND_BY_MODE[mode] ?? 'file' }))
  }

  async history(path: string, range?: LineRange): Promise<FileHistory> {
    if (this.#deepen !== undefined) {
      this.#deepened ??= this.#deepen().catch(() => false)
      await this.#deepened
    }
    const shallow = await this.#shallowCommits()
    if (range === undefined) {
      const commits = parseLog(
        await this.#git(
          [
            'log',
            '-n',
            String(HISTORY_COMMITS),
            '--date=short',
            LOG_FORMAT,
            this.commit,
            '--',
            path,
          ],
          {
            GIT_LITERAL_PATHSPECS: '1',
          },
        ),
      )
      const last = commits.at(-1)
      return { commits, truncated: last !== undefined && shallow.has(last.sha) }
    }
    const blame = parseBlame(
      await this.#git([
        'blame',
        '--porcelain',
        '-L',
        `${range.from},${range.to}`,
        this.commit,
        '--',
        path,
      ]).catch((error: unknown) => {
        throw error instanceof CheckoutError
          ? new CheckoutError(
              'not-found',
              `${path} has no lines ${range.from}-${range.to} at the pull request head`,
            )
          : error
      }),
    )
    const shas = new Set(blame.map((item) => item.sha))
    const commits = parseLog(
      await this.#git(
        ['log', '--topo-order', '--date=short', LOG_FORMAT, this.commit, '--', path],
        {
          GIT_LITERAL_PATHSPECS: '1',
        },
      ),
    )
      .filter((commit) => shas.has(commit.sha))
      .slice(0, HISTORY_COMMITS)
    return { commits, blame, truncated: [...shas].some((sha) => shallow.has(sha)) }
  }

  async close(): Promise<void> {}

  async #shallowCommits(): Promise<Set<string>> {
    const text = await readFile(join(this.#dir, 'shallow'), 'utf8').catch(() => '')
    return new Set(text.split('\n').filter((line) => line !== ''))
  }

  async #entry(path: string): Promise<TreeEntry> {
    const [entry] = parseTree(
      await this.#git(['ls-tree', '-z', this.commit, '--', path], { GIT_LITERAL_PATHSPECS: '1' }),
    )
    if (entry === undefined || entry.name !== path) {
      throw new CheckoutError('not-found', `${path} does not exist at the pull request head`)
    }
    return entry
  }

  async #git(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const result = await this.#run('git', ['-C', this.#dir, ...args], {
      env: { ...this.#env, ...extraEnv },
      timeoutMs: GIT_READ_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) {
      throw new CheckoutError('failed', `git ${args[0]} failed: ${firstLine(result.stderr)}`)
    }
    return result.stdout
  }
}

function parseLog(output: string): HistoryCommit[] {
  return output.split('\x1e').flatMap((record) => {
    const [sha = '', date = '', author = '', subject = ''] = record.trim().split('\x1f')
    return sha === '' ? [] : [{ sha, date, author, subject }]
  })
}

function parseBlame(output: string): BlameRange[] {
  const ranges: BlameRange[] = []
  for (const line of output.split('\n')) {
    const header = BLAME_HEADER.exec(line)
    if (header === null) continue
    const sha = header[1] ?? ''
    const final = Number(header[2])
    const last = ranges.at(-1)
    if (last !== undefined && last.sha === sha && last.to === final - 1) last.to = final
    else ranges.push({ from: final, to: final, sha })
  }
  return ranges
}

function parseTree(output: string): TreeEntry[] {
  return output.split('\0').flatMap((record) => {
    const tab = record.indexOf('\t')
    if (tab === -1) return []
    const [mode = '', type = '', oid = ''] = record.slice(0, tab).split(' ')
    return [{ mode, type, oid, name: record.slice(tab + 1) }]
  })
}

export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !GITHUB_TOKEN_KEYS.has(key) && (!key.startsWith('GIT_') || KEPT_GIT_VARIABLES.test(key)),
    ),
  )
}

export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  )
}
