import { describe, expect, it } from 'vitest'
import { indexFixture } from '../../test/support/index-fixture.js'
import { openRepositoryGraph } from './repository-graph.js'
import { nameTokens, scoreSimilar } from './similar.js'
import type { Features } from './similar.js'

function features(overrides: Partial<Features>): Features {
  return {
    kind: 'function',
    calls: new Set(),
    parameters: 1,
    nameTokens: new Set(),
    ...overrides,
  }
}

describe('scoreSimilar', () => {
  it('scores high when the functions call the same things with the same parameters', () => {
    const target = features({
      calls: new Set(['validate', 'save']),
      nameTokens: nameTokens('handleOrder'),
    })
    const candidate = features({
      calls: new Set(['save', 'validate']),
      nameTokens: nameTokens('handlePayment'),
    })

    const { score, shared } = scoreSimilar(target, candidate)

    expect(score).toBeGreaterThanOrEqual(0.7)
    expect(shared).toEqual(['save', 'validate'])
  })

  it('scores zero when nothing matches', () => {
    expect(
      scoreSimilar(
        features({
          calls: new Set(['a']),
          parameters: 1,
          nameTokens: nameTokens('one'),
          ownerKind: 'class',
        }),
        features({ calls: new Set(['b']), parameters: 3, nameTokens: nameTokens('two') }),
      ).score,
    ).toBe(0)
  })

  it('splits camelCase and snake_case names into lowercase tokens', () => {
    expect([...nameTokens('getUserById')]).toEqual(['get', 'user', 'by', 'id'])
    expect([...nameTokens('get_order_by_id')]).toEqual(['get', 'order', 'by', 'id'])
    expect([...nameTokens('HTTPServer')]).toEqual(['http', 'server'])
  })
})

describe('graph.similar', () => {
  it('returns the functions built like the target, best first, never the target itself', async () => {
    const { reader, readText } = await indexFixture({
      'src/lib.ts':
        'export function validate(x: unknown) {}\nexport function save(x: unknown) {}\nexport function log(x: unknown) {}\n',
      'src/orders.ts': `import { validate, save, log } from './lib'
export function handleOrder(input: unknown) {
  validate(input)
  save(input)
}
export function handleUser(input: unknown) {
  validate(input)
  save(input)
  log(input)
}
export function handlePayment(input: unknown) {
  validate(input)
  save(input)
}
export function render(a: unknown, b: unknown) {
  log(a)
}
`,
    })
    const graph = await openRepositoryGraph({ reader, readText })

    const result = graph.similar({ name: 'handleOrder' })

    expect(
      result.similar.map(({ symbol, shared }) => `${symbol.name} ${shared.join(',')}`),
    ).toEqual(['handlePayment save,validate', 'handleUser save,validate'])
    expect(result.similar.every(({ score }) => score >= 0.3)).toBe(true)
  })
})

describe('graph.callers with a very common name', () => {
  it('stops at the candidate limit, says so and answers quickly', async () => {
    const files: Record<string, string> = { 'src/api.ts': 'export function get() {}\n' }
    for (let file = 0; file < 50; file += 1) {
      const calls = Array.from({ length: 50 }, () => '  get()').join('\n')
      files[`src/use${file}.ts`] =
        `import { get } from './api'\nexport function f${file}() {\n${calls}\n}\n`
    }
    const { reader, readText } = await indexFixture(files)
    const graph = await openRepositoryGraph({ reader, readText })

    const started = performance.now()
    const result = graph.callers({ name: 'get', path: 'src/api.ts' })

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result.capped).toBe(true)
    expect(result.sites.length).toBe(2_000)
  })
})
