import { describe, expect, it } from 'vitest'
import { contextReportFixture } from '../../test/support/context-report.js'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { Conversation } from '../publish/types.js'
import type { Ci } from '../context/types.js'
import type { RecheckReport, ReviewResult } from '../review/types.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './format-json.js'

const PULL_REQUEST = {
  repo: 'acme/shop',
  number: 12,
  url: 'https://github.com/acme/shop/pull/12',
  title: 'Let users spend crystals',
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  state: 'open',
  draft: false,
}

const RESULT: ReviewResult = {
  target: { repo: 'acme/shop', number: 12, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
  providerId: 'codex-cli',
  model: 'gpt-6-astra',
  additionalModels: ['gpt-6-mini'],
  durationMs: 16_400,
  usage: { inputTokens: 9700, outputTokens: 417 },
  passUsage: [
    { pass: 'review', usage: { inputTokens: 9000, outputTokens: 400 } },
    { pass: 'verify', usage: { inputTokens: 700, outputTokens: 17 } },
  ],
  summary: 'Adds a spend endpoint.',
  files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
  findings: [findingFixture({ severity: 'P0', confidence: 95, line: 3 })],
  worthChecking: [findingFixture({ severity: 'P2', confidence: 60, line: 5, fix: null })],
  worthCheckingOmitted: 2,
  minConfidence: 75,
  score: { value: 1, reason: '1 P0 finding (shop.ts:3)' },
  dropped: { invalid: 0, belowFloor: 1, outsideDiff: 2, duplicate: 0, rejected: 0 },
  claims: [],
}

function parse(output: string): unknown {
  return JSON.parse(output)
}

describe('formatReviewJson', () => {
  it('prints the suggestion of a finding and the suggestion counts', () => {
    const suggestion = { startLine: 3, endLine: 3, original: 'a', replacement: 'b' }
    const output = formatReviewJson(pullRequestFixture(), {
      status: 'reviewed',
      result: {
        ...RESULT,
        findings: [findingFixture({ line: 3, suggestion })],
        suggestions: { valid: 1, invalid: 2, dropped: 0 },
      },
    })

    expect(parse(output)).toMatchObject({
      review: {
        findings: [{ suggestion }],
        suggestions: { valid: 1, invalid: 2, dropped: 0 },
      },
    })
  })

  it('prints the whole review as JSON with a schema version', () => {
    const output = formatReviewJson(pullRequestFixture(), { status: 'reviewed', result: RESULT })

    expect(output.endsWith('}\n')).toBe(true)
    expect(parse(output)).toEqual({
      schemaVersion: 1,
      status: 'reviewed',
      verdict: 'blocking',
      pullRequest: PULL_REQUEST,
      review: {
        score: { value: 1, reason: '1 P0 finding (shop.ts:3)' },
        summary: 'Adds a spend endpoint.',
        claims: [],
        files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
        findings: [
          {
            ...findingFixture({ severity: 'P0', confidence: 95, line: 3 }),
            rule: null,
            sources: [],
            reason: null,
            suggestion: null,
            skill: 'phada',
            scope: 'change',
            closeToCut: false,
          },
        ],
        debt: [],
        worthChecking: [
          {
            ...findingFixture({ severity: 'P2', confidence: 60, line: 5, fix: null }),
            rule: null,
            sources: [],
            reason: null,
            suggestion: null,
            skill: 'phada',
            scope: 'change',
            closeToCut: false,
          },
        ],
        worthCheckingOmitted: 2,
        minConfidence: 75,
        dropped: { invalid: 0, belowFloor: 1, outsideDiff: 2, duplicate: 0, rejected: 0, debt: 0 },
        suggestions: null,
        verification: null,
        provider: { id: 'codex-cli', model: 'gpt-6-astra', additionalModels: ['gpt-6-mini'] },
        durationMs: 16_400,
        usage: { inputTokens: 9700, cachedInputTokens: null, outputTokens: 417 },
        passes: null,
        skillBodies: null,
      },
      publication: null,
      context: null,
      conversation: null,
      ci: null,
      investigation: null,
      impact: null,
      related: null,
      recheck: null,
      usage: {
        passes: [
          {
            pass: 'review',
            skill: null,
            usage: { inputTokens: 9000, cachedInputTokens: null, outputTokens: 400 },
          },
          {
            pass: 'verify',
            skill: null,
            usage: { inputTokens: 700, cachedInputTokens: null, outputTokens: 17 },
          },
        ],
        total: { inputTokens: 9700, cachedInputTokens: null, outputTokens: 417 },
      },
    })
  })

  it('prints the scope of each finding, the repository debt and the debt dropped', () => {
    const debt = findingFixture({ line: 12, title: 'balance has no caller', scope: 'repository' })
    const output = formatReviewJson(pullRequestFixture(), {
      status: 'reviewed',
      result: {
        ...RESULT,
        findings: [findingFixture({ line: 3, scope: 'repository' })],
        debt: [debt],
        dropped: { ...RESULT.dropped, debt: 2 },
      },
    })

    expect(parse(output)).toMatchObject({
      review: {
        findings: [{ line: 3, scope: 'repository' }],
        debt: [{ line: 12, title: 'balance has no caller', scope: 'repository', skill: 'phada' }],
        dropped: { debt: 2 },
      },
    })
  })

  it('says which findings are close to the confidence cut', () => {
    const output = formatReviewJson(pullRequestFixture(), {
      status: 'reviewed',
      result: {
        ...RESULT,
        findings: [findingFixture({ line: 3, confidence: 80, closeToCut: true })],
      },
    })

    expect(parse(output)).toMatchObject({
      review: {
        findings: [{ line: 3, closeToCut: true }],
        worthChecking: [{ line: 5, closeToCut: false }],
      },
    })
  })

  it('prints the claims of the description with their verdict and evidence', () => {
    const claims = [
      { claim: 'Prevents two runs on staging', verdict: 'contradicted', evidence: 'ci.yml:4' },
      { claim: 'Covers the empty cart', verdict: 'unverified', evidence: '' },
    ] as const
    const output = formatReviewJson(pullRequestFixture(), {
      status: 'reviewed',
      result: { ...RESULT, claims: [...claims] },
    })

    expect(parse(output)).toMatchObject({ review: { claims } })
  })

  it('prints the skill of each finding and every pass', () => {
    const result: ReviewResult = {
      ...RESULT,
      findings: [findingFixture({ skill: 'code-review' })],
      passes: [
        {
          skill: 'code-review',
          origin: '/s/SKILL.md',
          status: 'reviewed',
          durationMs: 5,
          usage: { inputTokens: 1, outputTokens: 2 },
          findings: 1,
        },
        {
          skill: 'sec',
          origin: '/s/sec.md',
          status: 'skipped',
          durationMs: 0,
          findings: 0,
          reason: 'no changed file matches x',
        },
      ],
    }

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: {
        findings: [{ skill: 'code-review' }],
        passes: [
          {
            skill: 'code-review',
            origin: '/s/SKILL.md',
            status: 'reviewed',
            durationMs: 5,
            usage: { inputTokens: 1, outputTokens: 2 },
            findings: 1,
            reason: null,
          },
          { skill: 'sec', status: 'skipped', usage: null, reason: 'no changed file matches x' },
        ],
      },
    })
  })

  it('prints the rule and the sources of a finding', () => {
    const finding = findingFixture({ rule: 'orm-only', sources: ['docs/a.md', 'src/shop.ts:3'] })
    const result: ReviewResult = { ...RESULT, findings: [finding] }

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: { findings: [{ rule: 'orm-only', sources: ['docs/a.md', 'src/shop.ts:3'] }] },
    })
  })

  it('prints the context sent to the AI', () => {
    const context = contextReportFixture({ warnings: ['Ignoring .phada/config.yml at b1b2c3d: x'] })

    const output = parse(
      formatReviewJson(pullRequestFixture(), { status: 'reviewed', result: RESULT }, null, context),
    )

    expect(output).toMatchObject({ context })
  })

  it('prints the scope and severity of rules and the scope of docs only when there is one', () => {
    const context = contextReportFixture({
      rules: [
        { key: 'a', origin: 'x', scope: ['src/**'], severity: 'P1', status: 'applied' },
        { key: 'b', origin: 'x', scope: ['**'], status: 'applied' },
      ],
      docs: [
        {
          path: '.cursor/rules/a.mdc',
          origin: 'repository',
          category: 'agents',
          bytes: 10,
          status: 'omitted',
          reason: 'out-of-scope',
          scope: ['lib/**'],
        },
        {
          path: 'README.md',
          origin: 'repository',
          category: 'contributing',
          bytes: 5,
          status: 'included',
        },
      ],
    })

    const output = parse(
      formatReviewJson(pullRequestFixture(), { status: 'reviewed', result: RESULT }, null, context),
    ) as { context: { rules: unknown[]; docs: unknown[] } }

    expect(output.context.rules).toEqual([
      { key: 'a', origin: 'x', scope: ['src/**'], severity: 'P1', status: 'applied' },
      { key: 'b', origin: 'x', scope: ['**'], status: 'applied' },
    ])
    expect(output.context.docs).toEqual([
      {
        path: '.cursor/rules/a.mdc',
        origin: 'repository',
        category: 'agents',
        bytes: 10,
        status: 'omitted',
        reason: 'out-of-scope',
        scope: ['lib/**'],
      },
      {
        path: 'README.md',
        origin: 'repository',
        category: 'contributing',
        bytes: 5,
        status: 'included',
      },
    ])
  })

  it('prints a review skipped because every file was ignored, with its context', () => {
    const context = contextReportFixture()

    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'skipped', reason: 'all-ignored' },
        null,
        context,
      ),
    )

    expect(output).toMatchObject({ status: 'skipped', reason: 'all-ignored', context })
  })

  it('prints the verification with the rejected findings and why they were rejected', () => {
    const rejected = findingFixture({ severity: 'P1', confidence: 55, line: 8, fix: null })
    const result: ReviewResult = {
      ...RESULT,
      dropped: { ...RESULT.dropped, rejected: 1 },
      verification: {
        candidates: 4,
        confirmed: 2,
        unverified: 1,
        rejected: [{ ...rejected, reason: 'Handled at line 4.' }],
        durationMs: 9000,
        usage: { inputTokens: 9800, outputTokens: 200 },
      },
    }

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: {
        dropped: { rejected: 1 },
        verification: {
          candidates: 4,
          confirmed: 2,
          unverified: 1,
          rejected: [{ ...rejected, reason: 'Handled at line 4.' }],
          durationMs: 9000,
          usage: { inputTokens: 9800, outputTokens: 200 },
        },
      },
    })
  })

  it('prints why the verifier confirmed a finding, and null for one it did not check', () => {
    const confirmed = findingFixture({ confidence: 85, reason: 'Line 3 trusts the request body.' })
    const result: ReviewResult = { ...RESULT, findings: [confirmed] }

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: {
        findings: [{ ...confirmed, reason: 'Line 3 trusts the request body.' }],
        worthChecking: [{ reason: null }],
      },
    })
  })

  it('prints a null usage for a verification that did not report it', () => {
    const verification = { candidates: 0, confirmed: 0, unverified: 0, rejected: [], durationMs: 0 }

    const output = parse(
      formatReviewJson(pullRequestFixture(), {
        status: 'reviewed',
        result: { ...RESULT, verification },
      }),
    )

    expect(output).toMatchObject({ review: { verification: { ...verification, usage: null } } })
  })

  it('keeps the same shape when the provider reports no model or usage', () => {
    const { model: _model, additionalModels: _models, usage: _usage, ...result } = RESULT

    const output = parse(formatReviewJson(pullRequestFixture(), { status: 'reviewed', result }))

    expect(output).toMatchObject({
      review: { provider: { id: 'codex-cli', model: null, additionalModels: [] }, usage: null },
    })
  })

  it('lists the tokens of each AI pass with the recheck, and null for what was not reported', () => {
    const recheck: RecheckReport = {
      threads: 1,
      fixed: 1,
      stillValid: 0,
      unsure: 0,
      verdicts: [
        {
          threadId: 't',
          file: 'a.ts',
          line: 1,
          title: 'x',
          verdict: 'fixed',
          reason: '',
          by: 'ai',
        },
      ],
      durationMs: 10,
    }
    const result: ReviewResult = {
      ...RESULT,
      usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 },
      passUsage: [
        {
          pass: 'review',
          skill: 'code-review',
          usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 },
        },
        { pass: 'review', skill: 'phada' },
      ],
    }

    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result },
        null,
        null,
        null,
        null,
        null,
        recheck,
      ),
    )

    expect(output).toMatchObject({
      review: { usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 } },
      recheck: { usage: null },
      usage: {
        passes: [
          {
            pass: 'review',
            skill: 'code-review',
            usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 },
          },
          { pass: 'review', skill: 'phada', usage: null },
          { pass: 'recheck', skill: null, usage: null },
        ],
        total: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 },
      },
    })
  })

  it('prints a skipped review with the pull request', () => {
    const output = formatReviewJson(pullRequestFixture({ diff: '' }), {
      status: 'skipped',
      reason: 'empty-diff',
    })

    expect(parse(output)).toEqual({
      schemaVersion: 1,
      status: 'skipped',
      reason: 'empty-diff',
      verdict: 'skipped',
      pullRequest: PULL_REQUEST,
      publication: null,
      context: null,
      conversation: null,
      ci: null,
      investigation: null,
      impact: null,
      related: null,
      recheck: null,
      usage: { passes: [], total: null },
    })
  })

  it('keeps text from the AI as it is, with control characters escaped by JSON', () => {
    const why = '## Findings\n```\n\u001B[2Jgone'
    const result = { ...RESULT, findings: [findingFixture({ why })] }

    const output = formatReviewJson(pullRequestFixture(), { status: 'reviewed', result })

    expect(output).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/)
    expect(parse(output)).toMatchObject({ review: { findings: [{ why }] } })
  })

  it('leaves out fields that are not part of the format', () => {
    const finding = { ...findingFixture(), category: 'security' }
    const result = {
      ...RESULT,
      findings: [finding],
      verification: {
        candidates: 1,
        confirmed: 0,
        unverified: 0,
        rejected: [{ ...finding, reason: 'Speculative.', debug: 'internal' }],
        durationMs: 1,
      },
      usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 },
    }

    const output = formatReviewJson(pullRequestFixture(), { status: 'reviewed', result })

    expect(output).not.toContain('category')
    expect(output).not.toContain('cachedTokens')
    expect(output).not.toContain('internal')
  })
})

