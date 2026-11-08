import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import type { PullRequestMetadata } from '../github/pull-request.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { FixRequest, ReviewProvider } from '../providers/types.js'
import { FINDING_MARKER } from '../publish/markers.js'
import { openGitMirror } from '../repository/git-mirror.js'
import { openLocalGit } from '../repository/local-git.js'
import type { WorkingFiles } from './apply-file-suggestions.js'
import { BranchMovedError } from '../repository/branch-moved.js'
import { commitWorkTree, pushCommit } from '../repository/push-fix.js'
import {
  ClosedPullRequestFixError,
  fixCommitMessage,
  fixPullRequest,
  ForkFixError,
  NoPushPermissionError,
  pushPullRequestFix,
  readPullRequestFix,
} from './pull-request-fix.js'
import type { PullRequestFixTarget } from './pull-request-fix.js'

const SHOP = [
  'export function spend(userId: string, amount: number) {',
  '  const user = users.get(userId)',
  '  user.crystals -= amount',
  '  return user',
  '}',
  '',
].join('\n')
const CLAMPED = '  user.crystals = Math.max(0, user.crystals - amount)'

const scratch = mkdtempSync(join(tmpdir(), 'phada-pr-fix-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
let count = 0

function finding(overrides: Partial<ReviewThread> & { title: string; block?: string }) {
  const { title, block, ...rest } = overrides
  return reviewThread({
    path: 'src/shop.ts',
    body: [`**P1** · ${title} · confidence 90`, 'Why.', ...(block === undefined ? [] : [block])]
      .concat(FINDING_MARKER)
      .join('\n\n'),
    ...rest,
  })
}

function readers(
  overrides: {
    pullRequest?: Partial<PullRequestMetadata>
    repository?: Partial<RepositoryInfo>
    state?: PullRequestReviewState
  } = {},
) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      fetchPullRequest: async () => {
        calls.push('pull request')
        return pullRequestFixture(overrides.pullRequest)
      },
      fetchRepository: async () => {
        calls.push('repository')
        return {
          repo: 'acme/shop',
          private: false,
          empty: false,
          canPush: true,
          ...overrides.repository,
        }
      },
      fetchReviewState: async () => {
        calls.push('threads')
        return overrides.state ?? reviewState()
      },
    },
  }
}

describe('readPullRequestFix', () => {
  it('numbers the open Phada threads of the pull request', async () => {
    const { deps } = readers({
      state: reviewState({
        threads: [
          finding({ id: 'b', line: 4, title: 'returns the whole user' }),
          finding({ id: 'a', line: 3, title: 'crystals go negative' }),
        ],
      }),
    })

    const target = await readPullRequestFix(deps)

    expect(target.pullRequest.headRef).toBe('feature/spend')
    expect(target.findings.map(({ number, thread }) => [number, thread.id])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ])
  })

  it('refuses a pull request from a fork before reading anything else', async () => {
    const { deps, calls } = readers({ pullRequest: { fromFork: true } })

    await expect(readPullRequestFix(deps)).rejects.toBeInstanceOf(ForkFixError)
    await expect(readPullRequestFix(deps)).rejects.toThrow(
      'acme/shop#12 comes from a fork: phada fix pushes only to a branch of acme/shop.',
    )
    expect(calls).not.toContain('repository')
  })

  it('refuses a closed pull request', async () => {
    const { deps } = readers({ pullRequest: { state: 'closed' } })

    await expect(readPullRequestFix(deps)).rejects.toBeInstanceOf(ClosedPullRequestFixError)
  })

  it('refuses a head that moved between the pull request and its threads', async () => {
    const { deps } = readers({ state: reviewState({ headSha: 'f'.repeat(40) }) })

    await expect(readPullRequestFix(deps)).rejects.toBeInstanceOf(BranchMovedError)
    await expect(readPullRequestFix(deps)).rejects.toThrow(
      'feature/spend moved on acme/shop since phada fix read it: nothing was pushed; run phada fix again.',
    )
  })

  it.each([false, undefined])(
    'refuses a token that cannot push (canPush: %s) before reading the threads',
    async (canPush) => {
      const { deps, calls } = readers({ repository: { canPush } })

      await expect(readPullRequestFix(deps)).rejects.toBeInstanceOf(NoPushPermissionError)
      await expect(readPullRequestFix(deps)).rejects.toThrow(
        'Your GitHub token cannot push to acme/shop: phada fix commits to the branch of the pull request.',
      )
      expect(calls).not.toContain('threads')
    },
  )
})

