import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalRepository } from '../../test/support/git-repo.js'
import type { LocalRepository } from '../../test/support/git-repo.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewSettings } from '../config/merge-config.js'
import type {
  NativeSkillRef,
  ReviewProvider,
  SkillRunRequest,
  SkillRunOutput,
} from '../providers/types.js'
import { openGitMirror } from '../repository/git-mirror.js'
import type { DiffImpact, SkillPass } from '../review/types.js'
import { openNativeRunner } from './native-skill.js'
import type { NativeRunnerInput } from './native-skill.js'

const exec = promisify(execFile)

let repository: LocalRepository
let parent: string
let baseSha: string
let headSha: string

beforeAll(() => {
  repository = createLocalRepository({ 'src/shop.ts': 'a\n' })
  baseSha = repository.sha
  headSha = repository.commit({ 'src/shop.ts': 'b\n' }, 'pr')
  parent = mkdtempSync(join(tmpdir(), 'phada-native-test-'))
})

afterAll(() => {
  repository.remove()
  rmSync(parent, { recursive: true, force: true })
})

const PASS: SkillPass = {
  skill: 'my-review',
  mode: 'native',
  lens: { kind: 'skill', name: 'my-review', text: 'Review.', origin: '/s' },
}
const REF: NativeSkillRef = { kind: 'builtin', invoke: 'code-review' }
const OUTPUT: SkillRunOutput = { text: 'Found 1 issue.', durationMs: 5, blocked: [] }

class SkillProvider implements ReviewProvider {
  readonly id = 'fake-claude'
  readonly requests: SkillRunRequest[] = []
  constructor(
    private readonly onRun: (request: SkillRunRequest) => Promise<void> = async () => {},
  ) {}
  review(): never {
    throw new Error('not used')
  }
  async runSkill(request: SkillRunRequest): Promise<SkillRunOutput> {
    this.requests.push(request)
    await this.onRun(request)
    return OUTPUT
  }
}

const IMPACT: DiffImpact = {
  symbols: [
    {
      kind: 'function',
      name: 'total',
      path: 'src/shop.ts',
      startLine: 1,
      endLine: 3,
      exported: true,
      callers: 1,
      files: 1,
      sites: [
        {
          repo: 'acme/web',
          path: 'src/cart.ts',
          line: 9,
          in: 'checkout',
          kind: 'calls',
          how: 'resolved',
          text: 'total(items)',
        },
      ],
      dependencies: [],
    },
  ],
  omittedSymbols: 0,
  callerFiles: 1,
}

let count = 0
async function runner(
  provider: ReviewProvider,
  overrides: {
    review?: ReviewSettings
    association?: string
    private?: boolean
    data?: Partial<NativeRunnerInput>
  } = {},
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
  const warnings: string[] = []
  const pullRequest = {
    ...pullRequestFixture(),
    baseSha,
    headSha,
    baseRef: 'main',
    headRef: 'feat/x',
    stats: { changedFiles: 1, additions: 1, deletions: 1, commits: 1 },
    association: overrides.association ?? 'OWNER',
    private: overrides.private ?? false,
  }
  const native = await openNativeRunner(
    {
      pullRequest,
      diff: 'diff --git a/src/shop.ts b/src/shop.ts\n',
      review: overrides.review ?? {},
      nativeSkills: new Map([['my-review', REF]]),
      viewer: 'me',
      ...overrides.data,
    },
    {
      mirror,
      provider,
      env: process.env,
      readGitHub: async () => ({}),
      resolveDir: async (path) => (path.includes('missing') ? undefined : path),
      warning: (message) => warnings.push(message),
      tempRoot: parent,
      ghExecArgv: ['--import', import.meta.resolve('tsx')],
    },
  )
  return { native, warnings, pullRequest }
}

