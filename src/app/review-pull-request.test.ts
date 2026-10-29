import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { DeclaredMcpServer } from '../config/mcp-servers.js'
import { McpConnectError } from '../investigation/mcp/mcp-client.js'
import type { McpConnection } from '../investigation/mcp/mcp-client.js'
import { SkillError } from '../skills/errors.js'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import type { ContextSources } from '../context/types.js'
import { ProviderError } from '../providers/types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { createExtractor } from '../repo-map/extract.js'
import type { Checkout } from '../repository/checkout.js'
import { CheckoutError } from '../repository/checkout.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import type { GitMirror, TreeFile } from '../repository/git-mirror.js'
import { IndexStoreError, openIndexStore } from '../store/index-store.js'
import { openObservedStore } from '../store/observed-store.js'
import type { ObservedStore } from '../store/observed-store.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { NativeRunnerDeps, NativeRunnerInput } from './native-skill.js'
import type { RelatedDeps } from './related-repositories.js'
import { ReviewCancelledError } from './review-cancelled.js'
import { reviewPullRequest } from './review-pull-request.js'
import type { PullRequestReviewDeps } from './review-pull-request.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-review-app-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const HEAD = pullRequestFixture().headSha
const extractor = createExtractor()

const HEAD_FILES: Record<string, string> = {
  'src/shop.ts': `import { db } from './db'

export async function spend(userId: string, amount: number) {
  const user = await db.user.find(userId)
  if (user.crystals < amount) throw new Error('insufficient crystals')
  await db.user.update(userId, { crystals: user.crystals - amount })
  return user.crystals - amount
}

export function balance(userId: string) {
  return db.user.find(userId).crystals
}
`,
  'src/api.ts': `import { spend } from './shop'
export function buy(id: string) {
  return spend(id, 1)
}
`,
  'src/routes.ts': "export const routes = { buy: 'spend' }\n",
  'package.json': '{ "name": "shop", "main": "src/shop.ts" }\n',
  '.phada/config.yml': 'ignore: ["**"]\n',
}

const OUTPUT: ReviewOutput = {
  text: reviewReportJson({ findings: [findingFixture({ line: 3, confidence: 95 })] }),
  durationMs: 10,
}

function sources(baseConfig?: string): ContextSources {
  return {
    readTree: async () => ({
      entries: baseConfig === undefined ? [] : [{ path: '.phada/config.yml', size: 10 }],
      truncated: false,
    }),
    readRepoFile: async (path) => (path === '.phada/config.yml' ? (baseConfig ?? null) : null),
    readLocalFile: async () => null,
    listLocalDocs: async () => null,
  }
}

function oidOf(path: string): string {
  return Buffer.from(HEAD_FILES[path] ?? '')
    .toString('hex')
    .padEnd(40, '0')
    .slice(0, 40)
}

function fakeMirror(onClose: () => void, fetched: string[] = []): GitMirror {
  const checkout: Checkout = {
    commit: HEAD,
    readText: async (path) => {
      const text = HEAD_FILES[path]
      if (text === undefined) throw new CheckoutError('not-found', path)
      return text
    },
    grep: async () => [],
    listDir: async () => [],
    history: async () => ({ commits: [], truncated: false }),
    close: async () => onClose(),
  }
  const entries: TreeFile[] = Object.entries(HEAD_FILES).map(([path, text]) => ({
    path,
    oid: oidOf(path),
    mode: '100644',
    size: Buffer.byteLength(text),
  }))
  return {
    dir: '/mirror',
    fetch: async (ref, keepAs) => {
      fetched.push(`${ref} ${keepAs}`)
      return HEAD
    },
    checkout: () => checkout,
    deepen: async () => false,
    listFiles: async () => entries,
    readBlobs: async function* (wanted) {
      for (const file of wanted) {
        yield { oid: file.oid, bytes: new Uint8Array(Buffer.from(HEAD_FILES[file.path] ?? '')) }
      }
    },
  }
}

let stores = 0
function freshPath(name: string): string {
  stores += 1
  return join(dir, `${name}${stores}.sqlite`)
}

