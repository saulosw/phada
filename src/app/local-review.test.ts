import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import { findingFixture } from '../../test/support/finding.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import type { ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { createExtractor } from '../repo-map/extract.js'
import { openGitMirror } from '../repository/git-mirror.js'
import { openLocalGit } from '../repository/local-git.js'
import { SkillError } from '../skills/errors.js'
import { openIndexStore } from '../store/index-store.js'
import { openObservedStore } from '../store/observed-store.js'
import { NoDefaultBranchError, NothingToReviewError, reviewLocalChanges } from './local-review.js'
import type { LocalReviewDeps, LocalReviewInput } from './local-review.js'

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

const scratch = mkdtempSync(join(tmpdir(), 'phada-local-review-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const extractor = createExtractor()

const BASE_FILES = {
  'src/shop.ts': 'export function total(prices: number[]) {\n  return 0\n}\n',
  'src/routes.ts': "export const routes = { checkout: 'total' }\n",
  '.phada/rules.md': '- Base rule: totals never go negative.\n',
}

let folders = 0
function folder(name: string): string {
  folders += 1
  return join(scratch, `${name}-${folders}`)
}

interface Clone {
  dir: string
  defaultBranch: string
  commit(files: Record<string, string>, message: string): string
}

function cloneOnBranch(): Clone {
  const origin = createLocalRepository(BASE_FILES)
  cleanups.push(() => origin.remove())
  const dir = folder('clone')
  execFileSync('git', ['clone', '-q', origin.dir, dir], { env: GIT_ENV })
  git(dir, 'remote', 'set-url', 'origin', 'https://github.com/acme/shop.git')
  git(dir, 'checkout', '-q', '-b', 'feat/spend')
  return {
    dir,
    defaultBranch: git(origin.dir, 'symbolic-ref', '--short', 'HEAD'),
    commit: (files, message) => {
      write(dir, files)
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message)
      return git(dir, 'rev-parse', 'HEAD')
    },
  }
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text)
}

interface ReadBack {
  untracked?: string
  symbol?: string
}

async function setup(clone: Clone, repository: { defaultBranch?: string } = {}) {
  const local = await openLocalGit({ dir: clone.dir, env: process.env })
  const mirror = folder('mirror')
  const observed = folder('observed')
  const prompts: ReviewPrompt[] = []
  const warnings: string[] = []
  const readBack: ReadBack = {}
  const provider: ReviewProvider = {
    id: 'fake',
    review: async (prompt) => {
      if (prompt.instructions.includes('verdicts')) {
        return { text: verificationJson([verdictFixture({ id: 1 })]), durationMs: 1 }
      }
      prompts.push(prompt)
      readBack.untracked = (await prompt.tools?.call('read_file', { path: 'src/coupon.ts' }))?.text
      readBack.symbol = (await prompt.tools?.call('find_symbol', { name: 'discount' }))?.text
      await prompt.tools?.call('read_file', { path: 'src/routes.ts' })
      return {
        text: reviewReportJson({
          findings: [
            findingFixture({
              file: 'src/shop.ts',
              line: 2,
              confidence: 95,
              sources: ['src/routes.ts'],
            }),
          ],
        }),
        durationMs: 1,
      }
    },
  }
  const deps: LocalReviewDeps = {
    local,
    readRepository: async () =>
      'defaultBranch' in repository
        ? { private: true, ...repository }
        : { private: true, defaultBranch: clone.defaultBranch },
    reviewDeps: ({ repository: target, sources }) => ({
      contextSources: {
        ...sources,
        readLocalFile: async () => null,
        listLocalDocs: async () => null,
      },
      openMirror: () =>
        openGitMirror({
          dir: mirror,
          ...target,
          token: 'token',
          env: process.env,
          remoteUrl: local.root,
        }),
      openIndexStore: () => openIndexStore(folder('index')),
      openObservedStore: () => openObservedStore(observed),
      extractor,
      now: () => performance.now(),
      createProvider: () => provider,
      skills: {
        find: async (name) => {
          if (name !== 'code-review') throw new SkillError(`Skill "${name}" is not installed.`)
          return {
            name,
            origin: '/skills/code-review/SKILL.md',
            text: 'Find bugs.',
            omitted: [],
            native: {
              kind: 'file',
              fileKind: 'skill',
              path: '/s/code-review/SKILL.md',
              dir: '/s/code-review',
              name,
            },
          }
        },
      },
      runsSkills: true,
      events: {
        contextLoaded: () => {},
        warning: (message) => warnings.push(message),
        indexing: () => {},
        indexed: () => {},
        impactReady: () => {},
        relatedReady: () => {},
      },
    }),
  }
  return {
    deps,
    prompts,
    warnings,
    readBack,
    observedEdges: async () => (await openObservedStore(observed)).all(),
    mirrorRefs: () => git(mirror, 'for-each-ref', '--format=%(refname) %(objectname)'),
  }
}

