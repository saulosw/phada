import { describe, expect, it } from 'vitest'
import { contextReportFixture } from '../../test/support/context-report.js'
import { formatRulesJson, formatRulesText } from './format-rules.js'
import type { RulesView } from './format-rules.js'

const PULL: RulesView = {
  pullRequest: { owner: 'acme', repo: 'api', number: 7, baseSha: 'abc1234def' },
  repository: { owner: 'acme', repo: 'api', ref: 'abc1234def' },
}
const REPO: RulesView = {
  pullRequest: null,
  repository: { owner: 'acme', repo: 'api', ref: 'main' },
}

describe('formatRulesText', () => {
  it('prints the context of a pull request with its ignored files and warnings', () => {
    const text = formatRulesText(PULL, contextReportFixture({ warnings: ['Ignoring x.'] }))

    expect(text).toBe(
      [
        'Context for acme/api#7 at abc1234',
        '',
        'Config files:',
        '- .phada/config.yml (repository)',
        '',
        'Rules:',
        '- orm-only (.phada/config.yml, **/*.py)',
        '- no-console (.phada/config.yml, disabled)',
        '- py-only (.phada/config.yml, **/*.py, out of scope)',
        '',
        'Docs:',
        '- docs/conventions.md (4.1 KB)',
        '- README.md (24.4 KB, truncated)',
        '- docs/guide.md (29.3 KB, omitted: budget)',
        '',
        'Ignored files:',
        '- package-lock.json',
        '',
        'Warnings:',
        '- Ignoring x.',
        '',
      ].join('\n'),
    )
  })

  it('prints the ignore patterns of a repository and says when there is nothing', () => {
    const text = formatRulesText(
      REPO,
      contextReportFixture({ configFiles: [], rules: [], docs: [], ignored: [] }),
      ['**/go.sum', 'dist/**'],
    )

    expect(text).toBe(
      [
        'Context for acme/api at main',
        '',
        'No config files, rules or docs.',
        '',
        'Ignore patterns:',
        '- **/go.sum',
        '- dist/**',
        '',
      ].join('\n'),
    )
  })
})

describe('formatRulesJson', () => {
  it('prints the target and the context block with schemaVersion 1', () => {
    const json = JSON.parse(formatRulesJson(REPO, contextReportFixture(), ['dist/**']))

    expect(json).toMatchObject({
      schemaVersion: 1,
      pullRequest: null,
      repository: { owner: 'acme', repo: 'api', ref: 'main' },
      ignore: ['dist/**'],
    })
    expect(json.context.rules[0]).toEqual(
      expect.objectContaining({ key: 'orm-only', scope: ['**/*.py'] }),
    )
    expect(JSON.parse(formatRulesJson(PULL, contextReportFixture())).ignore).toBeNull()
  })
})
