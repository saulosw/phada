import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import type { ContextSources } from '../context/types.js'
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
import type { RelatedDeps } from './related-repositories.js'
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
  const servers: (readonly string[])[] = []
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
    createProvider: (userMcpServers) => {
      servers.push(userMcpServers)
      return provider
    },
    events: {
      contextLoaded: () => events.push('context'),
      warning: (message) => events.push(`warning: ${message}`),
      indexing: (total) => events.push(`indexing ${total}`),
      indexed: () => {},
      impactReady: (report) => events.push(`impact ${report.status}`),
      relatedReady: () => {},
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
  userMcpServers: ['linear'],
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
    expect(h.servers).toEqual([['linear']])
    expect(h.closed()).toBe(1)
    expect(result.outcome.status).toBe('reviewed')
    expect(result.impact).toMatchObject({
      status: 'used',
      index: { files: 5, extracted: 3 },
      totals: { symbols: 1, callers: 1, files: 1 },
    })
    expect(result.investigation).toMatchObject({ status: 'used', totals: { calls: 1 } })
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
    expect(h.servers).toEqual([[]])
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
