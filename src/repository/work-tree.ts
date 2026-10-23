import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from '../process/run-command.js'
import {
  CheckoutUnavailableError,
  FETCH_TIMEOUT_MS,
  firstLine,
  GIT_READ_TIMEOUT_MS,
  gitEnvironment,
} from './git-checkout.js'
import type { Run } from './git-checkout.js'
import { HISTORY_DEPTH } from './git-mirror.js'
import type { GitMirror } from './git-mirror.js'

export interface WorkTreeInput {
  dir: string
  headSha: string
  baseSha: string
  baseRef: string
  headRef: string
  number: number
  commits: number
  diff: string
}

export interface WorkTree {
  dir: string
  mergeBase: string
  diffFile: string
  warnings: string[]
}

const DIFF_FILE = 'pull-request.diff'

export async function materializeWorkTree(
  mirror: GitMirror,
  input: WorkTreeInput,
  options: { env: NodeJS.ProcessEnv; run?: Run },
): Promise<WorkTree> {
  const run = options.run ?? runCommand
  const env = { ...gitEnvironment(options.env), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
  const headKeep = `refs/phada/pull/${input.number}`
  const baseKeep = `refs/phada/base/${input.number}`
  await mirror.fetch(input.baseSha, baseKeep, { depth: 1 })
  await mirror.fetch(input.headSha, headKeep, {
    depth: Math.min(Math.max(input.commits, 0) + 1, HISTORY_DEPTH),
  })

  const git = async (args: readonly string[], timeoutMs = GIT_READ_TIMEOUT_MS) => {
    const result = await run('git', ['-C', input.dir, ...args], { env, timeoutMs })
    return result
  }
  const must = async (args: readonly string[], what: string, timeoutMs?: number) => {
    const result = await git(args, timeoutMs)
    if (result.exitCode !== 0) {
      throw new CheckoutUnavailableError(
        'fetch-failed',
        `Could not ${what}: ${firstLine(result.stderr)}`,
      )
    }
    return result.stdout.trim()
  }

  await mkdir(input.dir, { recursive: true })
  await must(['init', '-q'], 'prepare the checkout of the pull request')
  await must(['config', 'core.symlinks', 'false'], 'prepare the checkout of the pull request')
  await writeFile(
    join(input.dir, '.git', 'objects', 'info', 'alternates'),
    `${join(mirror.dir, 'objects')}\n`,
  )
  await copyShallow(mirror.dir, input.dir)

  const warnings: string[] = []
  let mergeBase = await findMergeBase(git, input)
  if (mergeBase === undefined) {
    await mirror.deepen(input.baseSha, baseKeep)
    await mirror.deepen(input.headSha, headKeep)
    await copyShallow(mirror.dir, input.dir)
    mergeBase = await findMergeBase(git, input)
  }
  if (mergeBase === undefined) {
    warnings.push(
      `Could not find where the pull request branched from ${input.baseRef}; origin/${input.baseRef} is the base commit.`,
    )
  }
  const base = mergeBase ?? input.baseSha
  await must(
    ['update-ref', `refs/remotes/origin/${input.baseRef}`, base],
    `point origin/${input.baseRef} at the base`,
  )
  const branch = await git(['update-ref', `refs/heads/${input.headRef}`, input.headSha])
  await must(
    branch.exitCode === 0
      ? ['checkout', '-q', input.headRef]
      : ['checkout', '-q', '--detach', input.headSha],
    'check out the pull request head',
    FETCH_TIMEOUT_MS,
  )
  const diffFile = join(input.dir, '.git', DIFF_FILE)
  await writeFile(diffFile, input.diff)
  return { dir: input.dir, mergeBase: base, diffFile, warnings }
}

async function findMergeBase(
  git: (args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>,
  input: WorkTreeInput,
): Promise<string | undefined> {
  const result = await git(['merge-base', input.baseSha, input.headSha])
  const sha = result.stdout.trim()
  return result.exitCode === 0 && sha !== '' ? sha : undefined
}

async function copyShallow(mirrorDir: string, dir: string): Promise<void> {
  const target = join(dir, '.git', 'shallow')
  try {
    await copyFile(join(mirrorDir, 'shallow'), target)
  } catch (error) {
    if (!isMissing(error)) throw error
    await rm(target, { force: true })
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