describe('fixPullRequest', { timeout: 20_000 }, () => {
  let repository: LocalRepository

  function remote() {
    repository = createLocalRepository({ 'src/shop.ts': 'start\n', 'src/cart.ts': 'cart\n' })
    cleanups.push(() => repository.remove())
    const baseSha = repository.sha
    const headSha = repository.commit({ 'src/shop.ts': SHOP }, 'spend')
    return { baseSha, headSha }
  }

  async function target(threads: ReviewThread[]): Promise<PullRequestFixTarget> {
    const { baseSha, headSha } = remote()
    return readPullRequestFix({
      fetchPullRequest: async () =>
        pullRequestFixture({
          baseSha,
          headSha,
          stats: { changedFiles: 1, additions: 5, deletions: 1, commits: 1 },
        }),
      fetchRepository: async () => ({
        repo: 'acme/shop',
        private: false,
        empty: false,
        canPush: true,
      }),
      fetchReviewState: async () => reviewState({ headSha, threads }),
    })
  }

  function deps(provider?: ReviewProvider) {
    count += 1
    const tempRoot = join(scratch, `t${count}`)
    mkdirSync(tempRoot, { recursive: true })
    return {
      tempRoot,
      openMirror: () =>
        openGitMirror({
          dir: join(scratch, `m${count}`, 'shop.git'),
          owner: 'acme',
          repo: 'shop',
          token: 'x',
          env: process.env,
          remoteUrl: repository.url,
        }),
      openTree: (dir: string) => openLocalGit({ dir, env: process.env }),
      files: diskFiles,
      env: process.env,
      warning: () => {},
      ...(provider === undefined ? {} : { provider }),
    }
  }

  it('applies the suggestion of a current thread in a work tree of the head and shows the diff', async () => {
    const fixTarget = await target([
      finding({
        id: 'a',
        line: 3,
        title: 'crystals go negative',
        block: `\`\`\`suggestion\n${CLAMPED}\n\`\`\``,
      }),
    ])
    const made = deps()

    const fixed = await fixPullRequest(fixTarget, fixTarget.findings, made)

    expect(fixed.applied.map(({ number }) => number)).toEqual([1])
    expect(fixed.changedFiles).toEqual(['src/shop.ts'])
    expect(fixed.diff).toContain(`-  user.crystals -= amount\n+${CLAMPED}`)
    expect(readFileSync(join(fixed.dir, 'src/shop.ts'), 'utf8')).toContain(CLAMPED)
    expect(readFileSync(join(repository.dir, 'src/shop.ts'), 'utf8')).toBe(SHOP)

    await fixed.close()
    expect(existsSync(fixed.dir)).toBe(false)
    expect(readdirSync(made.tempRoot)).toEqual([])
  })

  it('applies a suggestion at the current range of the thread whatever the lines hold, as GitHub does', async () => {
    const fixTarget = await target([
      finding({
        line: 4,
        startLine: 2,
        title: 'too much',
        block: '```suggestion\n  return users.spend(userId, amount)\n```',
      }),
    ])

    const fixed = await fixPullRequest(fixTarget, fixTarget.findings, deps())
    cleanups.push(() => void fixed.close())

    expect(readFileSync(join(fixed.dir, 'src/shop.ts'), 'utf8')).toBe(
      [SHOP.split('\n')[0], '  return users.spend(userId, amount)', '}', ''].join('\n'),
    )
  })

  it('has the AI CLI edit the work tree for an outdated thread and one without a suggestion', async () => {
    const fixTarget = await target([
      finding({
        id: 'old',
        path: 'src/cart.ts',
        line: null,
        originalLine: 1,
        isOutdated: true,
        title: 'cart is empty',
        block: '```suggestion\nfull cart\n```',
      }),
      finding({ id: 'plain', line: 1, title: 'spend has no auth' }),
    ])
    const requests: FixRequest[] = []
    const provider: ReviewProvider = {
      id: 'fake-cli',
      review: async () => ({ text: '', durationMs: 1 }),
      fix: async (request) => {
        requests.push(request)
        writeFileSync(join(request.cwd, 'src/cart.ts'), 'full cart\n')
        writeFileSync(join(request.cwd, 'src/auth.ts'), 'export const auth = true\n')
        return {
          text: '#1 fixed: filled it.\n#2 skipped: needs a decision.',
          durationMs: 1,
          blocked: [],
        }
      },
    }

    const fixed = await fixPullRequest(fixTarget, fixTarget.findings, deps(provider))
    cleanups.push(() => void fixed.close())

    expect(requests).toHaveLength(1)
    expect(requests[0]?.cwd).toBe(fixed.dir)
    expect(requests[0]?.data).toContain('cart is empty')
    expect(requests[0]?.data).toContain('spend has no auth')
    expect(fixed.left.map(({ item, reason }) => [item.number, reason])).toEqual([
      [1, 'no-suggestion'],
      [2, 'no-suggestion'],
    ])
    expect(fixed.ai).toMatchObject({ status: 'answered', provider: 'fake-cli' })
    expect(fixed.changedFiles).toEqual(['src/auth.ts', 'src/cart.ts'])
    expect(fixed.diff).toContain('+export const auth = true')
    expect(fixed.diff).toContain('-cart\n+full cart')
  })

  it('reports no change and an empty diff when nothing changed', async () => {
    const fixTarget = await target([finding({ line: 1, title: 'spend has no auth' })])

    const fixed = await fixPullRequest(fixTarget, fixTarget.findings, deps())
    cleanups.push(() => void fixed.close())

    expect(fixed.changedFiles).toEqual([])
    expect(fixed.diff).toBe('')
  })

  it('removes the work folder when the head cannot be checked out', async () => {
    const fixTarget = await target([finding({ line: 1, title: 'spend has no auth' })])
    const made = deps()
    const missing = {
      ...fixTarget,
      pullRequest: { ...fixTarget.pullRequest, headSha: 'f'.repeat(40) },
    }

    await expect(fixPullRequest(missing, fixTarget.findings, made)).rejects.toThrow()
    expect(readdirSync(made.tempRoot)).toEqual([])
  })
})