function setup(overrides: Partial<PullRequestReviewDeps> = {}, outputs: ReviewOutput[] = [OUTPUT]) {
  const events: string[] = []
  const prompts: ReviewPrompt[] = []
  const servers: boolean[] = []
  const fetched: string[] = []
  let closed = 0
  let observed: ObservedStore | undefined
  const observedPath = freshPath('observed')
  const provider: ReviewProvider = {
    id: 'fake',
    review: async (prompt) => {
      events.push('review')
      prompts.push(prompt)
      if (prompts.length === 1) await prompt.tools?.call('read_file', { path: 'src/routes.ts' })
      return outputs[prompts.length - 1] ?? OUTPUT
    },
  }
  const deps: PullRequestReviewDeps = {
    contextSources: sources(),
    openMirror: async () =>
      fakeMirror(() => {
        closed += 1
      }, fetched),
    openIndexStore: () => openIndexStore(freshPath('index')),
    openObservedStore: async () => {
      observed = await openObservedStore(observedPath)
      return observed
    },
    extractor,
    now: () => 0,
    createProvider: (useNames) => {
      servers.push(useNames)
      return provider
    },
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
    events: {
      contextLoaded: () => events.push('context'),
      warning: (message) => events.push(`warning: ${message}`),
      indexing: (total) => events.push(`indexing ${total}`),
      indexed: () => {},
      impactReady: (report) => events.push(`impact ${report.status}`),
      relatedReady: () => {},
      passesPlanned: (plan) => events.push(`passes ${plan.map(({ skill }) => skill).join(',')}`),
    },
    ...overrides,
  }
  return {
    deps,
    events,
    prompts,
    servers,
    fetched,
    closed: () => closed,
    observedEdges: async () => (await openObservedStore(observedPath)).all(),
  }
}

const input = {
  pullRequest: pullRequestFixture(),
  token: 'token',
  userLayers: [],
  mcp: { names: [{ name: 'linear' }], declared: [] },
  options: { verify: false },
}

const toolNames = (prompt: ReviewPrompt | undefined) =>
  prompt?.tools?.definitions.map((tool) => tool.name)