describe('openNativeRunner', () => {
  it('runs the skill in a checkout of the head with the gh facade first in PATH', async () => {
    const provider = new SkillProvider()
    const { native, pullRequest } = await runner(provider)

    const run = await native.runSkill(PASS)
    await native.close()

    const [request] = provider.requests
    expect(run).toEqual({ ...OUTPUT, captured: [] })
    expect(request?.skill).toEqual(REF)
    expect(request?.arguments).toBe(pullRequest.url)
    expect(request?.commands).toBe('read-only')
    expect(request?.readDirs).toEqual([])
    expect(request?.timeoutMs).toBe(1_800_000)
    expect(request?.maxTurns).toBe(100)
    expect(request?.context).toContain(`git diff origin/main...HEAD`)
    expect(request?.env.PATH?.split(':')[0]).toMatch(/phada-gh-.*\/bin$/)
    expect(request?.env.GH_CONFIG_DIR).toBeDefined()
    expect(existsSync(request?.cwd ?? '')).toBe(false)
  })

  it('passes the command policy, folders and timeout of your config', async () => {
    const provider = new SkillProvider()
    const { native } = await runner(provider, {
      review: {
        commands: { policy: ['npm test'], origin: 'user:config.yml' },
        readDirs: { dirs: ['/rules', '/missing'], origin: 'user:config.yml' },
        timeoutMs: 600_000,
      },
    })

    await native.runSkill(PASS)
    await native.close()

    expect(provider.requests[0]?.commands).toEqual(['npm test'])
    expect(provider.requests[0]?.readDirs).toEqual(['/rules'])
    expect(provider.requests[0]?.timeoutMs).toBe(600_000)
  })

  it('warns about a missing folder', async () => {
    const { native, warnings } = await runner(new SkillProvider(), {
      review: { readDirs: { dirs: ['/missing'], origin: 'user:config.yml' } },
    })
    await native.close()

    expect(warnings).toContain('review.readDirs: /missing does not exist; ignored.')
  })

  it('runs read-only for an outside author of a public repository', async () => {
    const provider = new SkillProvider()
    const { native, warnings } = await runner(provider, {
      association: 'NONE',
      review: {
        commands: { policy: 'all', origin: 'user:config.yml' },
        readDirs: { dirs: ['/rules'], origin: 'user:config.yml' },
      },
    })

    await native.runSkill(PASS)
    await native.close()

    expect(provider.requests[0]?.commands).toBe('read-only')
    expect(provider.requests[0]?.readDirs).toEqual([])
    expect(warnings).toContain('acme/shop#12 is from an outside author: the skill runs read-only.')
  })

  it('keeps your policy for an outside author of a private repository', async () => {
    const provider = new SkillProvider()
    const { native } = await runner(provider, {
      association: 'NONE',
      private: true,
      review: { commands: { policy: 'all', origin: 'user:config.yml' } },
    })

    await native.runSkill(PASS)
    await native.close()

    expect(provider.requests[0]?.commands).toBe('all')
  })

  it('collects what the skill posted with gh', async () => {
    const provider = new SkillProvider(async (request) => {
      await exec('gh', ['pr', 'comment', '--body', 'Posted by the skill.'], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
      })
    })
    const { native } = await runner(provider)

    const run = await native.runSkill(PASS)
    await native.close()

    expect(run.captured).toEqual([
      { command: 'gh pr comment', body: 'Posted by the skill.', comments: [] },
    ])
  })

  it('gives the skill the conversation, CI and impact next to the diff and cites them', async () => {
    const read: Record<string, string> = {}
    const provider = new SkillProvider(async (request) => {
      for (const name of ['conversation.jsonl', 'ci.md', 'impact.md']) {
        read[name] = readFileSync(join(request.cwd, '.git', name), 'utf8')
      }
    })
    const { native } = await runner(provider, {
      data: {
        conversation: [
          {
            kind: 'comment',
            at: '2026-10-20T10:00:00Z',
            author: 'ana',
            role: 'member',
            body: 'Why?',
          },
        ],
        ci: [
          { name: 'test', state: 'failing', conclusion: 'failure', log: 'Error: boom' },
          { name: 'lint', state: 'passing' },
        ],
        impact: IMPACT,
        related: [
          { repo: 'acme/web', commit: 'c'.repeat(40), state: 'consumers', count: 1, graph: true },
        ],
      },
    })

    await native.runSkill(PASS)
    await native.close()

    expect(read['conversation.jsonl']).toBe(
      '{"kind":"comment","at":"2026-10-20T10:00:00Z","author":"ana","role":"member","body":"Why?"}\n',
    )
    expect(read['ci.md']).toBe(
      '{"name":"test","state":"failing","conclusion":"failure","log":"Error: boom"}\n{"name":"lint","state":"passing"}\n',
    )
    expect(read['impact.md']).toBe(
      [
        '## Related repositories',
        '',
        `acme/web at ccccccc — uses the changed code at 1 place`,
        '',
        '## Impact',
        '',
        'function total (src/shop.ts:1-3, exported) — 1 caller in 1 file',
        '  acme/web:src/cart.ts:9 in checkout: total(items)',
        '',
      ].join('\n'),
    )
    const context = provider.requests[0]?.context ?? ''
    expect(context).toContain('/.git/conversation.jsonl')
    expect(context).toContain('/.git/ci.md')
    expect(context).toContain('/.git/impact.md')
  })

  it('answers gh pr checks with the checks Phada read', async () => {
    let answer = ''
    const provider = new SkillProvider(async (request) => {
      const run = await exec('gh', ['pr', 'checks', '--json', 'name,state,bucket,link,startedAt'], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
      })
      answer = run.stdout
    })
    const { native } = await runner(provider, {
      data: {
        checks: [
          {
            name: 'test',
            kind: 'check-run',
            id: 3,
            actions: true,
            state: 'failing',
            conclusion: 'failure',
            title: 'Tests failed',
            url: 'https://github.com/acme/shop/actions/runs/1/job/3',
            startedAt: '2026-10-20T10:00:00Z',
            completedAt: '2026-10-20T10:02:00Z',
          },
          {
            name: 'e2e',
            kind: 'check-run',
            id: 4,
            actions: true,
            state: 'pending',
            status: 'in_progress',
          },
          {
            name: 'ci/lint',
            kind: 'status',
            actions: false,
            state: 'passing',
            conclusion: 'success',
          },
        ],
      },
    })

    await native.runSkill(PASS)
    await native.close()

    expect(JSON.parse(answer)).toEqual([
      {
        name: 'test',
        state: 'FAILURE',
        bucket: 'fail',
        link: 'https://github.com/acme/shop/actions/runs/1/job/3',
        startedAt: '2026-10-20T10:00:00Z',
      },
      {
        name: 'e2e',
        state: 'IN_PROGRESS',
        bucket: 'pending',
        link: '',
        startedAt: '0001-01-01T00:00:00Z',
      },
      {
        name: 'ci/lint',
        state: 'SUCCESS',
        bucket: 'pass',
        link: '',
        startedAt: '0001-01-01T00:00:00Z',
      },
    ])
  })

  it('writes only the files that have content', async () => {
    const seen: string[] = []
    const provider = new SkillProvider(async (request) => {
      seen.push(...readdirSync(join(request.cwd, '.git')))
    })
    const { native } = await runner(provider, {
      data: { conversation: [], ci: [{ name: 'lint', state: 'passing' }] },
    })

    await native.runSkill(PASS)
    await native.close()

    expect(seen).toContain('ci.md')
    expect(seen).not.toContain('conversation.jsonl')
    expect(seen).not.toContain('impact.md')
    expect(provider.requests[0]?.context).not.toContain('conversation.jsonl')
    expect(provider.requests[0]?.context).not.toContain('impact.md')
  })

  it('reuses the checkout for two passes and gives each its own captures', async () => {
    let first = true
    const provider = new SkillProvider(async (request) => {
      if (!first) return
      first = false
      await exec('gh', ['pr', 'comment', '--body', 'once'], {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
      })
    })
    const { native } = await runner(provider)

    const one = await native.runSkill(PASS)
    const two = await native.runSkill(PASS)
    await native.close()

    expect(provider.requests[0]?.cwd).toBe(provider.requests[1]?.cwd)
    expect(one.captured).toHaveLength(1)
    expect(two.captured).toHaveLength(0)
  })

  it('removes the folder when the provider fails', async () => {
    const failing: ReviewProvider = {
      id: 'x',
      review: () => Promise.reject(new Error('unused')),
      runSkill: () => Promise.reject(new Error('boom')),
    }
    const seen: string[] = []
    const provider = new SkillProvider()
    const { native } = await runner({
      ...failing,
      runSkill: async (request) => {
        seen.push(request.cwd)
        return provider.runSkill(request).then(() => {
          throw new Error('boom')
        })
      },
    })

    await expect(native.runSkill(PASS)).rejects.toThrow('boom')
    await native.close()

    expect(existsSync(seen[0] ?? '')).toBe(false)
  })

  it('refuses a provider that does not run skills', async () => {
    const { native } = await runner({ id: 'ollama', review: () => Promise.reject(new Error('x')) })

    await expect(native.runSkill(PASS)).rejects.toThrow('ollama cannot run skills natively.')
    await native.close()
  })
})

