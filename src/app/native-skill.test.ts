import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
import type { SkillPass } from '../review/types.js'
import { openNativeRunner } from './native-skill.js'

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

let count = 0
async function runner(
  provider: ReviewProvider,
  overrides: { review?: ReviewSettings; association?: string; private?: boolean } = {},
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