describe('reviewPullRequest', () => {
  it('indexes the head, sends the impact of the diff and gives the AI the graph tools', async () => {
    const h = setup()

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toEqual([
      'context',
      'indexing 3',
      'impact used',
      'warning: acme/shop is public: what the AI reads from linear may end up in the published review.',
      'review',
    ])
    expect(h.fetched).toEqual([`${HEAD} refs/phada/pull/12`])
    expect(h.prompts[0]?.data).toContain('src/api.ts:3 in buy: return spend(id, 1)')
    expect(toolNames(h.prompts[0])).toEqual([
      'read_file',
      'grep',
      'list',
      'history',
      'find_symbol',
      'callers',
      'dependencies',
      'similar',
    ])
    expect(h.servers).toEqual([true])
    expect(h.closed()).toBe(1)
    expect(result.outcome.status).toBe('reviewed')
    expect(result.impact).toMatchObject({
      status: 'used',
      index: { files: 5, extracted: 3 },
      totals: { symbols: 1, callers: 1, files: 1 },
    })
    expect(result.investigation).toMatchObject({ status: 'used', totals: { calls: 1 } })
    expect(result.investigation.floor).toEqual({
      expected: 3,
      shortfalls: [
        expect.stringMatching(/^Investigated 1 time for a .+ diff \(expected at least 3\)\.$/),
      ],
    })
  })

  it('leaves out of the graph what the base config ignores, whatever the head config says', async () => {
    const h = setup({ contextSources: sources('ignore: ["src/api.ts"]\n') })

    const result = await reviewPullRequest(input, h.deps)

    expect(result.impact.status).toBe('used')
    expect(result.impact.totals).toEqual({ symbols: 1, callers: 0, files: 0 })
  })

  it('reviews without the graph when the index is not ready in time and says how to finish it', async () => {
    let clock = 0
    const h = setup({
      now: () => {
        clock += 61_000
        return clock
      },
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toContain(
      'warning: Index of acme/shop is not ready (1 of 3 files): reviewing without the repository graph. Run phada index acme/shop, or the next review continues it.',
    )
    expect(result.impact).toMatchObject({
      status: 'unavailable',
      reason: 'index of acme/shop is not ready (1 of 3 files)',
    })
    expect(h.prompts[0]?.data).not.toContain('PHADA_IMPACT')
    expect(toolNames(h.prompts[0])).toEqual(['read_file', 'grep', 'list', 'history'])
  })

  it('reviews without the graph when the index cannot be opened', async () => {
    const h = setup({
      openIndexStore: () => Promise.reject(new IndexStoreError('Cannot write the index at /x')),
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toContain(
      'warning: Cannot write the index at /x: reviewing without the repository graph.',
    )
    expect(result.impact).toMatchObject({
      status: 'unavailable',
      reason: 'Cannot write the index at /x',
    })
    expect(toolNames(h.prompts[0])).toEqual(['read_file', 'grep', 'list', 'history'])
  })

  it('reviews without the graph when SQLite fails in an unexpected way, and closes the stores', async () => {
    let observedClosed = 0
    const h = setup({
      openIndexStore: async () => {
        const store = await openIndexStore(freshPath('index'))
        store.reader = () => {
          throw new Error('disk I/O error')
        }
        return store
      },
      openObservedStore: async () => {
        const store = await openObservedStore(freshPath('observed'))
        const close = store.close.bind(store)
        store.close = () => {
          observedClosed += 1
          close()
        }
        return store
      },
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toContain(
      'warning: Could not use the repository graph (disk I/O error): reviewing without it.',
    )
    expect(result.impact).toMatchObject({ status: 'unavailable', reason: 'disk I/O error' })
    expect(toolNames(h.prompts[0])).toEqual(['read_file', 'grep', 'list', 'history'])
    expect(observedClosed).toBe(1)
    expect(result.outcome.status).toBe('reviewed')
  })

  it('says when what earlier reviews learned could not be read and starts over', async () => {
    const h = setup({
      openObservedStore: async () => {
        const store = await openObservedStore(freshPath('observed'))
        return new Proxy(store, {
          get(target, property) {
            if (property === 'rebuilt') return true
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      },
    })

    await reviewPullRequest(input, h.deps)

    expect(h.events).toContain(
      'warning: What earlier reviews of acme/shop learned could not be read: starting over.',
    )
  })

  it('keeps only the most recent commits in the index after indexing a head', async () => {
    let pruned: number[] = []
    const h = setup({
      openIndexStore: async () => {
        const store = await openIndexStore(freshPath('index'))
        const prune = store.prune.bind(store)
        store.prune = (keep) => {
          pruned = [...pruned, keep]
          return prune(keep)
        }
        return store
      },
    })

    await reviewPullRequest(input, h.deps)

    expect(pruned).toEqual([10])
  })

  it("reviews without tools or the user's servers when the head cannot be fetched", async () => {
    const h = setup({
      openMirror: () =>
        Promise.reject(new CheckoutUnavailableError('git-missing', 'git was not found')),
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(h.events).toEqual([
      'context',
      'warning: git was not found: reviewing without investigation.',
      'impact unavailable',
      'review',
    ])
    expect(h.prompts[0]?.tools).toBeUndefined()
    expect(h.servers).toEqual([false])
    expect(result.investigation).toMatchObject({
      status: 'unavailable',
      reason: 'git was not found',
    })
    expect(result.impact).toMatchObject({ status: 'unavailable', reason: 'git was not found' })
  })

  it('opens neither the mirror nor the index when investigation is off', async () => {
    let opened = 0
    const h = setup({
      openMirror: async () => {
        opened += 1
        return fakeMirror(() => {})
      },
    })

    const result = await reviewPullRequest(
      { ...input, options: { investigate: false, verify: false } },
      h.deps,
    )

    expect(opened).toBe(0)
    expect(result.impact.status).toBe('off')
    expect(h.events).toContain('impact off')
  })

  it('learns an observed edge from a confirmed finding that cites a file the AI read', async () => {
    const finding = findingFixture({
      file: 'src/shop.ts',
      line: 3,
      confidence: 95,
      sources: ['src/routes.ts'],
    })
    const h = setup({}, [
      { text: reviewReportJson({ findings: [finding] }), durationMs: 10 },
      {
        text: verificationJson([verdictFixture({ id: 1, reason: 'The route calls it by name' })]),
        durationMs: 5,
      },
    ])

    const result = await reviewPullRequest({ ...input, options: { verify: true } }, h.deps)

    expect(result.impact.learned).toEqual([
      { from: 'src/shop.ts spend', to: 'src/routes.ts', pullRequest: 12 },
    ])
    expect((await h.observedEdges()).map((edge) => edge.to.path)).toEqual(['src/routes.ts'])
  })

  it('learns nothing from a file of the diff that a tool only listed', async () => {
    const diff = [
      pullRequestFixture().diff,
      'diff --git a/src/routes.ts b/src/routes.ts',
      '--- a/src/routes.ts',
      '+++ b/src/routes.ts',
      '@@ -1 +1 @@',
      "-export const routes = { buy: 'buy' }",
      "+export const routes = { buy: 'spend' }",
      '',
    ].join('\n')
    const finding = findingFixture({
      file: 'src/shop.ts',
      line: 3,
      confidence: 95,
      sources: ['src/routes.ts'],
    })
    const outputs: ReviewOutput[] = [
      { text: reviewReportJson({ findings: [finding] }), durationMs: 10 },
      {
        text: verificationJson([verdictFixture({ id: 1, reason: 'The route calls it by name' })]),
        durationMs: 5,
      },
    ]
    let calls = 0
    const h = setup({
      createProvider: () => ({
        id: 'fake',
        review: async (prompt) => {
          calls += 1
          if (calls === 1) await prompt.tools?.call('find_symbol', { name: 'routes' })
          return outputs[calls - 1] ?? OUTPUT
        },
      }),
    })

    const result = await reviewPullRequest(
      { ...input, pullRequest: pullRequestFixture({ diff }), options: { verify: true } },
      h.deps,
    )

    expect(result.investigation.calls).toMatchObject([{ tool: 'find_symbol', inSources: true }])
    expect(result.impact.learned).toEqual([])
    expect(await h.observedEdges()).toEqual([])
  })

  it('keeps the review when what it learned cannot be saved', async () => {
    const finding = findingFixture({
      file: 'src/shop.ts',
      line: 3,
      confidence: 95,
      sources: ['src/routes.ts'],
    })
    const h = setup(
      {
        openObservedStore: async () => {
          const store = await openObservedStore(freshPath('observed'))
          store.add = () => {
            throw new Error('database is locked')
          }
          return store
        },
      },
      [
        { text: reviewReportJson({ findings: [finding] }), durationMs: 10 },
        {
          text: verificationJson([verdictFixture({ id: 1, reason: 'The route calls it by name' })]),
          durationMs: 5,
        },
      ],
    )

    const result = await reviewPullRequest({ ...input, options: { verify: true } }, h.deps)

    expect(result.outcome.status).toBe('reviewed')
    expect(result.impact.learned).toEqual([])
    expect(h.events).toContain(
      'warning: Could not save what this review learned (database is locked).',
    )
  })

  it('keeps learned edges whose ends the pull request head does not have', async () => {
    const path = freshPath('observed')
    const seeded = await openObservedStore(path)
    seeded.add([
      {
        from: { path: 'src/removed-by-this-pull-request.ts' },
        to: { path: 'src/routes.ts' },
        pullRequest: 3,
        commit: 'c'.repeat(40),
      },
    ])
    seeded.close()
    const h = setup({ openObservedStore: () => openObservedStore(path) })

    await reviewPullRequest(input, h.deps)

    const reopened = await openObservedStore(path)
    expect(reopened.all()).toHaveLength(1)
    reopened.close()
  })

  it('closes the checkout when the provider cannot be created', async () => {
    const h = setup()
    h.deps.createProvider = () => {
      throw new Error('no provider')
    }

    await expect(reviewPullRequest(input, h.deps)).rejects.toThrow('no provider')
    expect(h.closed()).toBe(1)
  })

  it('names the review and the verification passes for whoever watches the provider', async () => {
    const passes: string[] = []
    const h = setup()
    h.deps.watchProvider = (provider, pass) => {
      passes.push(pass)
      return provider
    }

    await reviewPullRequest({ ...input, options: { investigate: false, verify: false } }, h.deps)

    expect(passes).toEqual(['review', 'verify'])
  })
})

describe('reviewPullRequest with related repositories', () => {
  const WEB = {
    'package.json': '{ "name": "web", "dependencies": { "shop": "^1" } }\n',
    'src/web.ts': "import { spend } from 'shop'\nexport const paid = spend('u1', 2)\n",
  }
  const info = (repo: string, fields: Partial<RepositoryInfo> = {}): RepositoryInfo => ({
    repo,
    private: false,
    defaultBranch: 'main',
    empty: false,
    ...fields,
  })

  function relatedDeps(
    infos: Record<string, RepositoryInfo>,
    read: string[] = [],
    stores: { closed: boolean }[] = [],
  ): RelatedDeps {
    return {
      readRepository: async (repo) => {
        read.push(repo)
        const found = infos[repo]
        if (found === undefined) throw new Error(`Cannot read ${repo}`)
        return found
      },
      openRelated: (repo) => ({
        openMirror: async () => memoryMirror(repo === 'acme/web' ? WEB : { 'README.md': '# x\n' }),
        openIndexStore: async () => {
          const store = await openIndexStore(freshPath('related'))
          const tracked = { closed: false }
          stores.push(tracked)
          const close = store.close.bind(store)
          store.close = () => {
            tracked.closed = true
            close()
          }
          return store
        },
      }),
      extractor,
      now: () => 0,
      events: { warning: () => {}, indexing: () => {}, indexed: () => {} },
    }
  }

  it('follows the change into a consumer and lets the AI read it', async () => {
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web, acme/admin]'),
      related: relatedDeps({ 'acme/web': info('acme/web'), 'acme/admin': info('acme/admin') }),
    })

    const result = await reviewPullRequest(input, h.deps)

    const data = h.prompts[0]?.data ?? ''
    expect(data).toContain("acme/web:src/web.ts:2: export const paid = spend('u1', 2)")
    expect(data).toContain('acme/web at ccccccc — uses the changed code at 1 place')
    expect(data).toContain('acme/admin at ccccccc — no package link (read tools only)')
    expect(
      h.prompts[0]?.tools?.definitions.find((tool) => tool.name === 'read_file')?.inputSchema,
    ).toMatchObject({
      properties: { repo: { enum: ['acme/web', 'acme/admin'] } },
    })
    expect(result.related).toMatchObject({
      status: 'used',
      repositories: [
        { repo: 'acme/web', state: 'consumers', count: 1, packages: ['shop'], graph: true },
        { repo: 'acme/admin', state: 'unlinked', packages: [], graph: false },
      ],
    })
  })

  it('reads related repositories without indexing them when the head has no graph', async () => {
    const stores: { closed: boolean }[] = []
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: relatedDeps({ 'acme/web': info('acme/web') }, [], stores),
      openIndexStore: async () => {
        throw new IndexStoreError('Cannot open the index: read-only file system')
      },
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(stores).toEqual([])
    expect(h.prompts[0]?.data).toContain(
      'acme/web at ccccccc — linked by package, no relation to this change (read tools only)',
    )
    expect(result.related.repositories).toEqual([
      expect.objectContaining({ repo: 'acme/web', state: 'linked', graph: false }),
    ])
  })

  it('keeps the review when the files of the head cannot be listed for the related repositories', async () => {
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: relatedDeps({ 'acme/web': info('acme/web') }),
      openMirror: async () => {
        const mirror = fakeMirror(() => {})
        let calls = 0
        const listFiles = mirror.listFiles.bind(mirror)
        mirror.listFiles = async (sha) => {
          calls += 1
          if (calls > 1)
            throw new CheckoutUnavailableError(
              'fetch-failed',
              'Could not list the files of abc1234',
            )
          return listFiles(sha)
        }
        return mirror
      },
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(result.outcome.status).toBe('reviewed')
    expect(result.related).toEqual({
      status: 'unavailable',
      reason: 'Could not list the files of abc1234',
      repositories: [],
    })
    expect(h.events).toContain(
      'warning: Could not list the files of abc1234: reviewing without related repositories.',
    )
  })

  it('closes the related repositories when the provider fails', async () => {
    const stores: { closed: boolean }[] = []
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: relatedDeps({ 'acme/web': info('acme/web') }, [], stores),
      createProvider: () => ({
        id: 'fake',
        review: async () => {
          throw new Error('the AI CLI crashed')
        },
      }),
    })

    await expect(reviewPullRequest(input, h.deps)).rejects.toThrow('the AI CLI crashed')
    expect(stores).toEqual([{ closed: true }])
  })

  it('keeps seven consumers and leaves the eighth out of the impact too', async () => {
    const names = Array.from({ length: 8 }, (_, index) => `acme/web${index}`)
    const deps = relatedDeps(Object.fromEntries(names.map((name) => [name, info(name)])))
    const h = setup({
      contextSources: sources(`context:\n  repos: [${names.join(', ')}]`),
      related: { ...deps, openRelated: (repo) => ({ ...deps.openRelated('acme/web'), repo }) },
    })

    const result = await reviewPullRequest(input, h.deps)

    const data = h.prompts[0]?.data ?? ''
    expect(data).toContain('acme/web6 at')
    expect(data).not.toContain('acme/web7')
    expect(result.related.repositories.at(-1)).toMatchObject({
      repo: 'acme/web7',
      state: 'skipped',
      reason: 'limit',
    })
  })

  it('says there was nothing to review when the diff is empty', async () => {
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: relatedDeps({ 'acme/web': info('acme/web') }),
    })

    const result = await reviewPullRequest(
      { ...input, pullRequest: pullRequestFixture({ diff: '' }) },
      h.deps,
    )

    expect(result.related).toEqual({
      status: 'unavailable',
      reason: 'nothing to review',
      repositories: [],
    })
  })

  it('reads no related repository without investigation, and says when none is declared', async () => {
    const read: string[] = []
    const off = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: relatedDeps({ 'acme/web': info('acme/web') }, read),
    })

    const result = await reviewPullRequest(
      { ...input, options: { verify: false, investigate: false } },
      off.deps,
    )
    const none = await reviewPullRequest(input, setup({ related: relatedDeps({}) }).deps)

    expect(read).toEqual([])
    expect(result.related).toEqual({ status: 'off', repositories: [] })
    expect(none.related).toEqual({ status: 'none', repositories: [] })
  })

  it('keeps a private repository out of a public pull request even if the repository allows it', async () => {
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]\n  privateOnPublic: true'),
      related: relatedDeps({ 'acme/web': info('acme/web', { private: true }) }),
    })

    const result = await reviewPullRequest(input, h.deps)

    expect(result.related.repositories).toEqual([
      expect.objectContaining({ repo: 'acme/web', state: 'skipped', reason: 'private-on-public' }),
    ])
    expect(h.prompts[0]?.data).not.toContain('PHADA_RELATED')
  })

  it('never learns an edge from a source in another repository', async () => {
    const finding = findingFixture({
      file: 'src/shop.ts',
      line: 3,
      confidence: 95,
      sources: ['acme/web:src/web.ts:2'],
    })
    const outputs: ReviewOutput[] = [
      { text: reviewReportJson({ findings: [finding] }), durationMs: 10 },
      {
        text: verificationJson([verdictFixture({ id: 1, reason: 'The web app pays twice' })]),
        durationMs: 5,
      },
    ]
    let calls = 0
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: relatedDeps({ 'acme/web': info('acme/web') }),
      createProvider: () => ({
        id: 'fake',
        review: async (prompt) => {
          calls += 1
          if (calls === 1)
            await prompt.tools?.call('read_file', { repo: 'acme/web', path: 'src/web.ts' })
          return outputs[calls - 1] ?? OUTPUT
        },
      }),
    })

    const result = await reviewPullRequest({ ...input, options: { verify: true } }, h.deps)

    const reviewed = result.outcome.status === 'reviewed' ? result.outcome.result : undefined
    expect(reviewed?.findings[0]?.sources).toEqual(['acme/web:src/web.ts:2'])
    expect(result.impact.learned).toEqual([])
    expect(await h.observedEdges()).toEqual([])
  })
})

