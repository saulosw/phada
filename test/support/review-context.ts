import type { ReviewContext } from '../../src/review/types.js'

export function reviewContextFixture(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    rules: [
      {
        key: 'orm-only',
        text: 'Use the ORM; never raw SQL.',
        scope: ['**/*.ts'],
        severity: 'P1',
        origin: '.phada/config.yml',
      },
    ],
    docs: [{ path: 'docs/conventions.md', content: '# Conventions\n\nLog with request.log.' }],
    ignored: [],
    ...overrides,
  }
}
