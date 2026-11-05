import { describe, expect, it } from 'vitest'
import { indexFixture } from '../../test/support/index-fixture.js'
import { changedLines, computeImpact, IMPACT_SITES_PER_SYMBOL } from './impact.js'
import type { GraphSymbol, RepositoryGraph, Site } from './types.js'
import { openRepositoryGraph } from './repository-graph.js'

const FILES = {
  'src/users.ts': `import { query } from './db'
export class UserService {
  cache = new Map()
  load(id: string) {
    return query(id)
  }
}
export function getUser(id: string) {
  return query(id)
}
function helper() {
  return 1
}
`,
  'src/db.ts': 'export function query(id: string) {\n  return id\n}\n',
  'src/api.ts': `import { getUser } from './users'
export function a(id: string) {
  return getUser(id)
}
export function b(id: string) {
  return getUser(id) ?? getUser(id)
}
export function c(id: string) {
  getUser(id)
  getUser(id)
  getUser(id)
  return getUser(id)
}
`,
  'src/jobs.ts': `import { getUser } from './users'
export function run(id: string) {
  return getUser(id) ?? null
}
`,
}

async function graphOf(files: Record<string, string> = FILES) {
  const { reader, readText } = await indexFixture(files)
  return openRepositoryGraph({ reader, readText })
}

describe('changedLines', () => {
  it('takes the added lines and the line after each removal, keeps the added ones apart, and skips deleted files', () => {
    const diff = [
      'diff --git a/src/users.ts b/src/users.ts',
      '--- a/src/users.ts',
      '+++ b/src/users.ts',
      '@@ -8,3 +8,3 @@',
      ' export function getUser(id: string) {',
      '-  return query(id, 1)',
      '+  return query(id)',
      ' }',
      '@@ -12,2 +12,1 @@',
      ' function helper() {',
      '-  console.log(1)',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      '',
    ].join('\n')

    expect(changedLines(diff)).toEqual([{ path: 'src/users.ts', lines: [9, 13], added: [9] }])
  })
})