describe('reviewPullRequest with skills', () => {
  it('plans the passes before opening the mirror and runs one review per skill', async () => {
    const h = setup({}, [OUTPUT, OUTPUT])

    const result = await reviewPullRequest(
      { ...input, options: { verify: false, skills: ['phada', 'code-review'] } },
      h.deps,
    )

    expect(h.events.indexOf('passes phada,code-review')).toBeLessThan(h.events.indexOf('review'))
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]?.instructions).toContain('Review guide (skill code-review):\nFind bugs.')
    expect(result.passes?.map(({ skill, status }) => [skill, status])).toEqual([
      ['phada', 'planned'],
      ['code-review', 'planned'],
    ])
  })

  it('stops before the mirror and the AI when a skill the user asked for is missing', async () => {
    let opened = 0
    const h = setup({
      openMirror: async () => {
        opened += 1
        return fakeMirror(() => {})
      },
    })

    await expect(
      reviewPullRequest({ ...input, options: { verify: false, skills: ['nope'] } }, h.deps),
    ).rejects.toThrow(SkillError)
    expect(opened).toBe(0)
    expect(h.prompts).toHaveLength(0)
  })

  it('reviews as before without skills or a prompt', async () => {
    const h = setup()

    const result = await reviewPullRequest(input, h.deps)

    expect(result.passes).toBeUndefined()
    expect(h.events.some((event) => event.startsWith('passes'))).toBe(false)
  })
})

