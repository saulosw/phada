import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import { runCommand } from '../process/run-command.js'
import { openGitMirror } from './git-mirror.js'
import { materializeWorkTree } from './work-tree.js'

let repository: LocalRepository
let parent: string
let mergeBase: string
let headSha: string
let baseSha: string

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim()

beforeAll(() => {
  repository = createLocalRepository({ 'src/a.ts': 'export const a = 1\n' })
  repository.commit({ 'src/b.ts': 'export const b = 1\n' }, 'base work')
  mergeBase = git(repository.dir, 'rev-parse', 'HEAD')
  git(repository.dir, 'checkout', '-q', '-b', 'feat/x')
  repository.commit({ 'src/a.ts': 'export const a = 2\n' }, 'pr 1')
  repository.commit({ 'src/c.ts': 'export const c = 1\n' }, 'pr 2')
  headSha = repository.commit({ 'src/a.ts': 'export const a = 3\n' }, 'pr 3')
  git(repository.dir, 'checkout', '-q', '-')
  baseSha = repository.commit({ 'README.md': 'later on main\n' }, 'main moves on')
  parent = mkdtempSync(join(tmpdir(), 'phada-work-tree-test-'))
})

afterAll(() => {
  repository.remove()
  rmSync(parent, { recursive: true, force: true })
})

let count = 0
async function materialize(
  overrides: { headRef?: string; baseRef?: string; commits?: number } = {},
) {
  count += 1
  const mirror = await openGitMirror({
    dir: join(parent, `m${count}`, 'shop.git'),
    owner: 'acme',
    repo: 'shop',
    token: 'x',
    env: process.env,
    remoteUrl: repository.url,
  })
  const work = join(parent, `w${count}`)
  const tree = await materializeWorkTree(
    mirror,
    {
      dir: join(work, 'repo'),
      headSha,
      baseSha,
      baseRef: overrides.baseRef ?? 'main',
      headRef: overrides.headRef ?? 'feat/x',
      number: 12,
      commits: overrides.commits ?? 3,
      diff: 'diff --git a/src/a.ts b/src/a.ts\n',
    },
    { env: process.env },
  )
  return { mirror, tree, work }
}

describe('materializeWorkTree', () => {
  it('checks out the head with the merge base as origin/<base>', async () => {
    const { tree } = await materialize()

    expect(tree.mergeBase).toBe(mergeBase)
    expect(tree.warnings).toEqual([])
    expect(git(tree.dir, 'rev-parse', 'HEAD')).toBe(headSha)
    expect(git(tree.dir, 'rev-parse', 'origin/main')).toBe(mergeBase)
    expect(git(tree.dir, 'merge-base', 'origin/main', 'HEAD')).toBe(mergeBase)
    expect(git(tree.dir, 'diff', '--name-only', 'origin/main...HEAD').split('\n')).toEqual([
      'src/a.ts',
      'src/c.ts',
    ])
    expect(git(tree.dir, 'log', '--format=%s', 'origin/main..HEAD').split('\n')).toEqual([
      'pr 3',
      'pr 2',
      'pr 1',
    ])
    expect(git(tree.dir, 'branch', '--show-current')).toBe('feat/x')
    expect(git(tree.dir, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(tree.dir, 'src/a.ts'), 'utf8')).toBe('export const a = 3\n')
  })

  it('writes the diff next to the checkout, outside it', async () => {
    const { tree, work } = await materialize()

    expect(tree.diffFile).toBe(join(work, 'pull-request.diff'))
    expect(readFileSync(tree.diffFile, 'utf8')).toBe('diff --git a/src/a.ts b/src/a.ts\n')
  })

  it('keeps origin/<base> out of the mirror', async () => {
    const { mirror } = await materialize()

    expect(git(mirror.dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toBe('')
  })

  it('checks out a head branch named like the base', async () => {
    const { tree } = await materialize({ headRef: 'main', baseRef: 'main' })

    expect(git(tree.dir, 'rev-parse', 'HEAD')).toBe(headSha)
    expect(git(tree.dir, 'rev-parse', 'origin/main')).toBe(mergeBase)
    expect(git(tree.dir, 'diff', '--name-only', 'origin/main...HEAD')).toContain('src/a.ts')
  })

  it('handles branch names with slashes', async () => {
    const { tree } = await materialize({ baseRef: 'release/1.2' })

    expect(git(tree.dir, 'rev-parse', 'origin/release/1.2')).toBe(mergeBase)
  })

  it('finds the merge base when the head history was too shallow', async () => {
    const { tree } = await materialize({ commits: 0 })

    expect(tree.mergeBase).toBe(mergeBase)
  })

  it('materializes two work trees from the same mirror', async () => {
    count += 1
    const mirror = await openGitMirror({
      dir: join(parent, `m${count}`, 'shop.git'),
      owner: 'acme',
      repo: 'shop',
      token: 'x',
      env: process.env,
      remoteUrl: repository.url,
    })
    const input = (name: string) => ({
      dir: join(parent, name, 'repo'),
      headSha,
      baseSha,
      baseRef: 'main',
      headRef: 'feat/x',
      number: 12,
      commits: 3,
      diff: '',
    })

    const [one, two] = await Promise.all([
      materializeWorkTree(mirror, input(`p${count}a`), { env: process.env }),
      materializeWorkTree(mirror, input(`p${count}b`), { env: process.env }),
    ])

    expect(git(one.dir, 'rev-parse', 'HEAD')).toBe(headSha)
    expect(git(two.dir, 'rev-parse', 'HEAD')).toBe(headSha)
    expect(existsSync(join(one.dir, '.git'))).toBe(true)
  })
})

describe('materializeWorkTree without a merge base', () => {
  it('points origin/<base> at the base commit and warns', async () => {
    count += 1
    const mirror = await openGitMirror({
      dir: join(parent, `m${count}`, 'shop.git'),
      owner: 'acme',
      repo: 'shop',
      token: 'x',
      env: process.env,
      remoteUrl: repository.url,
    })
    const tree = await materializeWorkTree(
      mirror,
      {
        dir: join(parent, `n${count}`, 'repo'),
        headSha,
        baseSha,
        baseRef: 'main',
        headRef: 'feat/x',
        number: 12,
        commits: 3,
        diff: '',
      },
      {
        env: process.env,
        run: async (command, args, options) =>
          args.includes('merge-base')
            ? { exitCode: 1, stdout: '', stderr: '', durationMs: 0 }
            : runCommand(command, args, options),
      },
    )

    expect(tree.mergeBase).toBe(baseSha)
    expect(tree.warnings).toEqual([
      'Could not find where the pull request branched from main; origin/main is the base commit.',
    ])
    expect(git(tree.dir, 'rev-parse', 'origin/main')).toBe(baseSha)
  })
})