describe('computeImpact', () => {
  it('maps changed lines to the innermost symbol and a changed field to its class', async () => {
    const graph = await graphOf()

    const impact = await computeImpact(graph, [
      { path: 'src/users.ts', lines: [3, 5, 9], added: [] },
    ])

    expect(impact.symbols.map((symbol) => `${symbol.kind} ${symbol.name}`)).toEqual([
      'function getUser',
      'class UserService',
      'method load',
    ])
  })

  it('lists callers outside the change first, at most three per file, with the code of each line', async () => {
    const graph = await graphOf()

    const impact = await computeImpact(graph, [{ path: 'src/users.ts', lines: [9], added: [] }])
    const [getUser] = impact.symbols

    expect(impact.callerFiles).toBe(2)
    expect(getUser).toMatchObject({
      callers: 7,
      files: 2,
      path: 'src/users.ts',
      startLine: 8,
      endLine: 10,
    })
    expect(
      getUser?.sites.map((site) => `${site.path}:${site.line} ${site.in} ${site.text}`),
    ).toEqual([
      'src/api.ts:3 a return getUser(id)',
      'src/api.ts:6 b return getUser(id) ?? getUser(id)',
      'src/api.ts:9 c getUser(id)',
      'src/jobs.ts:3 run return getUser(id) ?? null',
    ])
    expect(getUser?.dependencies).toEqual([
      { name: 'query', path: 'src/db.ts', line: 1, kind: 'function' },
    ])
  })

  it('puts the symbols that have callers before the ones nobody calls', async () => {
    const graph = await graphOf()

    const impact = await computeImpact(graph, [{ path: 'src/users.ts', lines: [5, 9], added: [] }])

    expect(impact.symbols.map((symbol) => `${symbol.name} ${symbol.callers}`)).toEqual([
      'getUser 7',
      'load 0',
    ])
  })

  it('lists the callers it resolved before the ones it matched by name', async () => {
    const graph = await graphOf({
      'src/store.ts': 'export function save(id: string) {\n  return id\n}\n',
      'src/a.ts': 'export function viaName(repo: any) {\n  return repo.save(1)\n}\n',
      'src/z.ts':
        "import { save } from './store'\nexport function direct() {\n  return save('x')\n}\n",
    })

    const [save] = (await computeImpact(graph, [{ path: 'src/store.ts', lines: [2], added: [] }]))
      .symbols

    expect(save?.sites.map((site) => `${site.path} ${site.how}`)).toEqual([
      'src/z.ts resolved',
      'src/a.ts inferred',
    ])
  })

  it('lists callers in test files after the ones in the code', async () => {
    const graph = await graphOf({
      ...FILES,
      'src/__tests__/api.test.ts': "import { getUser } from '../users'\ngetUser('1')\n",
      'tests/users_test.ts': "import { getUser } from '../src/users'\ngetUser('2')\n",
    })

    const [getUser] = (
      await computeImpact(graph, [{ path: 'src/users.ts', lines: [9], added: [] }])
    ).symbols

    expect(getUser?.sites.map((site) => site.path)).toEqual([
      'src/api.ts',
      'src/api.ts',
      'src/api.ts',
      'src/jobs.ts',
      'src/__tests__/api.test.ts',
      'tests/users_test.ts',
    ])
  })

  it('marks a symbol whose callers search was cut short', async () => {
    const graph = await graphOf()
    const capped = new Proxy(graph, {
      get(target, property) {
        if (property === 'callers') {
          return (symbol: Parameters<typeof graph.callers>[0]) => ({
            ...target.callers(symbol),
            capped: true,
          })
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const [getUser] = (
      await computeImpact(capped, [{ path: 'src/users.ts', lines: [9], added: [] }])
    ).symbols

    expect(getUser?.capped).toBe(true)
  })

  it('leaves out call sites on the changed lines themselves', async () => {
    const graph = await graphOf()

    const [getUser] = (
      await computeImpact(graph, [
        { path: 'src/users.ts', lines: [9], added: [] },
        { path: 'src/jobs.ts', lines: [3], added: [] },
      ])
    ).symbols

    expect(getUser?.sites.map((site) => site.path)).not.toContain('src/jobs.ts')
  })

  it('keeps 20 symbols, exported ones first, and counts the rest', async () => {
    const functions = Array.from(
      { length: 25 },
      (_, index) => `${index < 5 ? 'export ' : ''}function f${index}() {\n  return ${index}\n}`,
    ).join('\n')
    const graph = await graphOf({ 'src/many.ts': `${functions}\n` })
    const lines = Array.from({ length: 25 }, (_, index) => index * 3 + 2)

    const impact = await computeImpact(graph, [{ path: 'src/many.ts', lines, added: [] }])

    expect(impact.symbols).toHaveLength(20)
    expect(impact.omittedSymbols).toBe(5)
    expect(impact.symbols.slice(0, 5).every((symbol) => symbol.exported)).toBe(true)
  })

  it('stops adding symbols when it runs out of time and counts the rest as left out', async () => {
    const graph = await graphOf()
    let clock = 0

    const impact = await computeImpact(
      graph,
      [{ path: 'src/users.ts', lines: [3, 5, 9], added: [] }],
      {
        now: () => {
          clock += 6_000
          return clock
        },
      },
    )

    expect(impact.symbols.length).toBeLessThan(3)
    expect(impact.symbols.length + impact.omittedSymbols).toBe(3)
  })

  it('leaves out a same-named method of another class matched by name and counts it as unresolved', async () => {
    const graph = await graphOf({
      'src/a.ts': 'export class Fixtures {\n  deleteTestData() {\n    return 1\n  }\n}\n',
      'src/b.ts': 'export class Orders {\n  deleteTestData() {\n    return 2\n  }\n}\n',
      'src/use.ts':
        'export function clean(orders: any) {\n  orders.deleteTestData()\n  return orders.deleteTestData()\n}\n',
    })

    const [method] = (await computeImpact(graph, [{ path: 'src/a.ts', lines: [3], added: [3] }]))
      .symbols

    expect(method).toMatchObject({ name: 'deleteTestData', callers: 0, files: 0, unresolved: 2 })
    expect(method?.sites).toEqual([])
  })

  it('keeps a caller matched by name when its receiver names the class of the changed method', async () => {
    const graph = await graphOf({
      'src/user-service.ts': 'export class UserService {\n  save() {\n    return 1\n  }\n}\n',
      'src/order-service.ts': 'export class OrderService {\n  save() {\n    return 2\n  }\n}\n',
      'src/handler.ts': [
        'export class Handler {',
        '  userService: any',
        '  user_service: any',
        '  run(userService: any, other: any) {',
        '    userService.save()',
        '    this.userService.save()',
        '    this.user_service?.save()',
        '    other.save()',
        '  }',
        '}',
        '',
      ].join('\n'),
    })

    const [save] = (
      await computeImpact(graph, [{ path: 'src/user-service.ts', lines: [3], added: [3] }])
    ).symbols

    expect(save?.sites.map((site) => `${site.line} ${site.how}`)).toEqual([
      '5 inferred',
      '6 inferred',
      '7 inferred',
    ])
    expect(save).toMatchObject({ callers: 3, unresolved: 1 })
  })

  it('puts the symbols that already existed before the new exported ones and those before the rest', async () => {
    const graph = await graphOf({
      'src/a.ts': [
        'function fresh() {',
        '  return 1',
        '}',
        'export function freshExported() {',
        '  return 2',
        '}',
        'function old() {',
        '  return 3',
        '}',
        '',
      ].join('\n'),
    })

    const impact = await computeImpact(graph, [
      { path: 'src/a.ts', lines: [1, 2, 3, 4, 5, 6, 8], added: [1, 2, 3, 4, 5, 6, 8] },
    ])

    expect(impact.symbols.map((symbol) => symbol.name)).toEqual(['old', 'freshExported', 'fresh'])
  })

  it('turns the same line of code in several files into one site with the count and the first places', async () => {
    const steps: Record<string, string> = {}
    for (let index = 0; index < 11; index += 1) {
      steps[`features/s${String(index).padStart(2, '0')}.steps.ts`] =
        `import { test } from '../src/fixtures'\nexport const steps = createBdd(test)\n`
    }
    const graph = await graphOf({
      'src/fixtures.ts': 'export const test = base.extend({\n  page: 1,\n})\n',
      'src/other.ts': "import { test } from './fixtures'\nexport const other = wrap(test)\n",
      ...steps,
    })

    const [test] = (
      await computeImpact(graph, [{ path: 'src/fixtures.ts', lines: [2], added: [2] }])
    ).symbols

    expect(test).toMatchObject({ callers: 12, files: 12 })
    expect(test?.sites).toHaveLength(2)
    expect(test?.sites[0]).toMatchObject({
      path: 'features/s00.steps.ts',
      line: 2,
      text: 'export const steps = createBdd(test)',
      repeated: {
        uses: 11,
        files: 11,
        also: [
          { path: 'features/s01.steps.ts', line: 2 },
          { path: 'features/s02.steps.ts', line: 2 },
        ],
      },
    })
    expect(test?.sites[1]).toMatchObject({ path: 'src/other.ts' })
    expect(test?.sites[1]?.repeated).toBeUndefined()
  })

  it('stops reading lines to group the same uses once it runs out of time', async () => {
    const steps: Record<string, string> = {}
    for (let index = 0; index < 11; index += 1) {
      steps[`features/s${String(index).padStart(2, '0')}.steps.ts`] =
        `import { test } from '../src/fixtures'\nexport const steps = createBdd(test)\n`
    }
    const graph = await graphOf({
      'src/fixtures.ts': 'export const test = base.extend({\n  page: 1,\n})\n',
      ...steps,
    })
    let clock = 0

    const [test] = (
      await computeImpact(graph, [{ path: 'src/fixtures.ts', lines: [2], added: [2] }], {
        now: () => {
          clock += 6_000
          return clock
        },
      })
    ).symbols

    expect(test).toMatchObject({ callers: 11 })
    expect(test?.sites.some((site) => site.repeated !== undefined)).toBe(false)
  })

  it('lists existing code similar to the new functions of a pull request that creates code', async () => {
    const pay = [
      "import { fetchJson, retry } from '../http'",
      'export function chargeCard(card: string, amount: number) {',
      '  const answer = fetchJson(card, amount)',
      '  return retry(answer)',
      '}',
      '',
    ].join('\n')
    const files = {
      'src/http.ts':
        'export function fetchJson(a: string, b: number) {\n  return a\n}\nexport function retry(a: string) {\n  return a\n}\n',
      'src/billing/pay.ts': [
        "import { fetchJson, retry } from '../http'",
        'export function charge(card: string, amount: number) {',
        '  return retry(fetchJson(card, amount))',
        '}',
        '',
      ].join('\n'),
      'src/new/pay.ts': pay,
      'src/new/refund.ts': pay.replace('chargeCard', 'refundCard'),
    }
    const graph = await graphOf(files)
    const created = [
      { path: 'src/new/pay.ts', lines: [1, 2, 3, 4, 5], added: [1, 2, 3, 4, 5] },
      { path: 'src/new/refund.ts', lines: [1, 2, 3, 4, 5], added: [1, 2, 3, 4, 5] },
    ]

    const impact = await computeImpact(graph, created, { createsCode: true })
    const fix = await computeImpact(graph, [{ path: 'src/billing/pay.ts', lines: [3], added: [3] }])
    const notCreating = await computeImpact(graph, created, { createsCode: false })

    expect(impact.similar?.find((item) => item.symbol.name === 'chargeCard')).toEqual({
      symbol: {
        kind: 'function',
        name: 'chargeCard',
        path: 'src/new/pay.ts',
        startLine: 2,
        endLine: 5,
      },
      like: [
        {
          kind: 'function',
          name: 'charge',
          path: 'src/billing/pay.ts',
          startLine: 2,
          endLine: 4,
          score: expect.any(Number),
          shared: ['fetchJson', 'retry'],
        },
      ],
    })
    expect(fix.similar).toBeUndefined()
    expect(notCreating.similar).toBeUndefined()
  })

  it('returns nothing when no indexed symbol changed', async () => {
    const graph = await graphOf()

    expect(await computeImpact(graph, [{ path: 'README.md', lines: [1], added: [] }])).toEqual({
      symbols: [],
      omittedSymbols: 0,
      callerFiles: 0,
    })
  })
})

describe('computeImpact across repositories', () => {
  function withConsumers(graph: RepositoryGraph, extra: (symbol: GraphSymbol) => Site | Site[]) {
    return new Proxy(graph, {
      get(target, property) {
        if (property === 'callers') {
          return (wanted: Parameters<typeof graph.callers>[0]) => {
            const found = target.callers(wanted)
            return {
              ...found,
              sites: [...found.sites, ...found.symbols.flatMap(extra)],
            }
          }
        }
        if (property === 'lineText') {
          return async (path: string, line: number, repo?: string) =>
            repo === undefined ? target.lineText(path, line) : `${repo} ${path} ${line}`
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  const consumer =
    (repo: string, path: string, line: number) =>
    (symbol: GraphSymbol): Site => ({
      repo,
      path,
      line,
      target: symbol,
      kind: 'calls',
      how: 'resolved',
    })

  it('keeps a consumer site on a path and line the diff changes in the reviewed repository', async () => {
    const graph = withConsumers(await graphOf(), consumer('acme/web', 'src/jobs.ts', 3))

    const [getUser] = (
      await computeImpact(graph, [
        { path: 'src/users.ts', lines: [9], added: [] },
        { path: 'src/jobs.ts', lines: [3], added: [] },
      ])
    ).symbols

    expect(getUser?.sites.map((site) => `${site.repo ?? '.'}:${site.path}:${site.line}`)).toEqual(
      expect.arrayContaining(['acme/web:src/jobs.ts:3']),
    )
    expect(getUser?.sites.find((site) => site.repo === 'acme/web')?.text).toBe(
      'acme/web src/jobs.ts 3',
    )
  })

  it('counts files per repository and keeps three sites per file of each', async () => {
    const graph = withConsumers(await graphOf(), (symbol) =>
      [3, 6, 7, 10].map((line) => consumer('acme/web', 'src/api.ts', line)(symbol)),
    )

    const [getUser] = (
      await computeImpact(graph, [{ path: 'src/users.ts', lines: [9], added: [] }])
    ).symbols

    expect(getUser?.files).toBe(3)
    expect(getUser?.sites.filter((site) => site.repo === 'acme/web')).toHaveLength(3)
    expect(getUser?.related).toEqual([{ repo: 'acme/web', callers: 4, uses: 0 }])
    expect(
      getUser?.sites.filter((site) => site.repo === undefined && site.path === 'src/api.ts'),
    ).toHaveLength(3)
  })

  it('keeps at least one site of every consumer repository within the cap', async () => {
    const many: Record<string, string> = { ...FILES }
    for (let index = 0; index < 40; index += 1) {
      many[`src/use${index}.ts`] =
        `import { getUser } from './users'\nexport const v${index} = getUser('${index}')\n`
    }
    const graph = withConsumers(await graphOf(many), consumer('zzz/last', 'src/z.ts', 1))

    const [getUser] = (
      await computeImpact(graph, [{ path: 'src/users.ts', lines: [9], added: [] }])
    ).symbols

    expect(getUser?.sites.length).toBe(IMPACT_SITES_PER_SYMBOL)
    expect(getUser?.sites[0]?.repo).toBe('zzz/last')
  })
})
