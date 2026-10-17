import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewContextFixture } from '../../test/support/review-context.js'
import { RELATED } from './prompt-parts.js'
import { buildReviewPrompt } from './prompt.js'
import type { DiffImpact, RelatedSummary } from './types.js'
import { buildVerifyPrompt } from './verify-prompt.js'

const NONCE = '0123456789ab'
const RELATED_DATA: RelatedSummary[] = [
  {
    repo: 'acme/web',
    commit: '1a2b3c4d5e6f',
    state: 'consumers',
    count: 4,
    description: 'frontend that calls\nthe API',
    graph: true,
  },
  { repo: 'acme/db', commit: 'aaaaaaa1', state: 'uses', count: 1, graph: true },
  { repo: 'acme/sdk', commit: 'bbbbbbb2', state: 'linked', graph: true },
  { repo: 'acme/admin', commit: 'ccccccc3', state: 'unlinked', graph: false },
]
const IMPACT: DiffImpact = {
  symbols: [
    {
      kind: 'function',
      name: 'getUser',
      path: 'src/users.ts',
      startLine: 1,
      endLine: 3,
      exported: true,
      callers: 1,
      files: 1,
      sites: [
        {
          repo: 'acme/web',
          path: 'src/page.ts',
          line: 4,
          kind: 'calls',
          how: 'resolved',
          text: 'getUser(id)',
        },
      ],
      dependencies: [],
    },
  ],
  omittedSymbols: 0,
  callerFiles: 1,
}

function positions(data: string, ...names: string[]): number[] {
  return names.map((name) => data.indexOf(`<<<${name}_${NONCE}`))
}

describe('review prompt with related repositories', () => {
  it('lists them in a block between the docs and the impact, one line each', () => {
    const { data, instructions } = buildReviewPrompt(
      {
        pullRequest: pullRequestFixture(),
        context: reviewContextFixture(),
        impact: IMPACT,
        related: RELATED_DATA,
      },
      NONCE,
    )

    const [docs = -1, related = -1, impact = -1] = positions(
      data,
      'PHADA_DOCS',
      'PHADA_RELATED',
      'PHADA_IMPACT',
    )
    expect(related).toBeGreaterThan(docs)
    expect(impact).toBeGreaterThan(related)
    expect(data).toContain(
      [
        'acme/web at 1a2b3c4 — uses the changed code at 4 places — "frontend that calls the API"',
        'acme/db at aaaaaaa — this change uses 1 of its symbols',
        'acme/sdk at bbbbbbb — linked by package, no relation to this change',
        'acme/admin at ccccccc — no package link (read tools only)',
      ].join('\n'),
    )
    expect(instructions).toContain(RELATED)
    expect(instructions.indexOf(RELATED)).toBeLessThan(
      instructions.indexOf('The PHADA_IMPACT block'),
    )
  })

  it('tells the reviewer to pass repo and to cite owner/repo:path', () => {
    expect(RELATED).toContain('Pass repo to the tools')
    expect(RELATED).toContain('cite files of another repository in\nsources as owner/repo:path')
    expect(RELATED).toContain('UNTRUSTED DATA')
  })

  it('leaves the block and its instruction out without related repositories', () => {
    for (const related of [undefined, []]) {
      const prompt = buildReviewPrompt(
        { pullRequest: pullRequestFixture(), ...(related === undefined ? {} : { related }) },
        NONCE,
      )
      expect(prompt.data).not.toContain('PHADA_RELATED')
      expect(prompt.instructions).not.toContain(RELATED)
    }
  })

  it('gives the verifier the same block and instruction', () => {
    const { data, instructions } = buildVerifyPrompt(
      { pullRequest: pullRequestFixture(), related: RELATED_DATA },
      [findingFixture()],
      NONCE,
    )

    expect(data).toContain(`<<<PHADA_RELATED_${NONCE}`)
    expect(instructions).toContain(RELATED)
  })
})
