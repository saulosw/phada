import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import { runCommand } from '../process/run-command.js'
import type { Run } from './git-checkout.js'
import { LocalDiffTooLargeError, LocalGitError, openLocalGit } from './local-git.js'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim()

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function repositoryWith(files: Record<string, string | Buffer>): LocalRepository {
  const repository = createLocalRepository(files)
  cleanups.push(() => repository.remove())
  return repository
}

function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phada-local-git-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const open = (dir: string) => openLocalGit({ dir, env: process.env })

describe('openLocalGit', { timeout: 20_000 }, () => {
  it('finds the root, the branch and HEAD from a folder inside the repository', async () => {
    const repository = repositoryWith({ 'src/a.ts': 'export const a = 1\n' })
    git(repository.dir, 'checkout', '-q', '-b', 'feat/x')

    const local = await open(join(repository.dir, 'src'))

    expect(local.root).toBe(realpathSync(repository.dir))
    expect(await local.branch()).toBe('feat/x')
    expect(await local.head()).toBe(repository.sha)
  })

  it('has no branch on a detached HEAD', async () => {
    const repository = repositoryWith({ 'a.ts': 'a\n' })
    git(repository.dir, 'checkout', '-q', '--detach', 'HEAD')

    expect(await (await open(repository.dir)).branch()).toBeUndefined()
  })

  it('refuses a folder outside a git repository', async () => {
    const dir = emptyDir()

    await expect(open(dir)).rejects.toMatchObject({
      name: 'LocalGitError',
      reason: 'not-a-repository',
      message: `${dir} is not inside a git repository`,
    })
  })

  it('refuses a repository with no commits when asked for HEAD', async () => {
    const dir = emptyDir()
    mkdirSync(join(dir, 'repo'))
    git(join(dir, 'repo'), 'init', '-q')

    const local = await open(join(dir, 'repo'))

    await expect(local.head()).rejects.toBeInstanceOf(LocalGitError)
    await expect(local.head()).rejects.toMatchObject({ reason: 'no-commits' })
  })
})

describe('origin', { timeout: 20_000 }, () => {
  it.each([
    'git@github.com:acme/shop.git',
    'git@github.com:acme/shop',
    'ssh://git@github.com/acme/shop.git',
    'ssh://git@github.com:22/acme/shop.git/',
    'https://github.com/acme/shop',
    'https://github.com/acme/shop.git',
    'https://github.com/acme/shop/',
    'https://someone@GitHub.com/acme/shop.git',
  ])('reads owner/repo from %s', async (url) => {
    const repository = repositoryWith({ 'a.ts': 'a\n' })
    git(repository.dir, 'remote', 'add', 'origin', url)

    expect(await (await open(repository.dir)).origin()).toEqual({ owner: 'acme', repo: 'shop' })
  })

  it('refuses a repository without origin', async () => {
    const repository = repositoryWith({ 'a.ts': 'a\n' })

    await expect((await open(repository.dir)).origin()).rejects.toMatchObject({
      name: 'LocalGitError',
      reason: 'no-origin',
    })
  })

  it('refuses an origin outside GitHub without showing its credentials', async () => {
    const repository = repositoryWith({ 'a.ts': 'a\n' })
    git(repository.dir, 'remote', 'add', 'origin', 'https://me:secret@gitlab.com/acme/shop.git')

    const error = await (await open(repository.dir)).origin().catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'LocalGitError', reason: 'origin-not-github' })
    expect((error as Error).message).toContain('gitlab.com/acme/shop.git')
    expect((error as Error).message).not.toContain('secret')
  })
})

function forkedRepository() {
  const repository = repositoryWith({ 'src/a.ts': 'export const a = 1\n' })
  git(repository.dir, 'branch', '-M', 'main')
  const forkPoint = repository.commit({ 'src/b.ts': 'export const b = 1\n' }, 'base work')
  git(repository.dir, 'update-ref', 'refs/remotes/origin/main', forkPoint)
  git(repository.dir, 'checkout', '-q', '-b', 'feat/x')
  repository.commit({ 'src/a.ts': 'export const a = 2\n' }, 'first change')
  const head = repository.commit({ 'src/c.ts': 'export const c = 1\n' }, 'second change')
  git(repository.dir, 'checkout', '-q', 'main')
  const mainHead = repository.commit({ 'README.md': 'later on main\n' }, 'main moves on')
  git(repository.dir, 'update-ref', 'refs/remotes/origin/main', mainHead)
  git(repository.dir, 'checkout', '-q', 'feat/x')
  return { repository, forkPoint, head, mainHead }
}