describe('reviewPullRequest with native skills', () => {
  function nativeSetup(
    overrides: Partial<PullRequestReviewDeps> = {},
    outputs: ReviewOutput[] = [OUTPUT],
  ) {
    const opened: { input: NativeRunnerInput; deps: NativeRunnerDeps }[] = []
    const ran: string[] = []
    let closed = 0
    const h = setup(
      {
        runsSkills: true,
        readGitHub: async () => ({}),
        env: { PATH: '/usr/bin' },
        resolveDir: async (path) => path,
        openNativeRunner: async (runnerInput, runnerDeps) => {
          opened.push({ input: runnerInput, deps: runnerDeps })
          return {
            runSkill: async (pass) => {
              ran.push(pass.skill)
              return { text: 'Found an issue.', captured: [], durationMs: 3, blocked: [] }
            },
            close: async () => {
              closed += 1
            },
          }
        },
        ...overrides,
      },
      outputs,
    )
    return { ...h, opened, ran, runnerClosed: () => closed }
  }

  it('runs the skill natively and converts its output', async () => {
    const h = nativeSetup()

    const result = await reviewPullRequest(
      { ...input, viewer: 'me', options: { verify: false, skills: ['code-review'] } },
      h.deps,
    )

    expect(h.ran).toEqual(['code-review'])
    expect(h.opened[0]?.input.viewer).toBe('me')
    expect(h.opened[0]?.input.nativeSkills.get('code-review')).toMatchObject({ kind: 'file' })
    expect(h.prompts[0]?.instructions).toContain('code review guide code-review')
    expect(h.prompts[0]?.tools).toBeUndefined()
    expect(h.runnerClosed()).toBe(1)
    expect(result.passes?.[0]?.mode).toBe('native')
  })

  it('opens the mirror for a native skill even without investigation', async () => {
    const h = nativeSetup()

    await reviewPullRequest(
      { ...input, options: { verify: false, investigate: false, skills: ['code-review'] } },
      h.deps,
    )

    expect(h.opened).toHaveLength(1)
  })

  it('fails when the mirror is unavailable for a native skill', async () => {
    const h = nativeSetup({
      openMirror: async () => {
        throw new CheckoutUnavailableError('no-access', 'Could not fetch acme/shop')
      },
    })

    await expect(
      reviewPullRequest({ ...input, options: { verify: false, skills: ['code-review'] } }, h.deps),
    ).rejects.toThrow('Could not fetch acme/shop')
  })

  it('closes the runner when the review fails', async () => {
    const h = nativeSetup({}, [{ ...OUTPUT, text: 'x' }])
    h.deps.createProvider = () => ({
      id: 'fake',
      review: () => Promise.reject(new ProviderError('fake', 'timeout', 'too slow')),
    })

    await expect(
      reviewPullRequest({ ...input, options: { verify: false, skills: ['code-review'] } }, h.deps),
    ).rejects.toThrow('too slow')
    expect(h.runnerClosed()).toBe(1)
  })

  it('opens no runner without a native pass', async () => {
    const h = nativeSetup({ runsSkills: false })

    await reviewPullRequest(
      { ...input, options: { verify: false, skills: ['code-review'] } },
      h.deps,
    )

    expect(h.opened).toHaveLength(0)
  })
})

