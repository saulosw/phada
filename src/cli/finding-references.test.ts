import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { findingReferences } from './finding-references.js'
import { messagesFor } from './i18n/messages.js'

describe('findingReferences', () => {
  it('names the skill that found the finding', () => {
    const finding = findingFixture({ skill: 'code-review', rule: 'orm-only', sources: ['a.md'] })

    expect(findingReferences(finding, messagesFor('en'))).toBe(
      'Based on: `a.md` · rule `orm-only` · skill `code-review`',
    )
    expect(findingReferences(finding, messagesFor('pt-BR'))).toBe(
      'Com base em: `a.md` · regra `orm-only` · skill `code-review`',
    )
  })

  it('names nothing without a skill', () => {
    expect(findingReferences(findingFixture(), messagesFor('en'))).toBe('')
  })
})