describe('mergeBase', { timeout: 20_000 }, () => {
  it('finds where the branch left origin/<default branch>', async () => {
    const { repository, forkPoint, head } = forkedRepository()

    const local = await open(repository.dir)

    expect(await local.mergeBase(head, { defaultBranch: 'main' })).toBe(forkPoint)
  })

  it('asks for a fetch when origin/<default branch> is missing', async () => {
    const { repository, head } = forkedRepository()

    const error = await (
      await open(repository.dir)
    )
      .mergeBase(head, { defaultBranch: 'develop' })
      .catch((caught: unknown) => caught)

    expect(error).toMatchObject({ name: 'LocalGitError', reason: 'no-default-base' })
    expect((error as Error).message).toContain('origin/develop')
    expect((error as Error).message).toContain('git fetch origin')
  })

  it('takes an explicit base by ref or by sha', async () => {
    const { repository, forkPoint, head, mainHead } = forkedRepository()
    const local = await open(repository.dir)

    expect(await local.mergeBase(head, { ref: 'main' })).toBe(forkPoint)
    expect(await local.mergeBase(head, { ref: mainHead })).toBe(forkPoint)
    expect(await local.mergeBase(head, { ref: `${head}~1` })).toBe(
      git(repository.dir, 'rev-parse', `${head}~1`),
    )
  })

  it.each(['nope', '--all', 'a'.repeat(40)])('refuses the unknown base %s', async (ref) => {
    const { repository, head } = forkedRepository()

    await expect((await open(repository.dir)).mergeBase(head, { ref })).rejects.toMatchObject({
      name: 'LocalGitError',
      reason: 'unknown-base',
    })
  })

  it('refuses a base with no history in common', async () => {
    const { repository, head } = forkedRepository()
    git(repository.dir, 'checkout', '-q', '--orphan', 'other')
    repository.commit({ 'z.ts': 'z\n' }, 'unrelated')

    await expect(
      (await open(repository.dir)).mergeBase(head, { ref: 'other' }),
    ).rejects.toMatchObject({ reason: 'no-merge-base' })
  })
})

describe('diff', { timeout: 20_000 }, () => {
  function changedRepository() {
    const repository = repositoryWith({
      'src/a.ts': 'export const a = 1\n',
      'docs/guide.md': 'A guide long enough to be detected as the same file when renamed.\n',
    })
    const base = repository.sha
    for (const [key, value] of Object.entries({
      'diff.noprefix': 'true',
      'diff.mnemonicPrefix': 'true',
      'diff.relative': 'true',
      'diff.external': 'false',
      'diff.renames': 'false',
      'color.ui': 'always',
      'color.diff': 'always',
    })) {
      git(repository.dir, 'config', key, value)
    }
    git(repository.dir, 'mv', 'docs/guide.md', 'docs/handbook.md')
    const head = repository.commit(
      {
        'src/a.ts': 'export const a = 2\n',
        'img/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]),
      },
      'change',
    )
    return { repository, base, head }
  }

  it('looks like a pull request diff whatever the git config says', async () => {
    const { repository, base, head } = changedRepository()

    const diff = await (await open(join(repository.dir, 'src'))).diff(base, head)

    expect(diff).not.toContain('\x1b')
    expect(diff).toContain(
      'diff --git a/src/a.ts b/src/a.ts\n' +
        `index ${git(repository.dir, 'rev-parse', '--short=7', `${base}:src/a.ts`)}..`,
    )
    expect(diff).toContain(
      '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 2\n',
    )
    expect(diff).toContain(
      'diff --git a/docs/guide.md b/docs/handbook.md\nsimilarity index 100%\n' +
        'rename from docs/guide.md\nrename to docs/handbook.md\n',
    )
    expect(diff).toContain('diff --git a/img/logo.png b/img/logo.png\nnew file mode 100644\n')
    expect(diff).toContain('Binary files /dev/null and b/img/logo.png differ\n')
  })

  it('refuses a diff above the byte limit', async () => {
    const { repository, base, head } = changedRepository()
    const local = await open(repository.dir)

    const error = await local.diff(base, head, { maxBytes: 100 }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LocalDiffTooLargeError)
    expect(error).toMatchObject({ maxBytes: 100 })
    expect((error as Error).message).toContain('100 bytes')
  })
})

