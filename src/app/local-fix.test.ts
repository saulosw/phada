import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import type { FixRequest, ReviewProvider } from '../providers/types.js'
import { openLocalGit } from '../repository/local-git.js'
import type { Finding } from '../review/types.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore, RunRecord } from '../store/history-store.js'
import { fixFindings } from './fix-findings.js'
import { readLocalFix } from './local-fix.js'
import type { WorkingFiles } from './apply-file-suggestions.js'

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

const scratch = mkdtempSync(join(tmpdir(), 'phada-local-fix-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const SHOP = [
  'export function spend(userId: string, amount: number) {',
  '  const user = users.get(userId)',
  '  user.crystals -= amount',
  '  return user',
  '}',
  '',
].join('\n')

let stores = 0

function repositoryOnBranch(files: Record<string, string> = { 'src/shop.ts': SHOP }) {
  const repository: LocalRepository = createLocalRepository(files)
  cleanups.push(() => repository.remove())
  git(repository.dir, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git')
  git(repository.dir, 'checkout', '-q', '-b', 'feat/spend')
  return repository
}

async function historyWith(...runs: RunRecord[]): Promise<HistoryStore> {
  const history = await openHistoryStore(join(scratch, `h${++stores}`, 'history.sqlite'))
  cleanups.push(() => history.close())
  for (const run of runs) history.addRun(run)
  return history
}

function localRun(
  overrides: Partial<Omit<RunRecord, 'findings'>> & { headSha: string; reported?: Finding[] },
): RunRecord {
  const { reported: findings = [], ...record } = overrides
  return {
    source: 'local',
    repo: 'acme/shop',
    number: 0,
    branch: 'feat/spend',
    dirty: false,
    startedAt: '2026-11-07T10:00:00.000Z',
    finishedAt: '2026-11-07T10:01:00.000Z',
    status: 'not-published',
    aiCalled: true,
    provider: 'claude',
    verdict: findings.length === 0 ? 'clean' : 'comments',
    findings: findings.length,
    ...record,
    resultJson: JSON.stringify({
      status: 'reviewed',
      local: { repo: 'acme/shop', branch: record.branch ?? 'feat/spend', head: record.headSha },
      review: {
        findings: findings.map((finding) => ({
          rule: null,
          suggestion: null,
          ...finding,
        })),
      },
    }),
  }
}

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

describe('phada fix on the local branch', { timeout: 20_000 }, () => {
  it('applies the suggestions of the last local review of the branch to the working tree, without a commit', async () => {
    const repository = repositoryOnBranch()
    const noAuth = findingFixture({ severity: 'P0', line: 1, title: 'spend has no auth' })
    const negative = findingFixture({
      severity: 'P1',
      line: 3,
      title: 'crystals go negative',
      suggestion: {
        startLine: 3,
        endLine: 3,
        original: '  user.crystals -= amount',
        replacement: '  user.crystals = Math.max(0, user.crystals - amount)',
      },
    })
    const gone = findingFixture({
      severity: 'P2',
      line: 4,
      title: 'returns the whole user',
      suggestion: {
        startLine: 4,
        endLine: 4,
        original: '  return user.id',
        replacement: '  return user.id.trim()',
      },
    })
    const history = await historyWith(
      localRun({ headSha: repository.sha, reported: [noAuth], startedAt: '2026-11-07T09:00:00Z' }),
      localRun({ headSha: repository.sha, reported: [gone, negative, noAuth] }),
      localRun({ headSha: repository.sha, branch: 'feat/other', startedAt: '2026-11-07T11:00Z' }),
    )
    const local = await openLocalGit({ dir: repository.dir, env: process.env })

    const target = await readLocalFix({
      local,
      lastLocalRun: (repo, branch) => history.lastLocalRun(repo, branch),
    })

    expect(target).toMatchObject({
      repo: 'acme/shop',
      branch: 'feat/spend',
      run: 2,
      head: repository.sha,
      reviewedHead: repository.sha,
    })
    expect(target.findings.map(({ number, finding }) => [number, finding.title])).toEqual([
      [1, 'spend has no auth'],
      [2, 'crystals go negative'],
      [3, 'returns the whole user'],
    ])

    const fixed = await fixFindings(target.findings, {
      tree: local,
      files: diskFiles(repository.dir),
    })

    expect(fixed.applied.map(({ number }) => number)).toEqual([2])
    expect(fixed.changedFiles).toEqual(['src/shop.ts'])
    expect(fixed.left.map(({ item, reason }) => [item.number, reason])).toEqual([
      [1, 'no-suggestion'],
      [3, 'not-found'],
    ])
    expect(readFileSync(join(repository.dir, 'src/shop.ts'), 'utf8')).toBe(
      SHOP.replace(
        '  user.crystals -= amount',
        '  user.crystals = Math.max(0, user.crystals - amount)',
      ),
    )
    expect(git(repository.dir, 'rev-parse', 'HEAD')).toBe(repository.sha)
    expect(git(repository.dir, 'status', '--porcelain')).toBe('M src/shop.ts')
  })

  it('says to run phada review first when the branch has no local review', async () => {
    const repository = repositoryOnBranch()
    const history = await historyWith(localRun({ headSha: repository.sha, branch: 'feat/other' }), {
      ...localRun({ headSha: repository.sha }),
      source: 'manual',
      branch: undefined,
      number: 4,
    })
    const local = await openLocalGit({ dir: repository.dir, env: process.env })
    const read = (historyOff?: boolean) =>
      readLocalFix(
        { local, lastLocalRun: (repo, branch) => history.lastLocalRun(repo, branch) },
        historyOff === undefined ? {} : { historyOff },
      )

    await expect(read()).rejects.toMatchObject({
      name: 'NoLocalReviewError',
      message: 'No local review of acme/shop@feat/spend in the history: run phada review first.',
    })
    await expect(read(true)).rejects.toMatchObject({
      message:
        'No local review of acme/shop@feat/spend in the history, which is off in your config: turn it on (history: true) and run phada review first.',
    })
  })

  it('needs HEAD on a branch', async () => {
    const repository = repositoryOnBranch()
    git(repository.dir, 'checkout', '-q', '--detach', 'HEAD')
    const local = await openLocalGit({ dir: repository.dir, env: process.env })

    await expect(readLocalFix({ local, lastLocalRun: () => undefined })).rejects.toMatchObject({
      name: 'NoLocalBranchError',
    })
  })

  it('tells the head the review saw when HEAD moved since', async () => {
    const repository = repositoryOnBranch()
    const reviewed = repository.sha
    const head = repository.commit({ 'src/shop.ts': `${SHOP}// more\n` })
    const history = await historyWith(localRun({ headSha: reviewed }))
    const local = await openLocalGit({ dir: repository.dir, env: process.env })

    const target = await readLocalFix({
      local,
      lastLocalRun: (repo, branch) => history.lastLocalRun(repo, branch),
    })

    expect(target).toMatchObject({ head, reviewedHead: reviewed, findings: [] })
  })

  it('leaves a suggestion whose file is gone and counts only the files the fix changed', async () => {
    const repository = repositoryOnBranch({ 'src/shop.ts': SHOP, 'src/gone.ts': 'old\n' })
    git(repository.dir, 'rm', '-q', 'src/gone.ts')
    writeFileSync(join(repository.dir, 'src/notes.ts'), 'export const draft = 1\n')
    writeFileSync(join(repository.dir, 'src/shop.ts'), SHOP.replace('spend(', 'spendAll('))
    const local = await openLocalGit({ dir: repository.dir, env: process.env })
    const findings = numbered([
      findingFixture({
        file: 'src/gone.ts',
        suggestion: { startLine: 1, endLine: 1, original: 'old', replacement: 'new' },
      }),
      findingFixture({
        file: 'src/notes.ts',
        suggestion: {
          startLine: 1,
          endLine: 1,
          original: 'export const draft = 1',
          replacement: 'export const draft = 2',
        },
      }),
    ])

    const fixed = await fixFindings(findings, { tree: local, files: diskFiles(repository.dir) })

    expect(fixed.left).toEqual([{ item: findings[0], reason: 'missing-file' }])
    expect(fixed.applied).toEqual([findings[1]])
    expect(fixed.changedFiles).toEqual(['src/notes.ts'])
  })

  it('changes nothing when no suggestion applies', async () => {
    const repository = repositoryOnBranch()
    const local = await openLocalGit({ dir: repository.dir, env: process.env })
    const findings = numbered([findingFixture({ title: 'no suggestion' })])

    const fixed = await fixFindings(findings, { tree: local, files: diskFiles(repository.dir) })

    expect(fixed).toEqual({
      applied: [],
      changedFiles: [],
      left: [{ item: findings[0], reason: 'no-suggestion' }],
    })
    expect(git(repository.dir, 'status', '--porcelain')).toBe('')
  })
})

describe('phada fix with an AI that edits', { timeout: 20_000 }, () => {
  function editingProvider(
    edit: (request: FixRequest) => string,
  ): ReviewProvider & { requests: FixRequest[] } {
    const requests: FixRequest[] = []
    return {
      id: 'fake-cli',
      requests,
      review: async () => ({ text: '', durationMs: 0 }),
      fix: async (request) => {
        requests.push(request)
        return {
          text: edit(request),
          durationMs: 5,
          blocked: [{ tool: 'Bash', input: 'npm test' }],
        }
      },
    }
  }

  it('sends the findings the suggestions left to the AI in the working tree and reports what it changed', async () => {
    const repository = repositoryOnBranch({ 'src/shop.ts': SHOP, 'src/cart.ts': 'let total = 0\n' })
    const local = await openLocalGit({ dir: repository.dir, env: process.env })
    const findings = numbered([
      findingFixture({ severity: 'P0', title: 'spend has no auth', why: 'Anyone spends.' }),
      findingFixture({
        file: 'src/cart.ts',
        title: 'total is mutable',
        suggestion: {
          startLine: 1,
          endLine: 1,
          original: 'let total = 0',
          replacement: 'const total = 0',
        },
      }),
      findingFixture({ title: 'race on crystals', rule: 'locks' }),
    ])
    const provider = editingProvider((request) => {
      writeFileSync(join(request.cwd, 'src/shop.ts'), SHOP.replace('spend(', 'spend(auth, '))
      return ['Guarded spend.', '#1 fixed: checks the auth first.'].join('\n')
    })

    const fixed = await fixFindings(findings, {
      tree: local,
      files: diskFiles(repository.dir),
      provider,
    })

    const [request] = provider.requests
    expect(provider.requests).toHaveLength(1)
    expect(realpathSync(request?.cwd ?? '')).toBe(realpathSync(repository.dir))
    expect(request).toMatchObject({ timeoutMs: 900_000, maxTurns: 60 })
    expect(request?.data).toContain('spend has no auth')
    expect(request?.data).toContain('race on crystals')
    expect(request?.data).not.toContain('total is mutable')
    expect(request?.instructions).not.toContain('spend has no auth')
    expect(fixed.applied.map(({ number }) => number)).toEqual([2])
    expect(fixed.changedFiles).toEqual(['src/cart.ts', 'src/shop.ts'])
    expect(fixed.ai).toEqual({
      status: 'answered',
      provider: 'fake-cli',
      changedFiles: ['src/shop.ts'],
      outcomes: [{ number: 1, status: 'fixed', reason: 'checks the auth first.' }],
      unreported: [3],
      summary: 'Guarded spend.',
      blocked: [{ tool: 'Bash', input: 'npm test' }],
    })
    expect(git(repository.dir, 'rev-parse', 'HEAD')).toBe(repository.sha)
  })

  it('keeps the report of the suggestions when the AI fails', async () => {
    const repository = repositoryOnBranch({ 'src/shop.ts': SHOP, 'src/cart.ts': 'let total = 0\n' })
    const local = await openLocalGit({ dir: repository.dir, env: process.env })
    const findings = numbered([
      findingFixture({
        file: 'src/cart.ts',
        suggestion: { startLine: 1, endLine: 1, original: 'let total = 0', replacement: 'x' },
      }),
      findingFixture({ title: 'race on crystals' }),
    ])
    const failure = new Error('Claude did not answer within 900s.')
    const provider = editingProvider(() => {
      throw failure
    })

    const fixed = await fixFindings(findings, {
      tree: local,
      files: diskFiles(repository.dir),
      provider,
    })

    expect(fixed.applied).toEqual([findings[0]])
    expect(fixed.changedFiles).toEqual(['src/cart.ts'])
    expect(fixed.ai).toEqual({
      status: 'failed',
      provider: 'fake-cli',
      changedFiles: [],
      error: failure,
    })
  })

  it('does not call the AI when the suggestions fixed everything', async () => {
    const repository = repositoryOnBranch({ 'src/shop.ts': SHOP, 'src/cart.ts': 'let total = 0\n' })
    const local = await openLocalGit({ dir: repository.dir, env: process.env })
    const findings = numbered([
      findingFixture({
        file: 'src/cart.ts',
        suggestion: { startLine: 1, endLine: 1, original: 'let total = 0', replacement: 'x' },
      }),
    ])
    const provider = editingProvider(() => '')

    const fixed = await fixFindings(findings, {
      tree: local,
      files: diskFiles(repository.dir),
      provider,
    })

    expect(provider.requests).toEqual([])
    expect(fixed.ai).toBeUndefined()
  })
})

function numbered(findings: Finding[]) {
  return findings.map((finding, index) => ({ number: index + 1, finding }))
}