describe('publication', () => {
  const reviewed = { status: 'reviewed', result: RESULT } as const
  const publicationOf = (output: string) => (parse(output) as { publication: unknown }).publication

  it('prints a published review with its URL and counts', () => {
    const url = 'https://github.com/acme/shop/pull/12#pullrequestreview-1'
    const output = formatReviewJson(pullRequestFixture(), reviewed, {
      status: 'published',
      url,
      comments: 2,
      stillOpen: 1,
      dismissed: 3,
    })

    expect(publicationOf(output)).toEqual({
      status: 'published',
      url,
      comments: 2,
      stillOpen: 1,
      dismissed: 3,
      resolved: { resolved: 0, failed: 0, total: 0 },
    })
    expect(parse(output)).toMatchObject({ status: 'reviewed', review: { summary: RESULT.summary } })
  })

  it('prints a failed publication with the error', () => {
    const output = formatReviewJson(pullRequestFixture(), reviewed, {
      status: 'failed',
      error: 'GitHub denied publishing the review.',
    })

    expect(publicationOf(output)).toEqual({
      status: 'failed',
      error: 'GitHub denied publishing the review.',
    })
  })

  it('prints the exact body and comments of a dry run', () => {
    const review = {
      body: 'Body',
      comments: [{ path: 'src/shop.ts', line: 3, body: 'Comment', extra: 'x' }],
    }

    expect(
      publicationOf(
        formatReviewJson(pullRequestFixture(), reviewed, {
          status: 'dry-run',
          review,
          stillOpen: 0,
        }),
      ),
    ).toEqual({
      status: 'dry-run',
      body: 'Body',
      comments: [{ path: 'src/shop.ts', line: 3, body: 'Comment' }],
      stillOpen: 0,
      dismissed: 0,
      wouldSkip: null,
      wouldResolve: [],
    })
    expect(
      publicationOf(
        formatReviewJson(pullRequestFixture(), reviewed, {
          status: 'dry-run',
          review,
          stillOpen: 1,
          wouldSkip: { kind: 'open-threads', openThreads: 2 },
        }),
      ),
    ).toMatchObject({ stillOpen: 1, wouldSkip: { reason: 'open-threads', openThreads: 2 } })
  })

  it('prints a pull request Phada already reviewed', () => {
    expect(
      parse(formatAlreadyReviewedJson(pullRequestFixture(), { kind: 'nothing-found' })),
    ).toEqual({
      schemaVersion: 1,
      status: 'skipped',
      reason: 'already-reviewed',
      verdict: 'skipped',
      pullRequest: PULL_REQUEST,
      publication: { status: 'skipped', reason: 'nothing-found', openThreads: 0 },
      context: null,
      conversation: null,
      ci: null,
      investigation: null,
      impact: null,
      related: null,
      recheck: null,
      usage: { passes: [], total: null },
    })
    expect(
      parse(
        formatAlreadyReviewedJson(pullRequestFixture(), { kind: 'open-threads', openThreads: 3 }),
      ),
    ).toMatchObject({ publication: { reason: 'open-threads', openThreads: 3 } })
    expect(
      parse(
        formatAlreadyReviewedJson(pullRequestFixture(), {
          kind: 'same-diff',
          since: '0'.repeat(40),
        }),
      ),
    ).toMatchObject({
      publication: { reason: 'same-diff', since: '0'.repeat(40) },
    })
  })

  it('adds the MCP servers and the server of each call to the investigation', () => {
    const investigation = {
      status: 'used' as const,
      calls: [
        {
          pass: 'review' as const,
          tool: 'tickets__get_ticket',
          server: 'tickets',
          target: '{"id":"ABC-1"}',
          bytes: 10,
          error: null,
          inSources: false,
        },
      ],
      external: [],
      mcp: [
        {
          server: 'tickets',
          via: 'phada' as const,
          status: 'connected' as const,
          tools: ['get_ticket'],
          hidden: ['create_ticket'],
        },
      ],
      totals: { calls: 1, bytes: 10 },
    }

    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result: RESULT },
        null,
        null,
        investigation,
      ),
    )

    expect(output).toMatchObject({ investigation })
  })

  it('adds the investigation report', () => {
    const investigation = {
      status: 'used' as const,
      calls: [
        {
          pass: 'review' as const,
          tool: 'read_file',
          server: null,
          target: 'src/a.ts',
          bytes: 10,
          error: null,
          inSources: true,
        },
      ],
      external: [{ server: 'linear', tool: 'get_issue' }],
      totals: { calls: 1, bytes: 10 },
    }

    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result: RESULT },
        null,
        null,
        investigation,
      ),
    )

    expect(output).toMatchObject({ investigation })
  })

  it('adds the impact of the diff', () => {
    const impact = {
      status: 'used' as const,
      index: { files: 12, extracted: 2, durationMs: 300 },
      changed: [
        {
          kind: 'function',
          name: 'getUser',
          path: 'src/users.ts',
          lines: [1, 3] as [number, number],
          callers: 2,
          files: 1,
          shown: 2,
          dependencies: 0,
          capped: false,
        },
      ],
      totals: { symbols: 1, callers: 2, files: 1 },
      learned: [],
    }

    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result: RESULT },
        null,
        null,
        null,
        impact,
      ),
    )

    expect(output).toMatchObject({ impact })
    expect(Object.keys(output as object).slice(-4)).toEqual([
      'impact',
      'related',
      'recheck',
      'usage',
    ])
  })

  it('adds the conversation and the CI sent to the AI, without the texts', () => {
    const conversation: Conversation = {
      items: [
        {
          kind: 'comment',
          at: '2026-10-20T10:00:00Z',
          author: 'alice',
          role: 'member',
          body: 'Keep the old endpoint',
        },
        {
          kind: 'review',
          at: '2026-10-20T11:00:00Z',
          author: 'bob',
          role: 'owner',
          state: 'approved',
        },
        {
          kind: 'thread',
          at: '2026-10-21T09:00:00Z',
          author: 'carol',
          role: 'contributor',
          file: 'src/a.ts',
          line: null,
          resolved: true,
          outdated: false,
          body: 'Why?',
          replies: [{ at: '2026-10-21T10:00:00Z', author: 'dave', role: 'author', body: 'ok' }],
          omittedReplies: 1,
        },
      ],
      report: { items: 3, omitted: 2, resolved: 1, bots: 0, truncated: 1, bytes: 900 },
    }
    const ci: Ci = {
      entries: [],
      checks: [
        {
          name: 'test',
          state: 'failing',
          conclusion: 'failure',
          title: '1 failed',
          annotations: ['src/a.ts:1 failure: boom'],
          log: 'boom',
        },
        { name: 'build', state: 'passing' },
      ],
      summary: { state: 'failing', total: 2, failing: ['test'], pending: [] },
      report: {
        annotations: 1,
        omittedAnnotations: 0,
        logs: 1,
        omittedLogs: 0,
        truncated: 0,
        bytes: 300,
      },
      warnings: ['Commit statuses were not read: no statuses:read'],
    }

    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result: RESULT },
        null,
        null,
        null,
        null,
        null,
        null,
        undefined,
        { conversation, ci },
      ),
    )

    expect(output).toMatchObject({
      conversation: {
        count: 3,
        omitted: 2,
        resolved: 1,
        bots: 0,
        truncated: 1,
        budget: { limit: 16_384, used: 900 },
        items: [
          {
            kind: 'comment',
            at: '2026-10-20T10:00:00Z',
            author: 'alice',
            role: 'member',
            bytes: 110,
          },
          {
            kind: 'review',
            at: '2026-10-20T11:00:00Z',
            author: 'bob',
            role: 'owner',
            state: 'approved',
            bytes: 94,
          },
          {
            kind: 'thread',
            at: '2026-10-21T09:00:00Z',
            author: 'carol',
            role: 'contributor',
            file: 'src/a.ts',
            line: null,
            resolved: true,
            outdated: false,
            replies: 1,
            omittedReplies: 1,
            bytes: 265,
          },
        ],
      },
      ci: {
        state: 'failing',
        total: 2,
        failing: ['test'],
        pending: [],
        checks: [
          { name: 'test', state: 'failing', conclusion: 'failure', annotations: 1, logBytes: 4 },
          { name: 'build', state: 'passing', conclusion: null, annotations: 0, logBytes: null },
        ],
        annotations: { sent: 1, omitted: 0, limit: 50 },
        logs: { sent: 1, omitted: 0, limit: 12_288 },
        truncated: 0,
        bytes: 300,
        warnings: ['Commit statuses were not read: no statuses:read'],
      },
    })
    expect(JSON.stringify(output)).not.toContain('Keep the old endpoint')
    expect(Object.keys(output as object).slice(6, 10)).toEqual([
      'context',
      'conversation',
      'ci',
      'investigation',
    ])
  })

  it('adds the related repositories, with null for what is missing', () => {
    const output = parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result: RESULT },
        null,
        null,
        null,
        null,
        {
          status: 'used',
          repositories: [
            {
              repo: 'acme/web',
              origin: '.phada/config.yml',
              commit: 'abc',
              state: 'consumers',
              count: 2,
              packages: ['shop'],
              graph: true,
            },
            {
              repo: 'acme/secret',
              origin: 'user:config.yml',
              state: 'skipped',
              packages: [],
              graph: false,
              reason: 'private-on-public',
            },
          ],
        },
      ),
    )

    expect(output).toMatchObject({
      schemaVersion: 1,
      related: {
        status: 'used',
        reason: null,
        repositories: [
          {
            repo: 'acme/web',
            origin: '.phada/config.yml',
            description: null,
            commit: 'abc',
            state: 'consumers',
            count: 2,
            packages: ['shop'],
            graph: true,
            reason: null,
          },
          {
            repo: 'acme/secret',
            origin: 'user:config.yml',
            description: null,
            commit: null,
            state: 'skipped',
            count: null,
            packages: [],
            graph: false,
            reason: 'private-on-public',
          },
        ],
      },
    })
  })
})

