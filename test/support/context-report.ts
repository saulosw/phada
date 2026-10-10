import type { ContextReport } from '../../src/context/types.js'

export function contextReportFixture(overrides: Partial<ContextReport> = {}): ContextReport {
  return {
    configFiles: [{ path: '.phada/config.yml', origin: 'repository', status: 'loaded' }],
    rules: [
      { key: 'orm-only', origin: '.phada/config.yml', status: 'applied' },
      { key: 'no-console', origin: '.phada/config.yml', status: 'disabled' },
      { key: 'py-only', origin: '.phada/config.yml', status: 'out-of-scope' },
    ],
    docs: [
      {
        path: 'docs/conventions.md',
        origin: 'repository',
        category: 'declared',
        bytes: 4200,
        status: 'included',
      },
      {
        path: 'README.md',
        origin: 'repository',
        category: 'contributing',
        bytes: 25_000,
        status: 'truncated',
      },
      {
        path: 'docs/guide.md',
        origin: 'repository',
        category: 'other',
        bytes: 30_000,
        status: 'omitted',
        reason: 'budget',
      },
    ],
    ignored: ['package-lock.json'],
    budget: { limit: 60_000, used: 24_199 },
    warnings: [],
    ...overrides,
  }
}
