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
      index: { files: 4, extracted: 3 },
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
