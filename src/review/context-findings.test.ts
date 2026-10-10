import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { reviewContextFixture } from '../../test/support/review-context.js'
import { MAX_SOURCES, withKnownReferences, withRuleSeverity } from './context-findings.js'

const DIFF_PATHS = ['src/shop.ts']

describe('withKnownReferences', () => {
  it('keeps a rule the context has and sources the review tool sent', () => {
    const finding = findingFixture({
      rule: 'orm-only',
      sources: ['docs/conventions.md', 'src/shop.ts:12', 'src/shop.ts:3-8', '.phada/config.yml'],
    })

    expect(withKnownReferences([finding], reviewContextFixture(), DIFF_PATHS)).toEqual([finding])
  })

  it('drops an unknown rule and sources the review tool never sent', () => {
    const finding = findingFixture({
      rule: 'made-up',
      sources: ['docs/other.md', 'src/db.ts:4', 'https://example.com', 'src/shop.ts'],
    })

    expect(withKnownReferences([finding], reviewContextFixture(), DIFF_PATHS)).toEqual([
      findingFixture({ sources: ['src/shop.ts'] }),
    ])
  })

  it(`keeps at most ${MAX_SOURCES} sources`, () => {
    const sources = Array.from({ length: 8 }, (_unused, index) => `src/shop.ts:${index + 1}`)

    const [finding] = withKnownReferences([findingFixture({ sources })], undefined, DIFF_PATHS)

    expect(finding?.sources).toEqual(sources.slice(0, MAX_SOURCES))
  })

  it('accepts diff files as sources without any context', () => {
    const finding = findingFixture({ rule: 'orm-only', sources: ['src/shop.ts:2'] })

    expect(withKnownReferences([finding], undefined, DIFF_PATHS)).toEqual([
      findingFixture({ sources: ['src/shop.ts:2'] }),
    ])
  })
})

describe('withRuleSeverity', () => {
  it('raises a finding to the severity of the rule it breaks', () => {
    const findings = [
      findingFixture({ rule: 'orm-only', severity: 'P2', title: 'raised' }),
      findingFixture({ rule: 'orm-only', severity: 'P0', title: 'kept' }),
      findingFixture({ severity: 'P2', title: 'no rule' }),
    ]

    expect(
      withRuleSeverity(findings, reviewContextFixture()).map(({ title, severity }) => [
        title,
        severity,
      ]),
    ).toEqual([
      ['raised', 'P1'],
      ['kept', 'P0'],
      ['no rule', 'P2'],
    ])
  })

  it('leaves findings alone for a rule without a severity', () => {
    const context = reviewContextFixture({
      rules: [{ key: 'tests', text: 'Add tests.', scope: ['**'], origin: '.phada/rules.md' }],
    })
    const finding = findingFixture({ rule: 'tests', severity: 'P2' })

    expect(withRuleSeverity([finding], context)).toEqual([finding])
  })
})