describe('stats and commit messages', { timeout: 20_000 }, () => {
  it('counts the changed files and the lines, binaries included', async () => {
    const repository = repositoryWith({ 'a.ts': 'one\ntwo\nthree\n', 'old.md': 'same text here\n' })
    const base = repository.sha
    repository.commit({ 'a.ts': 'one\n2\nthree\nfour\n' }, 'edit a')
    git(repository.dir, 'mv', 'old.md', 'new.md')
    const head = repository.commit({ 'logo.png': Buffer.from([0, 1, 2, 3, 0]) }, 'add logo')

    expect(await (await open(repository.dir)).stats(base, head)).toEqual({
      changedFiles: 3,
      additions: 2,
      deletions: 1,
    })
  })

  it('lists the commit messages oldest first, with their bodies', async () => {
    const repository = repositoryWith({ 'a.ts': 'a\n' })
    const base = repository.sha
    const first = repository.commit({ 'a.ts': 'b\n' }, 'Add b\n\nBecause b is better.\nReally.')
    const second = repository.commit({ 'a.ts': 'c\n' }, 'Add c')

    expect(await (await open(repository.dir)).commitMessages(base, second)).toEqual([
      { sha: first, subject: 'Add b', body: 'Because b is better.\nReally.' },
      { sha: second, subject: 'Add c', body: '' },
    ])
  })
})

describe('files at a revision', { timeout: 20_000 }, () => {
  it('lists the files of a commit with their sizes, without symbolic links', async () => {
    const repository = createLocalRepository(
      { '.phada/config.yml': 'rules: []\n', 'src/a.ts': 'export const a = 1\n' },
      { symlinks: { 'link.ts': 'src/a.ts' } },
    )
    cleanups.push(() => repository.remove())
    repository.commit({ 'src/later.ts': 'later\n' })

    expect(await (await open(repository.dir)).readTree(repository.sha)).toEqual({
      entries: [
        { path: '.phada/config.yml', size: 10 },
        { path: 'src/a.ts', size: 19 },
      ],
      truncated: false,
    })
  })

  it('reads a file at a commit, and nothing for a missing file or a folder', async () => {
    const repository = repositoryWith({ 'AGENTS.md': 'Be kind.\n', 'docs/x.md': 'x\n' })
    const base = repository.sha
    repository.commit({ 'AGENTS.md': 'Be strict.\n', 'CLAUDE.md': 'new\n' })
    const local = await open(repository.dir)

    expect(await local.readFile(base, 'AGENTS.md')).toBe('Be kind.\n')
    expect(await local.readFile(base, 'CLAUDE.md')).toBeNull()
    expect(await local.readFile(base, 'docs')).toBeNull()
  })
})