describe('reviewPullRequest with MCP servers', () => {
  const tickets: DeclaredMcpServer = {
    name: 'tickets',
    transport: { kind: 'stdio', command: 'tickets-mcp', args: [], env: {} },
    description: 'Ticket cited in the title',
  }
  const docs: DeclaredMcpServer = {
    name: 'docs',
    transport: { kind: 'http', url: 'https://docs/mcp', headers: {} },
  }

  function fakeConnection(name: string, closed: string[]): McpConnection {
    return {
      name,
      tools: [
        {
          name: 'get_ticket',
          description: 'Read',
          inputSchema: { type: 'object' },
          readOnly: true,
        },
        {
          name: 'create_ticket',
          description: 'Write',
          inputSchema: { type: 'object' },
          readOnly: false,
        },
      ],
      call: async () => ({ text: 'TICKET ABC-1', isError: false }),
      close: async () => {
        closed.push(name)
      },
    }
  }

  const withMcp = { ...input, mcp: { names: [{ name: 'linear' }], declared: [tickets, docs] } }

  it('connects declared servers, offers their read-only tools and reports every server', async () => {
    const closed: string[] = []
    const connected: string[] = []
    const h = setup({
      connectMcp: async (server) => {
        connected.push(server.name)
        if (server.name === 'docs') {
          throw new McpConnectError('docs', 'MCP server docs refused the credentials (HTTP 401).')
        }
        return fakeConnection(server.name, closed)
      },
    })

    const result = await reviewPullRequest(withMcp, h.deps)

    expect(connected).toEqual(['tickets', 'docs'])
    expect(toolNames(h.prompts[0])).toContain('tickets__get_ticket')
    expect(toolNames(h.prompts[0])).not.toContain('tickets__create_ticket')
    expect(h.prompts[0]?.tools?.mcpServers).toEqual([
      { name: 'linear' },
      { name: 'tickets', description: 'Ticket cited in the title', prefix: 'tickets__' },
    ])
    expect(h.events).toContain(
      'warning: MCP server docs refused the credentials (HTTP 401). Reviewing without it.',
    )
    expect(h.events).toContain(
      'warning: acme/shop is public: what the AI reads from linear, tickets may end up in the published review.',
    )
    expect(result.investigation.mcp).toEqual([
      { server: 'linear', via: 'cli', status: 'connected', tools: [], hidden: [] },
      {
        server: 'tickets',
        via: 'phada',
        status: 'connected',
        tools: ['get_ticket'],
        hidden: ['create_ticket'],
      },
      {
        server: 'docs',
        via: 'phada',
        status: 'failed',
        tools: [],
        hidden: [],
        reason: 'MCP server docs refused the credentials (HTTP 401).',
      },
    ])
    expect(closed).toEqual(['tickets'])
  })

  it('reviews a pull request from an outside author without any MCP server', async () => {
    const connected: string[] = []
    const h = setup({
      connectMcp: async (server) => {
        connected.push(server.name)
        return fakeConnection(server.name, [])
      },
    })

    const result = await reviewPullRequest(
      { ...withMcp, pullRequest: pullRequestFixture({ association: 'CONTRIBUTOR' }) },
      h.deps,
    )

    expect(connected).toEqual([])
    expect(h.servers).toEqual([false])
    expect(h.prompts[0]?.tools?.mcpServers).toBeUndefined()
    expect(h.events).toContain(
      'warning: acme/shop#12 is from an outside author: reviewing without your MCP servers.',
    )
    expect(h.events.some((event) => event.includes('is public'))).toBe(false)
    expect(result.investigation.mcp?.map(({ server, status }) => [server, status])).toEqual([
      ['linear', 'off'],
      ['tickets', 'off'],
      ['docs', 'off'],
    ])
  })

  it('uses the MCP servers on a private repository whatever the author', async () => {
    const h = setup({ connectMcp: async (server) => fakeConnection(server.name, []) })

    await reviewPullRequest(
      {
        ...withMcp,
        pullRequest: pullRequestFixture({ association: 'CONTRIBUTOR', private: true }),
      },
      h.deps,
    )

    expect(h.servers).toEqual([true])
    expect(toolNames(h.prompts[0])).toContain('tickets__get_ticket')
  })

  it('connects nothing without the investigation', async () => {
    const connected: string[] = []
    const h = setup({
      connectMcp: async (server) => {
        connected.push(server.name)
        return fakeConnection(server.name, [])
      },
    })

    const result = await reviewPullRequest(
      { ...withMcp, options: { verify: false, investigate: false } },
      h.deps,
    )

    expect(connected).toEqual([])
    expect(h.servers).toEqual([false])
    expect(result.investigation.mcp).toBeUndefined()
  })

  it('closes the MCP servers when the review fails', async () => {
    const closed: string[] = []
    const h = setup({ connectMcp: async (server) => fakeConnection(server.name, closed) })
    h.deps.createProvider = () => ({
      id: 'broken',
      review: async () => {
        throw new Error('provider down')
      },
    })

    await expect(reviewPullRequest(withMcp, h.deps)).rejects.toThrow('provider down')
    expect(closed).toEqual(['tickets', 'docs'])
  })
})