describe('pushPullRequestFix', { timeout: 20_000 }, () => {
  const ANA = { name: 'Ana Lima', email: 'ana@example.com', signing: [] }

  async function fixedOnRemote(provider?: ReviewProvider) {
    const repository = createLocalRepository({ 'src/shop.ts': 'start\n', 'src/cart.ts': 'cart\n' })
    cleanups.push(() => repository.remove())
    const baseSha = repository.sha
    const headSha = repository.commit({ 'src/shop.ts': SHOP }, 'spend')
    count += 1
    const bare = join(scratch, `remote-${count}.git`)
    execFileSync('git', ['clone', '-q', '--bare', repository.dir, bare])
    execFileSync('git', ['-C', bare, 'branch', 'feature/spend', headSha])
    const fixTarget = await readPullRequestFix({
      fetchPullRequest: async () =>
        pullRequestFixture({
          baseSha,
          headSha,
          stats: { changedFiles: 1, additions: 5, deletions: 1, commits: 1 },
        }),
      fetchRepository: async () => ({
        repo: 'acme/shop',
        private: false,
        empty: false,
        canPush: true,
      }),
      fetchReviewState: async () =>
        reviewState({
          headSha,
          threads: [
            finding({
              id: 'a',
              line: 3,
              title: 'crystals go negative',
              block: `\`\`\`suggestion\n${CLAMPED}\n\`\`\``,
            }),
            finding({ id: 'b', line: 1, title: 'spend has no auth' }),
            finding({ id: 'c', line: 4, title: 'returns the whole user' }),
            finding({ id: 'd', line: 5, title: 'no test' }),
          ],
        }),
    })
    const tempRoot = join(scratch, `t${count}`)
    mkdirSync(tempRoot, { recursive: true })
    const fixed = await fixPullRequest(fixTarget, fixTarget.findings, {
      tempRoot,
      openMirror: () =>
        openGitMirror({
          dir: join(scratch, `m${count}`, 'shop.git'),
          owner: 'acme',
          repo: 'shop',
          token: 'x',
          env: process.env,
          remoteUrl: repository.url,
        }),
      openTree: (dir: string) => openLocalGit({ dir, env: process.env }),
      files: diskFiles,
      env: process.env,
      warning: () => {},
      ...(provider === undefined ? {} : { provider }),
    })
    cleanups.push(() => void fixed.close())
    const pushes: string[] = []
    const deps = {
      readHead: async () => headSha,
      commit: (input: { dir: string; tree: string; message: string }) =>
        commitWorkTree({ ...input, identity: ANA, env: process.env }),
      push: async (input: { dir: string; commit: string; branch: string }) => {
        pushes.push(input.branch)
        await pushCommit({
          ...input,
          owner: 'acme',
          repo: 'shop',
          token: 'x',
          url: `file://${bare}`,
          env: process.env,
        })
      },
    }
    return { fixTarget, fixed, deps, bare, headSha, pushes }
  }

  const editingAi: ReviewProvider = {
    id: 'fake-cli',
    review: async () => ({ text: '', durationMs: 1 }),
    fix: async (request) => {
      writeFileSync(join(request.cwd, 'src/auth.ts'), 'export const auth = true\n')
      return {
        text: '#1 fixed: added the check.\n#4 skipped: no test runner.',
        durationMs: 1,
        blocked: [],
      }
    },
  }

  it('commits the fix as the user on the head and pushes it to the branch of the pull request', async () => {
    const { fixTarget, fixed, deps, bare, headSha } = await fixedOnRemote(editingAi)

    const commit = await pushPullRequestFix(fixTarget, fixed, deps)

    const git = (...args: string[]) =>
      execFileSync('git', ['-C', bare, ...args], { encoding: 'utf8' }).trim()
    expect(git('rev-parse', 'refs/heads/feature/spend')).toBe(commit)
    expect(git('show', '-s', '--format=%an <%ae>|%P|%T', commit)).toBe(
      `Ana Lima <ana@example.com>|${headSha}|${fixed.tree}`,
    )
    expect(git('show', '-s', '--format=%B', commit)).toBe(
      [
        'fix: address review comments',
        '',
        '- src/shop.ts:1 spend has no auth',
        '- src/shop.ts:3 crystals go negative',
      ].join('\n'),
    )
  })

  it('refuses to commit when the head of the pull request moved since it was read', async () => {
    const { fixTarget, fixed, deps, bare, headSha, pushes } = await fixedOnRemote()

    const pushing = pushPullRequestFix(fixTarget, fixed, {
      ...deps,
      readHead: async () => 'f'.repeat(40),
    })

    await expect(pushing).rejects.toBeInstanceOf(BranchMovedError)
    await expect(pushing).rejects.toThrow(
      'feature/spend moved on acme/shop since phada fix read it: nothing was pushed; run phada fix again.',
    )
    expect(pushes).toEqual([])
    expect(
      execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/feature/spend'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(headSha)
  })
})

describe('fixCommitMessage', () => {
  it('lists the applied suggestions and what the AI fixed, by number', () => {
    const item = (number: number, file: string, line: number, title: string) => ({
      number,
      thread: { id: String(number), url: '', outdated: false },
      finding: { file, line, title, why: '', fix: null },
    })
    const message = fixCommitMessage({
      applied: [item(3, 'src/b.ts', 9, 'second')],
      changedFiles: ['src/a.ts', 'src/b.ts'],
      left: [
        { item: item(1, 'src/a.ts', 2, 'first\nline'), reason: 'no-suggestion' },
        { item: item(2, 'src/a.ts', 5, 'skipped'), reason: 'no-suggestion' },
        { item: item(4, 'src/c.ts', 1, 'unreported'), reason: 'not-found' },
      ],
      ai: {
        status: 'answered',
        provider: 'fake-cli',
        changedFiles: ['src/a.ts'],
        outcomes: [
          { number: 1, status: 'fixed', reason: 'done' },
          { number: 2, status: 'skipped', reason: 'no' },
        ],
        unreported: [4],
        summary: '',
        blocked: [],
      },
    })

    expect(message).toBe(
      [
        'fix: address review comments',
        '',
        '- src/a.ts:2 first line',
        '- src/b.ts:9 second',
        '',
      ].join('\n'),
    )
  })

  it('is the subject alone when nothing is known to be fixed', () => {
    expect(fixCommitMessage({ applied: [], changedFiles: ['a'], left: [] })).toBe(
      'fix: address review comments\n',
    )
  })
})

function diskFiles(root: string): WorkingFiles {
  return {
    read: async (path) => {
      try {
        return readFileSync(join(root, path), 'utf8')
      } catch {
        return undefined
      }
    },
    write: async (path, text) => writeFileSync(join(root, path), text),
  }
}