describe('commitWorkingTree', { timeout: 20_000 }, () => {
  function userState(dir: string) {
    return {
      status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
      head: git(dir, 'rev-parse', 'HEAD'),
      refs: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
      staged: git(dir, 'diff', '--cached', '--name-status'),
    }
  }

  function dirtyRepository() {
    const repository = repositoryWith({
      '.gitignore': '*.log\n',
      'staged.ts': 'staged 1\n',
      'modified.ts': 'modified 1\n',
      'deleted.ts': 'deleted\n',
    })
    writeFileSync(join(repository.dir, 'staged.ts'), 'staged 2\n')
    git(repository.dir, 'add', 'staged.ts')
    writeFileSync(join(repository.dir, 'modified.ts'), 'modified 2\n')
    rmSync(join(repository.dir, 'deleted.ts'))
    mkdirSync(join(repository.dir, 'new'))
    writeFileSync(join(repository.dir, 'new/untracked.ts'), 'untracked\n')
    writeFileSync(join(repository.dir, 'debug.log'), 'ignored\n')
    return repository
  }

  it('gives the same commit for the same working tree, dated as HEAD', async () => {
    const repository = dirtyRepository()
    execFileSync('git', ['-C', repository.dir, 'commit', '-q', '--amend', '--only', '--no-edit'], {
      env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2020-01-02T03:04:05Z' },
    })
    const local = await open(repository.dir)

    const first = await local.commitWorkingTree('Uncommitted changes')
    const second = await local.commitWorkingTree('Uncommitted changes')

    expect(second).toBe(first)
    expect(git(repository.dir, 'show', '-s', '--format=%cI %aI', first ?? '')).toBe(
      git(repository.dir, 'show', '-s', '--format=%cI %cI', 'HEAD'),
    )
  })

  it('commits staged, modified, deleted and untracked files, leaving ignored ones out', async () => {
    const repository = dirtyRepository()
    const before = userState(repository.dir)

    const sha = await (await open(repository.dir)).commitWorkingTree('Uncommitted changes')

    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(userState(repository.dir)).toEqual(before)
    expect(git(repository.dir, 'ls-tree', '-r', '--name-only', sha ?? '')).toBe(
      ['.gitignore', 'modified.ts', 'new/untracked.ts', 'staged.ts'].join('\n'),
    )
    expect(git(repository.dir, 'show', `${sha}:staged.ts`)).toBe('staged 2')
    expect(git(repository.dir, 'show', `${sha}:modified.ts`)).toBe('modified 2')
    expect(git(repository.dir, 'log', '-1', '--format=%P|%an <%ae>|%s', sha ?? '')).toBe(
      `${repository.sha}|Phada <phada@localhost>|Uncommitted changes`,
    )
  })

  it('works in a linked worktree, whose index lives elsewhere', async () => {
    const repository = repositoryWith({ 'a.ts': 'a\n' })
    const linked = join(emptyDir(), 'linked')
    git(repository.dir, 'worktree', 'add', '-q', '-b', 'side', linked)
    writeFileSync(join(linked, 'a.ts'), 'changed\n')
    const before = userState(linked)

    const sha = await (await open(linked)).commitWorkingTree('Uncommitted changes')

    expect(git(linked, 'show', `${sha}:a.ts`)).toBe('changed')
    expect(userState(linked)).toEqual(before)
  })

  it('removes its temporary index when git fails', async () => {
    const repository = dirtyRepository()
    const scratchIndexes = () =>
      readdirSync(tmpdir()).filter((name) => name.startsWith('phada-index-')).length
    const before = scratchIndexes()
    const run: Run = (command, args, options) =>
      args.includes('write-tree')
        ? Promise.resolve({ stdout: '', stderr: 'fatal: broken\n', exitCode: 128, durationMs: 0 })
        : runCommand(command, args, options)
    const local = await openLocalGit({ dir: repository.dir, env: process.env, run })

    await expect(local.commitWorkingTree('Uncommitted changes')).rejects.toMatchObject({
      name: 'LocalGitError',
      message: 'git write-tree failed: fatal: broken',
    })
    expect(scratchIndexes()).toBe(before)
  })

  it('makes no commit when nothing is uncommitted', async () => {
    const repository = repositoryWith({ '.gitignore': '*.log\n', 'a.ts': 'a\n' })
    writeFileSync(join(repository.dir, 'debug.log'), 'ignored\n')

    expect(
      await (await open(repository.dir)).commitWorkingTree('Uncommitted changes'),
    ).toBeUndefined()
  })

  it('refuses a repository with no commits', async () => {
    const dir = join(emptyDir(), 'repo')
    mkdirSync(dir)
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.ts'), 'a\n')

    await expect((await open(dir)).commitWorkingTree('Uncommitted changes')).rejects.toMatchObject({
      reason: 'no-commits',
    })
  })
})
