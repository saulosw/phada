import { describe, expect, it } from 'vitest'
import type { RelatedReport } from '../app/related-report.js'
import { formatRelatedLine, formatRelatedSection } from './format-related.js'

const USED: RelatedReport = {
  status: 'used',
  repositories: [
    {
      repo: 'acme/web',
      origin: '.phada/config.yml',
      commit: '1a2b3c4d5e',
      state: 'consumers',
      count: 4,
      packages: ['@acme/core'],
      graph: true,
      description: 'Web app',
    },
    {
      repo: 'acme/db',
      origin: 'user:config.yml',
      commit: 'ddddddd1',
      state: 'uses',
      count: 1,
      packages: ['@acme/db'],
      graph: true,
    },
    {
      repo: 'acme/sdk',
      origin: '.phada/config.yml',
      commit: 'eeeeeee2',
      state: 'linked',
      packages: ['@acme/core'],
      graph: false,
    },
    {
      repo: 'acme/admin',
      origin: '.phada/config.yml',
      commit: 'fffffff3',
      state: 'unlinked',
      packages: [],
      graph: false,
    },
    {
      repo: 'acme/secret',
      origin: '.phada/config.yml',
      state: 'skipped',
      packages: [],
      graph: false,
      reason: 'private-on-public',
    },
    {
      repo: 'acme/x\u001b[2J',
      origin: '.phada/config.yml',
      state: 'skipped',
      packages: [],
      graph: false,
      reason: 'limit',
    },
    {
      repo: 'acme/y',
      origin: '.phada/config.yml',
      state: 'skipped',
      packages: [],
      graph: false,
      reason: 'candidate-limit',
    },
  ],
}

describe('formatRelatedLine', () => {
  it('names each related repository with what it has to do with the change', () => {
    expect(formatRelatedLine(USED)).toBe(
      'Related: acme/web (consumer, 4 call sites) · acme/db (publisher, 1 symbol used) · acme/sdk (linked, read tools only) · acme/admin (no link) · acme/secret skipped (private, PR is public) · acme/x[2J skipped (over the limit of 7) · acme/y skipped (over the 20 fetched at most)',
    )
  })

  it('says when related repositories are off or unavailable, and nothing when none is declared', () => {
    expect(formatRelatedLine({ status: 'off', repositories: [] })).toBe(
      'Related: off (investigation disabled)',
    )
    expect(
      formatRelatedLine({ status: 'unavailable', reason: 'git was not found', repositories: [] }),
    ).toBe('Related: unavailable (git was not found)')
    expect(formatRelatedLine({ status: 'none', repositories: [] })).toBeUndefined()
  })
})

describe('formatRelatedSection', () => {
  it('lists origin, commit, packages and reasons in the dry run', () => {
    expect(formatRelatedSection(USED)).toBe(
      [
        '## Related repositories',
        '',
        '- acme/web at 1a2b3c4 (from .phada/config.yml): consumer, 4 call sites · packages: @acme/core · "Web app"',
        '- acme/db at ddddddd (from user:config.yml): publisher, 1 symbol used · packages: @acme/db',
        '- acme/sdk at eeeeeee (from .phada/config.yml): linked, read tools only · packages: @acme/core',
        '- acme/admin at fffffff (from .phada/config.yml): no link',
        '- acme/secret (from .phada/config.yml): skipped, private, PR is public',
        '- acme/x[2J (from .phada/config.yml): skipped, over the limit of 7',
        '- acme/y (from .phada/config.yml): skipped, over the 20 fetched at most',
        '',
      ].join('\n'),
    )
  })
})