describe('openNativeRunner cleanup', () => {
  it('removes the work folder when the folders of your config cannot be read', async () => {
    count += 1
    const mirror = await openGitMirror({
      dir: join(parent, `m${count}`, 'shop.git'),
      owner: 'acme',
      repo: 'shop',
      token: 'x',
      env: process.env,
      remoteUrl: repository.url,
    })
    const root = mkdtempSync(join(tmpdir(), 'phada-native-root-'))

    await expect(
      openNativeRunner(
        {
          pullRequest: {
            ...pullRequestFixture(),
            baseSha,
            headSha,
            baseRef: 'main',
            headRef: 'feat/x',
            stats: { changedFiles: 1, additions: 1, deletions: 1, commits: 1 },
          },
          diff: '',
          review: { readDirs: { dirs: ['/x'], origin: 'user:config.yml' } },
          nativeSkills: new Map([['my-review', REF]]),
          viewer: 'me',
        },
        {
          mirror,
          provider: new SkillProvider(),
          env: process.env,
          readGitHub: async () => ({}),
          resolveDir: async () => {
            throw new Error('EACCES')
          },
          warning: () => {},
          tempRoot: root,
          ghExecArgv: ['--import', import.meta.resolve('tsx')],
        },
      ),
    ).rejects.toThrow('EACCES')

    expect(readdirSync(root)).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })
})