const input: LocalReviewInput = {
  uncommitted: false,
  userLayers: [],
  mcp: { names: [], declared: [] },
  options: { verify: false, continuation: false },
}

describe('reviewLocalChanges', { timeout: 20_000 }, () => {
  it('reviews the commits of the branch against the merge base with the default branch', async () => {
    const clone = cloneOnBranch()
    const base = git(clone.dir, 'rev-parse', 'HEAD')
    const head = clone.commit(
      { 'src/shop.ts': 'export function total(prices: number[]) {\n  return prices.length\n}\n' },
      'Count the prices\n\nThe total was always zero.',
    )
    const h = await setup(clone)

    const result = await reviewLocalChanges(input, h.deps)

    expect(result.local).toEqual({
      repo: 'acme/shop',
      branch: 'feat/spend',
      base,
      baseRef: clone.defaultBranch,
      head,
      reviewed: head,
      dirty: false,
    })
    expect(result.pullRequest).toMatchObject({
      number: 0,
      title: 'Count the prices',
      description: 'Count the prices\n\nThe total was always zero.',
      headRef: 'feat/spend',
      headSha: head,
      baseSha: base,
      private: true,
      stats: { changedFiles: 1, additions: 1, deletions: 1, commits: 1 },
    })
    expect(result.reviewed.outcome.status).toBe('reviewed')
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.data).toContain('+  return prices.length')
    expect(h.prompts[0]?.data).toContain('Count the prices')
    expect(h.prompts[0]?.data).toContain('The total was always zero.')
    expect(h.mirrorRefs()).toBe(`refs/phada/local ${head}`)
  })

  it('reviews the uncommitted changes as a synthetic head the tools and the graph read', async () => {
    const clone = cloneOnBranch()
    const head = git(clone.dir, 'rev-parse', 'HEAD')
    write(clone.dir, {
      'src/coupon.ts': 'export function discount(total: number) {\n  return total * 0.9\n}\n',
    })
    const h = await setup(clone)

    const result = await reviewLocalChanges({ ...input, uncommitted: true }, h.deps)

    expect(result.local).toMatchObject({ head, dirty: true })
    expect(result.local.reviewed).not.toBe(head)
    expect(result.pullRequest).toMatchObject({
      title: 'Uncommitted changes on feat/spend',
      description: 'This review includes uncommitted changes.',
      headSha: result.local.reviewed,
      stats: { changedFiles: 1, additions: 3, deletions: 0, commits: 0 },
    })
    expect(h.prompts[0]?.data).toContain('+  return total * 0.9')
    expect(h.readBack.untracked).toContain('return total * 0.9')
    expect(h.readBack.symbol).toContain('src/coupon.ts')
    expect(h.mirrorRefs()).toBe(`refs/phada/local ${result.local.reviewed}`)
    expect(git(clone.dir, 'status', '--porcelain')).toBe('?? src/coupon.ts')
  })

  it('reads the rules at the base, not from the branch', async () => {
    const clone = cloneOnBranch()
    clone.commit(
      {
        'src/shop.ts': 'export function total(prices: number[]) {\n  return -1\n}\n',
        '.phada/rules.md': '- Branch rule: anything goes.\n',
      },
      'Return minus one',
    )
    const h = await setup(clone)

    await reviewLocalChanges(input, h.deps)

    expect(h.prompts[0]?.instructions).toContain('Base rule: totals never go negative.')
    expect(h.prompts[0]?.instructions).not.toContain('Branch rule')
    expect(h.prompts[0]?.data).toContain('+- Branch rule: anything goes.')
  })

  it('warns and reviews the commits when nothing is uncommitted', async () => {
    const clone = cloneOnBranch()
    const head = clone.commit({ 'src/coupon.ts': 'export const coupon = 1\n' }, 'Add a coupon')
    const h = await setup(clone)

    const result = await reviewLocalChanges({ ...input, uncommitted: true }, h.deps)

    expect(h.warnings).toContain('Nothing uncommitted: reviewing the commits of feat/spend.')
    expect(result.local).toMatchObject({ head, reviewed: head, dirty: false })
    expect(result.pullRequest.title).toBe('Add a coupon')
  })

  it('refuses a branch with nothing to review before calling the AI', async () => {
    const clone = cloneOnBranch()
    const base = git(clone.dir, 'rev-parse', 'HEAD')
    const h = await setup(clone)

    const review = reviewLocalChanges({ ...input, uncommitted: true }, h.deps)

    await expect(review).rejects.toBeInstanceOf(NothingToReviewError)
    await expect(review).rejects.toThrow(
      `Nothing to review: feat/spend has no changes against ${base.slice(0, 7)}.`,
    )
    expect(h.prompts).toHaveLength(0)
  })

  it('reviews against the base it is given', async () => {
    const clone = cloneOnBranch()
    const first = clone.commit({ 'src/coupon.ts': 'export const coupon = 1\n' }, 'Add a coupon')
    const head = clone.commit({ 'src/coupon.ts': 'export const coupon = 2\n' }, 'Raise it')
    const h = await setup(clone)

    const result = await reviewLocalChanges({ ...input, base: 'HEAD~1' }, h.deps)

    expect(result.local).toMatchObject({ base: first, baseRef: 'HEAD~1', head })
    expect(result.pullRequest).toMatchObject({ title: 'Raise it', baseRef: 'HEAD~1' })
  })

  it('surfaces an unknown base from git', async () => {
    const clone = cloneOnBranch()
    clone.commit({ 'src/coupon.ts': 'export const coupon = 1\n' }, 'Add a coupon')
    const h = await setup(clone)

    await expect(reviewLocalChanges({ ...input, base: 'nope' }, h.deps)).rejects.toMatchObject({
      name: 'LocalGitError',
      reason: 'unknown-base',
    })
  })

  it('needs the default branch of the repository when no base is given', async () => {
    const clone = cloneOnBranch()
    clone.commit({ 'src/coupon.ts': 'export const coupon = 1\n' }, 'Add a coupon')
    const h = await setup(clone, { defaultBranch: undefined })

    await expect(reviewLocalChanges(input, h.deps)).rejects.toBeInstanceOf(NoDefaultBranchError)
    expect(h.prompts).toHaveLength(0)
  })

  it('learns no observed relation from a local review', async () => {
    const clone = cloneOnBranch()
    clone.commit(
      {
        'src/shop.ts':
          "import { discount } from './coupon'\nexport function total(prices: number[]) {\n  return discount(prices.length)\n}\n",
        'src/coupon.ts': 'export function discount(total: number) {\n  return total\n}\n',
      },
      'Apply the discount',
    )
    const h = await setup(clone)

    const result = await reviewLocalChanges(
      { ...input, options: { ...input.options, verify: true } },
      h.deps,
    )

    expect(result.reviewed.outcome).toMatchObject({ status: 'reviewed' })
    expect(result.reviewed.impact.learned).toEqual([])
    expect(await h.observedEdges()).toEqual([])
  })

  it('sends the skills as text, with a warning when the provider would run them natively', async () => {
    const clone = cloneOnBranch()
    clone.commit({ 'src/coupon.ts': 'export const coupon = 1\n' }, 'Add a coupon')
    const h = await setup(clone)

    const result = await reviewLocalChanges(
      { ...input, options: { ...input.options, skills: ['code-review'] } },
      h.deps,
    )

    expect(result.reviewed.passes).toEqual([
      expect.objectContaining({ skill: 'code-review', mode: 'text', status: 'planned' }),
    ])
    expect(h.warnings).toContain(
      'Skill code-review runs as text in a local review: native skills need a pull request.',
    )
  })
})