describe('reviewPullRequest with a signal', () => {
  function cancelling() {
    const controller = new AbortController()
    return { signal: controller.signal, cancel: () => controller.abort() }
  }

  it('stops after the context, before the mirror and the AI', async () => {
    const { signal, cancel } = cancelling()
    let mirrors = 0
    const h = setup({
      openMirror: async () => {
        mirrors += 1
        return fakeMirror(() => {})
      },
    })
    h.deps.events.contextLoaded = cancel

    await expect(reviewPullRequest({ ...input, signal }, h.deps)).rejects.toBeInstanceOf(
      ReviewCancelledError,
    )
    expect(mirrors).toBe(0)
    expect(h.prompts).toEqual([])
  })

  it('stops the fetch of the head and closes nothing it did not open', async () => {
    const { signal, cancel } = cancelling()
    const seen: (AbortSignal | undefined)[] = []
    const h = setup({
      openMirror: async () => {
        const mirror = fakeMirror(() => {})
        const fetch = mirror.fetch.bind(mirror)
        mirror.fetch = async (ref, keepAs, options) => {
          seen.push(options?.signal)
          cancel()
          return fetch(ref, keepAs, options)
        }
        return mirror
      },
    })

    await expect(reviewPullRequest({ ...input, signal }, h.deps)).rejects.toBeInstanceOf(
      ReviewCancelledError,
    )
    expect(seen).toEqual([signal])
    expect(h.events).not.toContain('impact used')
    expect(h.prompts).toEqual([])
  })

  it('stops the index of the head without a warning, and the next review finishes the index', async () => {
    const { signal, cancel } = cancelling()
    const path = freshPath('index')
    let closedStores = 0
    const h = setup({
      openIndexStore: async () => {
        const store = await openIndexStore(path)
        const close = store.close.bind(store)
        store.close = () => {
          closedStores += 1
          close()
        }
        return store
      },
    })
    h.deps.events.indexed = cancel

    await expect(reviewPullRequest({ ...input, signal }, h.deps)).rejects.toBeInstanceOf(
      ReviewCancelledError,
    )
    expect(h.events.filter((event) => event.startsWith('warning'))).toEqual([])
    expect(h.prompts).toEqual([])
    expect(h.closed()).toBe(1)
    expect(closedStores).toBe(1)

    const next = setup({ openIndexStore: () => openIndexStore(path) })
    const result = await reviewPullRequest(input, next.deps)
    expect(result.impact).toMatchObject({ status: 'used', index: { files: 5 } })
  })

  it('stops after the related repositories and closes them', async () => {
    const { signal, cancel } = cancelling()
    const closedRelated: string[] = []
    const h = setup({
      contextSources: sources('context:\n  repos: [acme/web]'),
      related: {
        readRepository: async (repo) => {
          cancel()
          return { repo, private: false, defaultBranch: 'main', empty: false }
        },
        openRelated: () => ({
          openMirror: async () => {
            const mirror = memoryMirror({ 'README.md': '# x\n' })
            const checkout = mirror.checkout.bind(mirror)
            mirror.checkout = (sha, options) => {
              const opened = checkout(sha, options)
              return {
                ...opened,
                close: async () => {
                  closedRelated.push('acme/web')
                  await opened.close()
                },
              }
            }
            return mirror
          },
          openIndexStore: () => openIndexStore(freshPath('related')),
        }),
        extractor,
        now: () => 0,
        events: { warning: () => {}, indexing: () => {}, indexed: () => {} },
      },
    })

    await expect(reviewPullRequest({ ...input, signal }, h.deps)).rejects.toBeInstanceOf(
      ReviewCancelledError,
    )
    expect(h.prompts).toEqual([])
    expect(closedRelated).toEqual(['acme/web'])
    expect(h.events.filter((event) => event.startsWith('warning'))).toEqual([])
  })
})
