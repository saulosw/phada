import { describe, expect, it } from 'vitest'
import { openFixtureStore } from '../../test/support/index-fixture.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import type { MemoryMirror } from '../../test/support/memory-mirror.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { RepositoryPackages } from '../graph/packages.js'
import { createExtractor } from '../repo-map/extract.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import type { IndexStore } from '../store/index-store.js'
import { RELATED_REF } from '../store/index-store.js'
import { openRelatedRepositories, RELATED_INDEX_BUDGET_MS } from './related-repositories.js'
import type { RelatedDeps } from './related-repositories.js'

const extractor = createExtractor()
const CORE: RepositoryPackages = {
  published: [{ ecosystem: 'npm', name: '@acme/core' }],
  depends: [],
}
const consumer = (name: string) => ({
  'package.json': JSON.stringify({ name, dependencies: { '@acme/core': '^1' } }),
  'src/page.ts': "import { getUser } from '@acme/core'\nexport const user = getUser('1')\n",
})

interface Setup {
  infos: Record<string, RepositoryInfo | 'no-access' | Error>
  mirrors: Record<string, MemoryMirror>
  now?: (stores: readonly IndexStore[]) => number
}

function setup({ infos, mirrors, now }: Setup) {
  const warnings: string[] = []
  const stores: IndexStore[] = []
  const deps: RelatedDeps = {
    readRepository: async (repo) => {
      const found = infos[repo]
      if (found === undefined || found instanceof Error) throw found ?? new Error('unknown')
      return found
    },
    openRelated: (repo) => ({
      openMirror: async () => {
        const mirror = mirrors[repo]
        if (mirror === undefined) throw new Error(`no mirror for ${repo}`)
        return mirror
      },
      openIndexStore: async () => {
        const store = await openFixtureStore()
        stores.push(store)
        return store
      },
    }),
    extractor,
    now: () => now?.(stores) ?? 0,
    events: { warning: (message) => warnings.push(message), indexing: () => {}, indexed: () => {} },
  }
  return { deps, warnings, stores }
}

const info = (repo: string, fields: Partial<RepositoryInfo> = {}): RepositoryInfo => ({
  repo,
  private: false,
  defaultBranch: 'main',
  empty: false,
  ...fields,
})
const input = (repos: string[]) => ({
  declared: repos.map((repo) => ({ repo, origin: '.phada/config.yml' })),
  reviewed: 'acme/core',
  pullRequestPrivate: false,
  privateOnPublic: false,
  reviewedPackages: CORE,
  index: true,
})