describe('formatReviewJson with native skill passes', () => {
  const result: ReviewResult = {
    ...RESULT,
    passes: [
      { skill: 'phada', origin: 'phada', status: 'reviewed', durationMs: 5, findings: 1 },
      {
        skill: 'code-review:code-review',
        origin: '/p',
        status: 'reviewed',
        mode: 'native',
        durationMs: 60,
        findings: 0,
        output: '--- final answer ---\nNo issues.',
        captured: 1,
        blocked: [{ tool: 'Bash', input: 'npm test' }],
      },
    ],
    skillBodies: [{ skill: 'code-review:code-review', text: 'No issues.' }],
  }

  it('shows the mode, the skill output, the captured writes and each blocked command with its fix', () => {
    const output = JSON.parse(
      formatReviewJson(
        pullRequestFixture(),
        { status: 'reviewed', result },
        null,
        null,
        null,
        null,
        null,
        null,
        (blocked) => `fix for ${blocked.input}`,
      ),
    ) as { review: { passes: Record<string, unknown>[]; skillBodies: unknown } }

    expect(output.review.passes[0]).toMatchObject({
      mode: 'text',
      output: null,
      captured: null,
      blocked: [],
    })
    expect(output.review.passes[1]).toMatchObject({
      mode: 'native',
      output: '--- final answer ---\nNo issues.',
      captured: 1,
      blocked: [{ tool: 'Bash', input: 'npm test', fix: 'fix for npm test' }],
    })
    expect(output.review.skillBodies).toEqual([
      { skill: 'code-review:code-review', text: 'No issues.' },
    ])
  })

  it('has no skill bodies without them', () => {
    const output = JSON.parse(
      formatReviewJson(pullRequestFixture(), { status: 'reviewed', result: RESULT }),
    ) as {
      review: { skillBodies: unknown }
    }
    expect(output.review.skillBodies).toBeNull()
  })
})