describe('openRelatedRepositories', () => {
  it('fetches each default branch in parallel, links it by package and indexes it', async () => {
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const wait = async () => {
      started += 1
      if (started === 2) release()
      await gate
    }
    const web = memoryMirror(consumer('web'), { fetch: wait })
    const admin = memoryMirror({ 'README.md': '# admin\n' }, { fetch: wait })
    const { deps, warnings } = setup({
      infos: {
        'acme/web': info('acme/web', { defaultBranch: 'trunk' }),
        'acme/admin': info('acme/admin'),
      },
      mirrors: { 'acme/web': web, 'acme/admin': admin },
    })

    const { opened, skipped } = await openRelatedRepositories(
      input(['acme/web', 'acme/admin']),
      deps,
    )

    expect(web.fetched).toEqual([{ ref: 'refs/heads/trunk', keepAs: RELATED_REF }])
    expect(
      opened.map((item) => [
        item.repo,
        item.order,
        item.link.consumedByRelated.length,
        item.graph !== undefined,
      ]),
    ).toEqual([
      ['acme/web', 0, 1, true],
      ['acme/admin', 1, 0, false],
    ])
    expect(opened[0]?.graph?.findSymbol('user').map((symbol) => symbol.path)).toEqual([
      'src/page.ts',
    ])
    expect(skipped).toEqual([])
    expect(warnings).toEqual([])
  })

  it('keeps the others when one cannot be read or fetched, and says what to do', async () => {
    const broken = memoryMirror(
      {},
      {
        fetch: async () => {
          throw new CheckoutUnavailableError(
            'fetch-failed',
            'Could not fetch main from acme/broken: denied',
          )
        },
      },
    )
    const { deps, warnings } = setup({
      infos: {
        'acme/web': info('acme/web'),
        'acme/broken': info('acme/broken'),
        'acme/gone': 'no-access',
        'acme/down': new Error('GitHub responded with HTTP 502'),
      },
      mirrors: { 'acme/web': memoryMirror(consumer('web')), 'acme/broken': broken },
    })

    const { opened, skipped } = await openRelatedRepositories(
      input(['acme/gone', 'acme/down', 'acme/broken', 'acme/web']),
      deps,
    )

    expect(opened.map((item) => item.repo)).toEqual(['acme/web'])
    expect(skipped.map((item) => `${item.repo} ${item.reason}`)).toEqual([
      'acme/gone no-access',
      'acme/down fetch-failed',
      'acme/broken fetch-failed',
    ])
    expect(warnings).toEqual([
      'Could not read acme/down (GitHub responded with HTTP 502): reviewing without it.',
      'Cannot read acme/gone with this token: reviewing without it.',
      'Could not fetch main from acme/broken: denied: run phada index acme/broken to prepare it.',
    ])
  })

  it('calls a fetch the remote refuses no access, and warns about an empty repository', async () => {
    const refused = memoryMirror(
      {},
      {
        fetch: async () => {
          throw new CheckoutUnavailableError(
            'no-access',
            'Could not fetch main from acme/hidden: remote: Repository not found.',
          )
        },
      },
    )
    const { deps, warnings } = setup({
      infos: {
        'acme/hidden': info('acme/hidden'),
        'acme/empty': info('acme/empty', { empty: true }),
      },
      mirrors: { 'acme/hidden': refused },
    })

    const { skipped } = await openRelatedRepositories(input(['acme/hidden', 'acme/empty']), deps)

    expect(skipped.map((item) => `${item.repo} ${item.reason}`)).toEqual([
      'acme/empty empty',
      'acme/hidden no-access',
    ])
    expect(warnings).toEqual([
      'acme/empty has no commits: reviewing without it.',
      'Could not fetch main from acme/hidden: remote: Repository not found.: reviewing without it.',
    ])
  })

  it('reads linked repositories without indexing them when asked to', async () => {
    const { deps, stores } = setup({
      infos: { 'acme/web': info('acme/web') },
      mirrors: { 'acme/web': memoryMirror(consumer('web')) },
    })

    const { opened } = await openRelatedRepositories({ ...input(['acme/web']), index: false }, deps)

    expect(
      opened.map((item) => [item.repo, item.link.consumedByRelated.length, item.graph]),
    ).toEqual([['acme/web', 1, undefined]])
    expect(stores).toEqual([])
  })

  it('warns about a private repository for a public pull request', async () => {
    const { deps, warnings } = setup({
      infos: { 'acme/secret': info('acme/secret', { private: true }) },
      mirrors: {},
    })

    const { skipped } = await openRelatedRepositories(input(['acme/secret']), deps)

    expect(skipped.map((item) => item.reason)).toEqual(['private-on-public'])
    expect(warnings).toEqual([
      'acme/secret is private and acme/core is public: allow it in your own config with context.privateOnPublic.',
    ])
  })

  it('shares one indexing budget among the linked repositories', async () => {
    const twoFiles = (name: string) => ({
      ...consumer(name),
      'src/more.ts': `export const more = '${name}'\n`,
    })
    const { deps, warnings } = setup({
      infos: { 'acme/a': info('acme/a'), 'acme/b': info('acme/b') },
      mirrors: { 'acme/a': memoryMirror(twoFiles('a')), 'acme/b': memoryMirror(twoFiles('b')) },
      now: (stores) => (stores.length >= 2 ? 2 * RELATED_INDEX_BUDGET_MS : 0),
    })

    const { opened } = await openRelatedRepositories(input(['acme/a', 'acme/b']), deps)

    expect(opened.map((item) => item.graph !== undefined)).toEqual([true, false])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(
      /^Index of acme\/b is not ready \(1 of 2 files\): reading it without its graph\. Run phada index acme\/b, or the next review continues it\.$/,
    )
  })

  it('never reads the .phada folder of a related repository', async () => {
    const { deps } = setup({
      infos: { 'acme/web': info('acme/web') },
      mirrors: {
        'acme/web': memoryMirror({ ...consumer('web'), '.phada/config.yml': 'ignore: ["src/**"]' }),
      },
    })

    const { opened } = await openRelatedRepositories(input(['acme/web']), deps)

    expect(opened[0]?.graph?.findSymbol('user')).toHaveLength(1)
  })

  it('closes the stores it opened', async () => {
    const { deps, stores } = setup({
      infos: { 'acme/web': info('acme/web') },
      mirrors: { 'acme/web': memoryMirror(consumer('web')) },
    })

    const { opened } = await openRelatedRepositories(input(['acme/web']), deps)
    await Promise.all(opened.map((item) => item.close()))

    expect(() => stores[0]?.reader('x').paths()).toThrow()
  })
})
