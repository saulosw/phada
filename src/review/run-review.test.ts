import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewContextFixture } from '../../test/support/review-context.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import { ProviderError } from '../providers/types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import type { Toolbox } from '../investigation/toolbox.js'
import { diffFingerprint } from './diff-fingerprint.js'
import { InvalidReviewReportError } from './errors.js'
import { buildReviewPrompt } from './prompt.js'
import { REVIEW_REPORT_JSON_SCHEMA } from './report-schema.js'
import { DEFAULT_MIN_CONFIDENCE, runReview } from './run-review.js'
import { buildConvertPrompt } from './convert-prompt.js'
import { skillOutputText } from './skill-output.js'
import type { NativeSkillRun, SkillPass } from './types.js'
import { buildVerifyPrompt } from './verify-prompt.js'

class FakeProvider implements ReviewProvider {
  readonly id = 'fake-cli'
  readonly prompts: ReviewPrompt[] = []

  constructor(private readonly answer: () => Promise<ReviewOutput>) {}

  review(prompt: ReviewPrompt): Promise<ReviewOutput> {
    this.prompts.push(prompt)
    return this.answer()
  }
}

function inTurn(...outputs: ReviewOutput[]): () => Promise<ReviewOutput> {
  let next = 0
  return () => {
    const output = outputs[next++]
    return output === undefined
      ? Promise.reject(new Error('no more answers'))
      : Promise.resolve(output)
  }
}

function nonces(...values: string[]): () => string {
  let next = 0
  return () => values[next++] ?? 'ffffffffffff'
}

const OUTPUT: ReviewOutput = {
  text: reviewReportJson(),
  durationMs: 1234,
  model: 'claude-fake-1',
  usage: { inputTokens: 3512, outputTokens: 420 },
}

describe('runReview', () => {
  it('sends the prompt to the provider and returns the review with its target', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))
    const request = { pullRequest: pullRequestFixture(), language: 'pt-BR' }

    const outcome = await runReview(request, { provider, createNonce: () => 'abcdefabcdef' })

    expect(provider.prompts).toEqual([buildReviewPrompt(request, 'abcdefabcdef')])
    expect(outcome).toEqual({
      status: 'reviewed',
      result: {
        target: {
          repo: 'acme/shop',
          number: 12,
          headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          diffFingerprint: diffFingerprint(pullRequestFixture().diff),
        },
        providerId: 'fake-cli',
        model: 'claude-fake-1',
        durationMs: 1234,
        usage: { inputTokens: 3512, outputTokens: 420 },
        passUsage: [{ pass: 'review', usage: { inputTokens: 3512, outputTokens: 420 } }],
        summary: 'Adds a spend endpoint.',
        files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
        findings: [findingFixture()],
        worthChecking: [],
        worthCheckingOmitted: 0,
        minConfidence: 60,
        score: { value: 3, reason: '1 P1 finding (shop.ts:1)' },
        dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
        claims: [],
      },
    })
  })

  it('returns the claims of the description the AI checked', async () => {
    const claims = [
      { claim: 'Prevents two runs on staging', verdict: 'contradicted', evidence: 'ci.yml:4' },
    ]
    const provider = new FakeProvider(() =>
      Promise.resolve({ ...OUTPUT, text: reviewReportJson({ claims }) }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.claims).toEqual(claims)
    expect(outcome.result).not.toHaveProperty('warnings')
  })

  it('reviews an answer without claims as no claims, with a warning', async () => {
    const { claims: _claims, ...withoutClaims } = JSON.parse(reviewReportJson()) as Record<
      string,
      unknown
    >
    const provider = new FakeProvider(() =>
      Promise.resolve({ ...OUTPUT, text: JSON.stringify(withoutClaims) }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.claims).toEqual([])
    expect(outcome.result.findings).toEqual([findingFixture()])
    expect(outcome.result.warnings).toEqual([
      'The AI answer had no claims list: the claims of the pull request description were not checked.',
    ])
  })

  it('warns about the claims it left out for their shape', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({
        ...OUTPUT,
        text: reviewReportJson({
          claims: [{ claim: 'Fast', verdict: 'maybe', evidence: '' }, 'not a claim'],
        }),
      }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.warnings).toEqual([
      'Left out 2 claims of the AI answer with the wrong shape.',
    ])
  })

  describe('with findings of the repository the change did not cause', () => {
    const change = findingFixture({ severity: 'P2', line: 3, title: 'magic number' })
    const debt = findingFixture({ severity: 'P0', line: 12, title: 'balance nobody calls' })
    const unsureDebt = findingFixture({ line: 11, title: 'old helper', confidence: 55 })
    const provider = () =>
      new FakeProvider(() =>
        Promise.resolve({
          ...OUTPUT,
          text: reviewReportJson({
            findings: [
              change,
              { ...debt, scope: 'repository' },
              { ...unsureDebt, scope: 'repository' },
            ],
          }),
        }),
      )

    it('lists them as debt apart from the findings and leaves them out of the score by default', async () => {
      const outcome = await runReview(
        { pullRequest: pullRequestFixture() },
        { provider: provider() },
      )

      if (outcome.status !== 'reviewed') throw new Error('expected a review')
      expect(outcome.result.findings).toEqual([change])
      expect(outcome.result.debt).toEqual([{ ...debt, scope: 'repository' }])
      expect(outcome.result.worthChecking).toEqual([{ ...unsureDebt, scope: 'repository' }])
      expect(outcome.result.score).toEqual({ value: 4, reason: '1 P2 finding (shop.ts:3)' })
      expect(outcome.result.files).toEqual([
        { path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 },
      ])
      expect(outcome.result.dropped).not.toHaveProperty('debt')
    })

    it('keeps them among the findings, scored, with debt: comments', async () => {
      const outcome = await runReview(
        { pullRequest: pullRequestFixture(), debt: 'comments' },
        { provider: provider() },
      )

      if (outcome.status !== 'reviewed') throw new Error('expected a review')
      expect(outcome.result.findings).toEqual([{ ...debt, scope: 'repository' }, change])
      expect(outcome.result).not.toHaveProperty('debt')
      expect(outcome.result.score.value).toBe(1)
    })

    it('drops and counts them with debt: off', async () => {
      const outcome = await runReview(
        { pullRequest: pullRequestFixture(), debt: 'off' },
        { provider: provider() },
      )

      if (outcome.status !== 'reviewed') throw new Error('expected a review')
      expect(outcome.result.findings).toEqual([change])
      expect(outcome.result.worthChecking).toEqual([])
      expect(outcome.result).not.toHaveProperty('debt')
      expect(outcome.result.dropped.debt).toBe(2)
      expect(outcome.result.score.value).toBe(4)
    })
  })

  it('asks the provider for the review report schema', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

    await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(provider.prompts[0]?.outputSchema).toBe(REVIEW_REPORT_JSON_SCHEMA)
  })

  it('shows findings from confidence 60 by default, sorted, and counts what it dropped', async () => {
    const text = reviewReportJson({
      findings: [
        findingFixture({ severity: 'P2', confidence: 95, line: 9 }),
        findingFixture({ severity: 'P0', confidence: 60, line: 2 }),
        findingFixture({ confidence: 59 }),
        findingFixture({ confidence: 10 }),
        { severity: 'P1' },
      ],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [
        findingFixture({ severity: 'P0', confidence: 60, line: 2 }),
        findingFixture({ severity: 'P2', confidence: 95, line: 9 }),
      ],
      worthChecking: [findingFixture({ confidence: 59 })],
      worthCheckingOmitted: 0,
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      score: { value: 1, reason: '1 P0 finding (shop.ts:2)' },
      dropped: { invalid: 1, belowFloor: 1, outsideDiff: 0, duplicate: 0 },
    })
  })

  it('applies the confidence cut of the request and returns it', async () => {
    const text = reviewReportJson({
      findings: [findingFixture({ confidence: 90, line: 2 }), findingFixture({ confidence: 60 })],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview(
      { pullRequest: pullRequestFixture(), minConfidence: 95 },
      { provider },
    )

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [],
      worthChecking: [
        findingFixture({ confidence: 90, line: 2 }),
        findingFixture({ confidence: 60 }),
      ],
      minConfidence: 95,
      score: { value: 5, reason: 'no problems found' },
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 0 }],
    })
  })

  it.each([49, 101, 75.5])(
    'rejects a confidence cut of %d without calling the provider',
    async (minConfidence) => {
      const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

      await expect(
        runReview({ pullRequest: pullRequestFixture(), minConfidence }, { provider }),
      ).rejects.toThrow(
        new RangeError(`Invalid minConfidence ${minConfidence}: use an integer from 50 to 100.`),
      )
      expect(provider.prompts).toHaveLength(0)
    },
  )

  it('drops findings outside the diff and repeated findings, and counts them', async () => {
    const text = reviewReportJson({
      findings: [
        findingFixture({ line: 2 }),
        findingFixture({ line: 2, confidence: 85 }),
        findingFixture({ line: 40 }),
        findingFixture({ file: 'src/other.ts' }),
      ],
    })
    const provider = new FakeProvider(() => Promise.resolve({ text, durationMs: 1 }))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
      findings: [findingFixture({ line: 2 })],
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 2, duplicate: 1 },
    })
  })

  it('rejects an answer that is not a review report', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ text: 'No significant problems found.', durationMs: 1 }),
    )

    await expect(
      runReview({ pullRequest: pullRequestFixture() }, { provider }),
    ).rejects.toBeInstanceOf(InvalidReviewReportError)
  })

  it('leaves model and usage out when the provider does not report them', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ text: reviewReportJson({ findings: [] }), durationMs: 5 }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toEqual({
      target: expect.any(Object),
      providerId: 'fake-cli',
      durationMs: 5,
      passUsage: [{ pass: 'review' }],
      summary: 'Adds a spend endpoint.',
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 0 }],
      findings: [],
      worthChecking: [],
      worthCheckingOmitted: 0,
      minConfidence: 60,
      score: { value: 5, reason: 'no problems found' },
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
      claims: [],
    })
  })

  it('keeps its own identity fields when the provider output carries extra keys', async () => {
    const output = {
      ...OUTPUT,
      providerId: 'impostor-cli',
      target: { repo: 'evil/repo', number: 1, headSha: 'deadbeef' },
      raw: { secret: 'internal' },
    }
    const provider = new FakeProvider(() => Promise.resolve(output))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result).toEqual({
      target: {
        repo: 'acme/shop',
        number: 12,
        headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        diffFingerprint: diffFingerprint(pullRequestFixture().diff),
      },
      providerId: 'fake-cli',
      model: 'claude-fake-1',
      durationMs: 1234,
      usage: { inputTokens: 3512, outputTokens: 420 },
      passUsage: [{ pass: 'review', usage: { inputTokens: 3512, outputTokens: 420 } }],
      summary: 'Adds a spend endpoint.',
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
      findings: [findingFixture()],
      worthChecking: [],
      worthCheckingOmitted: 0,
      minConfidence: 60,
      score: { value: 3, reason: '1 P1 finding (shop.ts:1)' },
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
      claims: [],
    })
  })

  it('keeps the additional models reported by the provider', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ ...OUTPUT, additionalModels: ['claude-helper-1'] }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(outcome.status === 'reviewed' && outcome.result.additionalModels).toEqual([
      'claude-helper-1',
    ])
  })

  it('uses a fresh 12-character hex nonce for each review', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))
    const request = { pullRequest: pullRequestFixture() }

    await runReview(request, { provider })
    await runReview(request, { provider })

    const nonces = provider.prompts.map(({ data }) => /<<<PHADA_DIFF_([0-9a-f]+)\n/.exec(data)?.[1])
    expect(nonces[0]).toMatch(/^[0-9a-f]{12}$/)
    expect(nonces[1]).toMatch(/^[0-9a-f]{12}$/)
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it.each(['', '  \n\t\n'])(
    'skips a pull request whose diff is %j without calling the provider',
    async (diff) => {
      const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

      const outcome = await runReview({ pullRequest: pullRequestFixture({ diff }) }, { provider })

      expect(outcome).toEqual({ status: 'skipped', reason: 'empty-diff' })
      expect(provider.prompts).toHaveLength(0)
    },
  )

  it('does not verify the findings unless asked', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    expect(provider.prompts).toHaveLength(1)
    expect(outcome.status === 'reviewed' && outcome.result).not.toHaveProperty('verification')
  })

  describe('with verify', () => {
    const findingA = findingFixture({ severity: 'P2', confidence: 55, line: 3, title: 'a' })
    const findingB = findingFixture({ severity: 'P0', confidence: 90, line: 5, title: 'b' })
    const findingC = findingFixture({ severity: 'P1', confidence: 58, line: 6, title: 'c' })
    const report: ReviewOutput = {
      text: reviewReportJson({
        findings: [
          findingA,
          findingB,
          findingC,
          findingFixture({ line: 40, title: 'outside' }),
          findingFixture({ confidence: 10, title: 'low' }),
        ],
      }),
      durationMs: 1000,
      model: 'claude-fake-1',
      usage: { inputTokens: 3000, outputTokens: 400 },
    }
    const verification: ReviewOutput = {
      text: verificationJson([
        verdictFixture({ id: 1, severity: 'P1', confidence: 85 }),
        verdictFixture({ id: 2, verdict: 'rejected', reason: 'Handled at line 4.' }),
        verdictFixture({ id: 3, severity: 'P2', confidence: 40 }),
      ]),
      durationMs: 600,
      usage: { inputTokens: 3200, outputTokens: 150 },
    }
    const request = { pullRequest: pullRequestFixture(), verify: true }

    it('checks the candidates in a second call and scores only what survived', async () => {
      const provider = new FakeProvider(inTurn(report, verification))

      const outcome = await runReview(request, {
        provider,
        createNonce: nonces('aaaaaaaaaaaa', 'bbbbbbbbbbbb'),
      })

      expect(provider.prompts).toEqual([
        buildReviewPrompt(request, 'aaaaaaaaaaaa'),
        buildVerifyPrompt(request, [findingA, findingB, findingC], 'bbbbbbbbbbbb'),
      ])
      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        model: 'claude-fake-1',
        durationMs: 1600,
        usage: { inputTokens: 6200, outputTokens: 550 },
        files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
        findings: [{ ...findingA, severity: 'P1', confidence: 85, reason: 'The diff shows it.' }],
        worthChecking: [],
        score: { value: 3, reason: '1 P1 finding (shop.ts:3)' },
        dropped: { invalid: 0, belowFloor: 2, outsideDiff: 1, duplicate: 0, rejected: 1 },
        verification: {
          candidates: 3,
          confirmed: 2,
          unverified: 0,
          rejected: [{ ...findingB, reason: 'Handled at line 4.' }],
          durationMs: 600,
          usage: { inputTokens: 3200, outputTokens: 150 },
        },
      })
    })

    it('lifts a confirmed finding above the cut and keeps an unchecked one as it was', async () => {
      const lifted: ReviewOutput = {
        text: verificationJson([verdictFixture({ id: 3, severity: 'P1', confidence: 90 })]),
        durationMs: 1,
      }
      const provider = new FakeProvider(inTurn(report, lifted))

      const outcome = await runReview(request, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        findings: [findingB, { ...findingC, confidence: 90 }],
        worthChecking: [findingA],
        dropped: { rejected: 0 },
        verification: { candidates: 3, confirmed: 1, unverified: 2, rejected: [] },
      })
    })

    it('asks for candidates from confidence 25 and drops the ones still below 50', async () => {
      const unsure = findingFixture({ severity: 'P1', confidence: 30, line: 7, title: 'd' })
      const rare = findingFixture({ severity: 'P2', confidence: 20, line: 8, title: 'e' })
      const generous = { ...report, text: reviewReportJson({ findings: [unsure, rare] }) }
      const kept: ReviewOutput = {
        text: verificationJson([verdictFixture({ id: 1, confidence: 45 })]),
        durationMs: 1,
      }
      const provider = new FakeProvider(inTurn(generous, kept))

      const outcome = await runReview(request, { provider })

      expect(provider.prompts[0]?.instructions).toContain('rated 25 or higher')
      expect(provider.prompts[1]?.data).toContain('"title":"d"')
      expect(provider.prompts[1]?.data).not.toContain('"title":"e"')
      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        findings: [],
        worthChecking: [],
        dropped: { belowFloor: 2, rejected: 0 },
        verification: { candidates: 1, confirmed: 1 },
      })
    })

    it('sends the verification to the verifier when there is one', async () => {
      const provider = new FakeProvider(inTurn(report))
      const verifier = new FakeProvider(inTurn(verification))

      await runReview(request, { provider, verifier })

      expect(provider.prompts).toHaveLength(1)
      expect(verifier.prompts).toHaveLength(1)
      expect(verifier.prompts[0]?.data).toContain('<<<PHADA_FINDINGS_')
    })

    it('makes no second call when no candidate is left to check', async () => {
      const empty = {
        ...report,
        text: reviewReportJson({ findings: [findingFixture({ line: 40 })] }),
      }
      const provider = new FakeProvider(inTurn(empty))

      const outcome = await runReview(request, { provider })

      expect(provider.prompts).toHaveLength(1)
      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        durationMs: 1000,
        usage: { inputTokens: 3000, outputTokens: 400 },
        verification: { candidates: 0, confirmed: 0, unverified: 0, rejected: [], durationMs: 0 },
      })
    })

    it.each([
      ['the review', { inputTokens: 3200, outputTokens: 150 }, 'review'],
      ['the verification', { inputTokens: 3000, outputTokens: 400 }, 'verification'],
    ])('reports the usage of the call that has it when %s has none', async (_case, usage, bare) => {
      const { usage: _first, ...reportWithout } = report
      const { usage: _second, ...verificationWithout } = verification
      const provider = new FakeProvider(
        bare === 'review'
          ? inTurn(reportWithout, verification)
          : inTurn(report, verificationWithout),
      )

      const outcome = await runReview(request, { provider })

      expect(outcome.status === 'reviewed' && outcome.result.usage).toEqual(usage)
    })

    it('lists the tokens of the review and the verification apart', async () => {
      const cached = {
        ...report,
        usage: { inputTokens: 3000, cachedInputTokens: 2500, outputTokens: 400 },
      }
      const provider = new FakeProvider(inTurn(cached, verification))

      const outcome = await runReview(request, { provider })

      if (outcome.status !== 'reviewed') throw new Error('expected a review')
      expect(outcome.result.passUsage).toEqual([
        {
          pass: 'review',
          usage: { inputTokens: 3000, cachedInputTokens: 2500, outputTokens: 400 },
        },
        { pass: 'verify', usage: { inputTokens: 3200, outputTokens: 150 } },
      ])
      expect(outcome.result.usage).toEqual({
        inputTokens: 6200,
        cachedInputTokens: 2500,
        outputTokens: 550,
      })
    })

    it('lists a pass without tokens when its provider reports none', async () => {
      const { usage: _first, ...reportWithout } = report
      const provider = new FakeProvider(inTurn(reportWithout, verification))

      const outcome = await runReview(request, { provider })

      if (outcome.status !== 'reviewed') throw new Error('expected a review')
      expect(outcome.result.passUsage).toEqual([
        { pass: 'review' },
        { pass: 'verify', usage: { inputTokens: 3200, outputTokens: 150 } },
      ])
    })

    it('leaves usage out when neither call reports it', async () => {
      const { usage: _first, ...reportWithout } = report
      const { usage: _second, ...verificationWithout } = verification
      const provider = new FakeProvider(inTurn(reportWithout, verificationWithout))

      const outcome = await runReview(request, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).not.toHaveProperty('usage')
    })

    it('fails the review when the verification is not valid', async () => {
      const provider = new FakeProvider(inTurn(report, { text: 'Looks right.', durationMs: 1 }))

      await expect(runReview(request, { provider })).rejects.toBeInstanceOf(
        InvalidReviewReportError,
      )
    })
  })

  it('lets a provider failure propagate unchanged', async () => {
    const failure = new Error('provider exploded')
    const provider = new FakeProvider(() => Promise.reject(failure))

    await expect(runReview({ pullRequest: pullRequestFixture() }, { provider })).rejects.toBe(
      failure,
    )
  })
})

describe('runReview with repository context', () => {
  const context = reviewContextFixture()

  it('keeps only known rules and sources on the findings', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({
        ...OUTPUT,
        text: reviewReportJson({
          findings: [
            {
              ...findingFixture({ line: 3 }),
              rule: 'orm-only',
              sources: ['docs/conventions.md', 'docs/invented.md'],
            },
            { ...findingFixture({ line: 5, title: 'other' }), rule: 'invented', sources: [] },
          ],
        }),
      }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture(), context }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(
      outcome.result.findings.map(({ title, rule, sources }) => [title, rule, sources]),
    ).toEqual([
      ['spend has no auth', 'orm-only', ['docs/conventions.md']],
      ['other', undefined, undefined],
    ])
  })

  it('applies the severity of a rule after the verifier rated the finding', async () => {
    const report: ReviewOutput = {
      ...OUTPUT,
      text: reviewReportJson({
        findings: [
          { ...findingFixture({ line: 3, severity: 'P1' }), rule: 'orm-only', sources: [] },
        ],
      }),
    }
    const verification: ReviewOutput = {
      text: verificationJson([verdictFixture({ id: 1, severity: 'P2', confidence: 90 })]),
      durationMs: 10,
    }
    const provider = new FakeProvider(inTurn(report, verification))

    const outcome = await runReview(
      { pullRequest: pullRequestFixture(), context, verify: true },
      { provider },
    )

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings[0]).toMatchObject({ severity: 'P1', rule: 'orm-only' })
  })

  it('returns the files left out of the diff with the review', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

    const outcome = await runReview(
      {
        pullRequest: pullRequestFixture(),
        context: reviewContextFixture({ ignored: ['package-lock.json'] }),
      },
      { provider },
    )

    expect(outcome).toMatchObject({ result: { ignored: ['package-lock.json'] } })
  })

  it('skips without calling the provider when every changed file was ignored', async () => {
    const provider = new FakeProvider(() => Promise.reject(new Error('should not run')))

    const outcome = await runReview(
      {
        pullRequest: pullRequestFixture({ diff: '' }),
        context: reviewContextFixture({ ignored: ['package-lock.json'] }),
      },
      { provider },
    )

    expect(outcome).toEqual({ status: 'skipped', reason: 'all-ignored' })
    expect(provider.prompts).toEqual([])
  })
})

describe('runReview with the repository tools', () => {
  function toolboxFor(touched: string[]): Toolbox {
    return {
      definitions: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
      call: async () => ({ text: '', isError: false }),
      touchedPaths: () => touched,
    }
  }

  it('gives each pass its own toolbox', async () => {
    const review = toolboxFor([])
    const verify = toolboxFor([])
    const passes: string[] = []
    const provider = new FakeProvider(
      inTurn(OUTPUT, {
        ...OUTPUT,
        text: verificationJson([verdictFixture({ id: 1 })]),
      }),
    )

    await runReview(
      { pullRequest: pullRequestFixture(), verify: true },
      {
        provider,
        tools: (pass) => {
          passes.push(pass)
          return pass === 'review' ? review : verify
        },
      },
    )

    expect(passes).toEqual(['review', 'verify'])
    expect(provider.prompts[0]?.tools?.definitions).toBe(review.definitions)
    expect(provider.prompts[1]?.tools).toBe(verify)
  })

  it('keeps sources the AI read and sources from MCP servers it called', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({
        ...OUTPUT,
        externalCalls: [{ server: 'linear', tool: 'get_issue' }],
        text: reviewReportJson({
          findings: [
            {
              ...findingFixture({ line: 3 }),
              sources: [
                'src/other.ts:10-20',
                'linear: ENG-12',
                'notion: some page',
                'src/never-read.ts',
              ],
            },
          ],
        }),
      }),
    )

    const outcome = await runReview(
      { pullRequest: pullRequestFixture() },
      { provider, tools: () => toolboxFor(['src/other.ts']) },
    )

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings[0]?.sources).toEqual(['src/other.ts:10-20', 'linear: ENG-12'])
    expect(outcome.result.externalCalls).toEqual([{ server: 'linear', tool: 'get_issue' }])
  })

  it('keeps a source that names an MCP server as configured or as the AI CLI shows it', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({
        ...OUTPUT,
        externalCalls: [{ server: 'claude.ai Linear', tool: 'get_issue' }],
        text: reviewReportJson({
          findings: [
            {
              ...findingFixture({ line: 3 }),
              sources: [
                'claude.ai Linear: ENG-12',
                'claude_ai_Linear: ENG-13',
                'claude.ai Notion: x',
              ],
            },
          ],
        }),
      }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings[0]?.sources).toEqual([
      'claude.ai Linear: ENG-12',
      'claude_ai_Linear: ENG-13',
    ])
  })

  describe('suggestions', () => {
    const valid = {
      startLine: 1,
      endLine: 1,
      original: "import { db } from './db'",
      replacement: "import { db } from './db.js'",
    }

    it('keeps a suggestion that matches the diff and counts it', async () => {
      const report = reviewReportJson({ findings: [findingFixture({ suggestion: valid })] })
      const provider = new FakeProvider(() => Promise.resolve({ ...OUTPUT, text: report }))

      const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        findings: [findingFixture({ suggestion: valid })],
        suggestions: { valid: 1, invalid: 0, dropped: 0 },
      })
    })

    it('drops a suggestion that does not match the diff and keeps the fix', async () => {
      const report = reviewReportJson({
        findings: [findingFixture({ suggestion: { ...valid, original: 'import db' } })],
      })
      const provider = new FakeProvider(() => Promise.resolve({ ...OUTPUT, text: report }))

      const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).toMatchObject({
        findings: [findingFixture()],
        suggestions: { valid: 0, invalid: 1, dropped: 0 },
      })
      expect(outcome.status === 'reviewed' && outcome.result.findings[0]).not.toHaveProperty(
        'suggestion',
      )
    })

    it('counts the suggestions the verifier dropped', async () => {
      const report = reviewReportJson({ findings: [findingFixture({ suggestion: valid })] })
      const provider = new FakeProvider(
        inTurn(
          { ...OUTPUT, text: report },
          { text: verificationJson([verdictFixture({ suggestion: 'drop' })]), durationMs: 1 },
        ),
      )

      const outcome = await runReview(
        { pullRequest: pullRequestFixture(), verify: true },
        { provider },
      )

      expect(outcome.status === 'reviewed' && outcome.result.suggestions).toEqual({
        valid: 1,
        invalid: 0,
        dropped: 1,
      })
    })

    it('leaves the count out when no finding brought a suggestion', async () => {
      const provider = new FakeProvider(() => Promise.resolve(OUTPUT))

      const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

      expect(outcome.status === 'reviewed' && outcome.result).not.toHaveProperty('suggestions')
    })
  })

  it('returns the warnings of the provider', async () => {
    const provider = new FakeProvider(() =>
      Promise.resolve({ ...OUTPUT, warnings: ['model cannot call tools'] }),
    )

    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.warnings).toEqual(['model cannot call tools'])
    expect(outcome.result).not.toHaveProperty('externalCalls')
  })
})

describe('runReview with an investigation floor', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    ' keep',
    `+${'x'.repeat(64 * 1024)}`,
  ].join('\n')
  const smallDiff = diff.replace(/x+$/, 'x'.repeat(2_000))
  const toolbox: Toolbox = {
    definitions: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
    call: async () => ({ text: '', isError: false }),
    touchedPaths: () => [],
  }

  function investigating(calls: number, output: Partial<ReviewOutput> = {}): ReviewProvider {
    return {
      id: 'fake-cli',
      review: async (prompt) => {
        for (let call = 0; call < calls; call++) await prompt.tools?.call('read_file', {})
        return { ...OUTPUT, ...output }
      },
    }
  }

  async function reviewedWith(
    provider: ReviewProvider,
    {
      tools = () => toolbox,
      passes,
      diff: reviewed = diff,
    }: { tools?: (() => Toolbox) | null; passes?: SkillPass[]; diff?: string } = {},
  ) {
    const outcome = await runReview(
      {
        pullRequest: pullRequestFixture({ diff: reviewed }),
        ...(passes === undefined ? {} : { passes }),
      },
      { provider, ...(tools === null ? {} : { tools }) },
    )
    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    return outcome.result
  }

  it('warns when the review pass investigated less than the diff asks for', async () => {
    const result = await reviewedWith(investigating(4))

    const warning = 'Investigated 4 times for a 64 KB diff (expected at least 6).'
    expect(result.warnings).toEqual([warning])
    expect(result.investigationFloor).toEqual({ expected: 6, shortfalls: [warning] })
  })

  it('does not warn when the pass reached the floor', async () => {
    const result = await reviewedWith(investigating(6))

    expect(result).not.toHaveProperty('warnings')
    expect(result.investigationFloor).toEqual({ expected: 6, shortfalls: [] })
  })

  it('names the skill of each pass that investigated too little', async () => {
    const result = await reviewedWith(investigating(1), {
      passes: [
        {
          skill: 'code-review',
          lens: { kind: 'skill', name: 'code-review', text: 'x', origin: 'y' },
        },
      ],
    })

    expect(result.warnings).toEqual([
      'Skill code-review: investigated 1 time for a 64 KB diff (expected at least 6).',
    ])
  })

  it('expects no minimum for a small diff without CI or infrastructure files', async () => {
    const result = await reviewedWith(investigating(0), { diff: smallDiff })

    expect(result).not.toHaveProperty('warnings')
    expect(result).not.toHaveProperty('investigationFloor')
  })

  it('expects nothing without tools', async () => {
    const result = await reviewedWith(investigating(0), { tools: null })

    expect(result).not.toHaveProperty('warnings')
    expect(result).not.toHaveProperty('investigationFloor')
  })

  it('expects nothing when the provider could not offer the tools to its model', async () => {
    const result = await reviewedWith(investigating(0, { withoutTools: true }))

    expect(result).not.toHaveProperty('warnings')
    expect(result).not.toHaveProperty('investigationFloor')
  })
})

describe('runReview with several skill passes', () => {
  it('does not show the verifier the guide of a pass that failed', async () => {
    const provider = new FakeProvider(
      inTurn(
        OUTPUT,
        { ...OUTPUT, text: 'not a report' },
        { ...OUTPUT, text: verificationJson([verdictFixture({ id: 1 })]) },
      ),
    )

    await runReview(
      {
        pullRequest: pullRequestFixture(),
        verify: true,
        passes: [
          { skill: 'phada', lens: { kind: 'append', text: 'Flag missing tests.', origin: 'x' } },
          {
            skill: 'code-review',
            lens: { kind: 'skill', name: 'code-review', text: 'Find bugs.', origin: 'y' },
          },
        ],
      },
      { provider },
    )

    expect(provider.prompts[2]?.instructions).toContain('[phada]\nFlag missing tests.')
    expect(provider.prompts[2]?.instructions).not.toContain('Find bugs.')
  })

  const PHADA_PASS: SkillPass = { skill: 'phada', lens: { kind: 'default' } }
  const SKILL_PASS: SkillPass = {
    skill: 'code-review',
    lens: { kind: 'skill', name: 'code-review', text: 'Find bugs.', origin: '/s/SKILL.md' },
  }
  const second = findingFixture({ line: 3, title: 'spend ignores the balance', severity: 'P2' })
  const answer = (findings: unknown[], extra: Partial<ReviewOutput> = {}): ReviewOutput => ({
    ...OUTPUT,
    text: reviewReportJson({ findings }),
    ...extra,
  })

  async function reviewed(
    passes: SkillPass[],
    outputs: (ReviewOutput | Error)[],
    tools?: () => Toolbox,
  ) {
    let next = 0
    const provider = new FakeProvider(() => {
      const output = outputs[next++]
      return output instanceof Error || output === undefined
        ? Promise.reject(output ?? new Error('no more answers'))
        : Promise.resolve(output)
    })
    const outcome = await runReview(
      { pullRequest: pullRequestFixture(), passes },
      { provider, ...(tools === undefined ? {} : { tools }) },
    )
    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    return { result: outcome.result, provider }
  }

  it('calls the provider once per pass, each with its own lens and toolbox', async () => {
    const boxes: string[] = []
    const { provider } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [answer([findingFixture()]), answer([second])],
      () => {
        boxes.push('review')
        return {
          definitions: [],
          call: async () => ({ text: '', isError: false }),
          touchedPaths: () => [],
        }
      },
    )

    expect(provider.prompts).toHaveLength(2)
    expect(provider.prompts[0]?.instructions).toContain('You are a senior engineer')
    expect(provider.prompts[1]?.instructions).toContain('Review guide (skill code-review):')
    expect(boxes).toEqual(['review', 'review'])
  })

  it('merges the findings of every pass with the skill that found each', async () => {
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [answer([findingFixture()]), answer([findingFixture(), second])],
    )

    expect(result.findings.map(({ line, skill }) => [line, skill])).toEqual([
      [1, 'phada'],
      [3, 'code-review'],
    ])
    expect(result.dropped.duplicate).toBe(1)
  })

  it('merges the claims of every pass, one per text, keeping the strongest verdict', async () => {
    const claim = (text: string, verdict: string, evidence = '') => ({
      claim: text,
      verdict,
      evidence,
    })
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [
        {
          ...OUTPUT,
          text: reviewReportJson({
            claims: [
              claim('Prevents two runs on staging', 'confirmed', 'ci.yml:4'),
              claim('Covers the empty cart', 'unverified'),
            ],
          }),
        },
        {
          ...OUTPUT,
          text: reviewReportJson({
            claims: [
              claim('prevents two  runs on staging', 'contradicted', 'ci.yml:9 groups by ref'),
              claim('Covers the empty cart', 'confirmed', 'shop.test.ts:40'),
              claim('Only runs on main', 'unverified'),
            ],
          }),
        },
      ],
    )

    expect(result.claims).toEqual([
      claim('prevents two  runs on staging', 'contradicted', 'ci.yml:9 groups by ref'),
      claim('Covers the empty cart', 'confirmed', 'shop.test.ts:40'),
      claim('Only runs on main', 'unverified'),
    ])
  })

  it('names the pass whose answer had no claims list', async () => {
    const { claims: _claims, ...withoutClaims } = JSON.parse(reviewReportJson()) as Record<
      string,
      unknown
    >
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [answer([findingFixture()]), { ...OUTPUT, text: JSON.stringify(withoutClaims) }],
    )

    expect(result.warnings).toEqual([
      'Skill code-review: the AI answer had no claims list: the claims of the pull request description were not checked.',
    ])
  })

  it('lists the tokens of each skill pass, a failed answer included', async () => {
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [
        answer([findingFixture()]),
        { ...OUTPUT, text: 'not a report', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    )

    expect(result.passUsage).toEqual([
      { pass: 'review', skill: 'phada', usage: { inputTokens: 3512, outputTokens: 420 } },
      { pass: 'review', skill: 'code-review', usage: { inputTokens: 10, outputTokens: 5 } },
    ])
    expect(result.usage).toEqual({ inputTokens: 3522, outputTokens: 425 })
  })

  it('sums time and tokens and reports each pass', async () => {
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [
        answer([findingFixture()]),
        answer([second], { durationMs: 1000, usage: { inputTokens: 10, outputTokens: 5 } }),
      ],
    )

    expect(result.durationMs).toBe(2234)
    expect(result.usage).toEqual({ inputTokens: 3522, outputTokens: 425 })
    expect(result.passes).toEqual([
      {
        skill: 'phada',
        origin: 'phada',
        status: 'reviewed',
        durationMs: 1234,
        usage: { inputTokens: 3512, outputTokens: 420 },
        findings: 1,
      },
      {
        skill: 'code-review',
        origin: '/s/SKILL.md',
        status: 'reviewed',
        durationMs: 1000,
        usage: { inputTokens: 10, outputTokens: 5 },
        findings: 1,
      },
    ])
  })

  it('skips a pass whose paths match no changed file', async () => {
    const { result, provider } = await reviewed(
      [
        PHADA_PASS,
        { ...SKILL_PASS, paths: ['src/auth/**'], skip: 'no changed file matches src/auth/**' },
      ],
      [answer([findingFixture()])],
    )

    expect(provider.prompts).toHaveLength(1)
    expect(result.passes?.[1]).toEqual({
      skill: 'code-review',
      origin: '/s/SKILL.md',
      status: 'skipped',
      durationMs: 0,
      findings: 0,
      reason: 'no changed file matches src/auth/**',
    })
  })

  it('skips the review when every pass is skipped', async () => {
    const provider = new FakeProvider(() => Promise.reject(new Error('never called')))

    const outcome = await runReview(
      {
        pullRequest: pullRequestFixture(),
        passes: [{ ...SKILL_PASS, paths: ['docs/**'], skip: 'no changed file matches docs/**' }],
      },
      { provider },
    )

    expect(provider.prompts).toHaveLength(0)
    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'no-skill-applies',
      passes: [
        {
          skill: 'code-review',
          origin: '/s/SKILL.md',
          status: 'skipped',
          durationMs: 0,
          findings: 0,
          reason: 'no changed file matches docs/**',
        },
      ],
    })
  })

  it('fails the whole review when a pass hits a provider limit', async () => {
    await expect(
      reviewed(
        [PHADA_PASS, SKILL_PASS],
        [answer([findingFixture()]), new ProviderError('claude-cli', 'usage-limit', 'limit hit')],
      ),
    ).rejects.toThrow(ProviderError)
  })

  it('keeps the review when a pass gives the provider an invalid answer', async () => {
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [answer([findingFixture()]), new ProviderError('claude-cli', 'invalid-output', 'max turns')],
    )

    expect(result.passes?.[1]).toMatchObject({ status: 'failed', reason: 'max turns' })
  })

  it('takes the summary from the first pass that answered', async () => {
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [
        { ...OUTPUT, text: 'not a report' },
        {
          ...answer([second]),
          text: reviewReportJson({ summary: 'From the skill.', findings: [second] }),
        },
      ],
    )

    expect(result.summary).toBe('From the skill.')
    expect(result.findings.map(({ skill }) => skill)).toEqual(['code-review'])
    expect(result.passes?.[0]).toMatchObject({ status: 'failed' })
    expect(result.warnings?.[0]).toMatch(/^Skill phada failed: /)
  })

  it('fails with the error of the first pass when every pass fails', async () => {
    await expect(
      reviewed([PHADA_PASS, SKILL_PASS], [new Error('first'), new Error('second')]),
    ).rejects.toThrow('first')
  })

  it('lets the error of a single pass propagate', async () => {
    await expect(reviewed([SKILL_PASS], [new Error('only')])).rejects.toThrow('only')
  })

  it('leaves passes and skills out without passes', async () => {
    const provider = new FakeProvider(() => Promise.resolve(OUTPUT))
    const outcome = await runReview({ pullRequest: pullRequestFixture() }, { provider })

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.passes).toBeUndefined()
    expect(outcome.result.findings[0]?.skill).toBeUndefined()
  })

  it('tells the caller when each pass starts', async () => {
    const started: string[] = []
    const provider = new FakeProvider(inTurn(answer([]), answer([])))

    await runReview(
      { pullRequest: pullRequestFixture(), passes: [PHADA_PASS, SKILL_PASS] },
      { provider, events: { passStarted: (pass) => started.push(pass.skill) } },
    )

    expect(started).toEqual(['phada', 'code-review'])
  })

  it('keeps sources read in any pass and calls of every pass', async () => {
    let call = 0
    const touched = [['src/a.ts'], ['src/b.ts']]
    const { result } = await reviewed(
      [PHADA_PASS, SKILL_PASS],
      [
        answer([]),
        answer([{ ...second, sources: ['src/a.ts', 'src/b.ts'] }], {
          externalCalls: [{ server: 'linear', tool: 'get_issue' }],
        }),
      ],
      () => {
        const paths = touched[call++] ?? []
        return {
          definitions: [],
          call: async () => ({ text: '', isError: false }),
          touchedPaths: () => paths,
        }
      },
    )

    expect(result.findings[0]?.sources).toEqual(['src/a.ts', 'src/b.ts'])
    expect(result.externalCalls).toEqual([{ server: 'linear', tool: 'get_issue' }])
  })
})

describe('runReview with a native skill pass', () => {
  const NATIVE: SkillPass = {
    skill: 'code-review:code-review',
    mode: 'native',
    lens: { kind: 'skill', name: 'code-review:code-review', text: 'Five agents.', origin: '/p' },
  }
  const PHADA: SkillPass = { skill: 'phada', lens: { kind: 'default' } }
  const skillRun = (overrides: Partial<NativeSkillRun> = {}): NativeSkillRun => ({
    text: 'Found 1 issue: spend ignores the balance (src/shop.ts:1).',
    captured: [],
    durationMs: 60_000,
    model: 'claude-opus',
    usage: { inputTokens: 100_000, outputTokens: 5_000 },
    blocked: [{ tool: 'Bash', input: 'npm test' }],
    ...overrides,
  })

  async function nativeReview(
    passes: SkillPass[],
    outputs: ReviewOutput[],
    run: NativeSkillRun | Error = skillRun(),
    extra: { verify?: boolean } = {},
  ) {
    const provider = new FakeProvider(inTurn(...outputs))
    const ran: SkillPass[] = []
    const outcome = await runReview(
      { pullRequest: pullRequestFixture(), passes, ...extra },
      {
        provider,
        runSkill: async (pass) => {
          ran.push(pass)
          if (run instanceof Error) throw run
          return run
        },
        createNonce: () => 'abcdefabcdef',
      },
    )
    return { outcome, provider, ran }
  }

  it('runs the skill, then converts its output without tools', async () => {
    const { outcome, provider, ran } = await nativeReview([NATIVE], [OUTPUT])

    expect(ran).toEqual([NATIVE])
    expect(provider.prompts).toEqual([
      buildConvertPrompt(
        { pullRequest: pullRequestFixture(), passes: [NATIVE] },
        'abcdefabcdef',
        NATIVE,
        skillOutputText(skillRun()),
      ),
    ])
    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings).toEqual([
      { ...findingFixture(), skill: 'code-review:code-review' },
    ])
    expect(outcome.result.durationMs).toBe(60_000 + 1234)
    expect(outcome.result.usage).toEqual({ inputTokens: 103_512, outputTokens: 5_420 })
    expect(outcome.result.model).toBe('claude-opus')
    expect(outcome.result.passes).toEqual([
      {
        skill: 'code-review:code-review',
        origin: '/p',
        status: 'reviewed',
        mode: 'native',
        durationMs: 61_234,
        usage: { inputTokens: 103_512, outputTokens: 5_420 },
        findings: 1,
        output: skillOutputText(skillRun()),
        captured: 0,
        blocked: [{ tool: 'Bash', input: 'npm test' }],
      },
    ])
    expect(outcome.result.skillBodies).toBeUndefined()
  })

  it('sums the tokens of a native skill run and its conversion in its pass', async () => {
    const { outcome } = await nativeReview(
      [NATIVE],
      [{ ...OUTPUT, usage: { inputTokens: 3512, cachedInputTokens: 12, outputTokens: 420 } }],
      skillRun({ usage: { inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 5_000 } }),
    )

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.passUsage).toEqual([
      {
        pass: 'review',
        skill: 'code-review:code-review',
        usage: { inputTokens: 103_512, cachedInputTokens: 80_012, outputTokens: 5_420 },
      },
    ])
  })

  it('uses the skill output as the review body when the conversion is not readable', async () => {
    const { outcome } = await nativeReview([NATIVE], [{ ...OUTPUT, text: 'not a report' }])

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings).toEqual([])
    expect(outcome.result.skillBodies).toEqual([
      { skill: 'code-review:code-review', text: skillRun().text },
    ])
    expect(outcome.result.warnings).toContain(
      'Skill code-review:code-review: Phada could not read the converted review; the skill output is used as the review body.',
    )
  })

  it('uses the skill output as the body when none of its findings is in the diff', async () => {
    const outside = reviewReportJson({ findings: [findingFixture({ line: 999 })] })
    const { outcome } = await nativeReview([NATIVE], [{ ...OUTPUT, text: outside }])

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.skillBodies).toEqual([
      { skill: 'code-review:code-review', text: skillRun().text },
    ])
  })

  it('uses the skill output as the body when its findings in the diff are below the floor', async () => {
    const weak = reviewReportJson({ findings: [findingFixture({ confidence: 40 })] })
    const { outcome } = await nativeReview([NATIVE], [{ ...OUTPUT, text: weak }])

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings).toEqual([])
    expect(outcome.result.skillBodies).toEqual([
      { skill: 'code-review:code-review', text: skillRun().text },
    ])
  })

  it('gives the body only of the native pass that found nothing in the diff', async () => {
    const empty = reviewReportJson({ findings: [] })
    const { outcome } = await nativeReview([PHADA, NATIVE], [OUTPUT, { ...OUTPUT, text: empty }])

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings).toHaveLength(1)
    expect(outcome.result.skillBodies?.map(({ skill }) => skill)).toEqual([
      'code-review:code-review',
    ])
  })

  it('does not use the body when the verifier rejected the findings', async () => {
    const { outcome } = await nativeReview(
      [NATIVE],
      [
        OUTPUT,
        { ...OUTPUT, text: verificationJson([verdictFixture({ id: 1, verdict: 'rejected' })]) },
      ],
      skillRun(),
      { verify: true },
    )

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings).toEqual([])
    expect(outcome.result.skillBodies).toBeUndefined()
  })

  it('takes the body from what the skill tried to publish', async () => {
    const run = skillRun({
      captured: [{ command: 'gh pr comment', body: 'Posted review.', comments: [] }],
    })
    const { outcome } = await nativeReview([NATIVE], [{ ...OUTPUT, text: 'nope' }], run)

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.skillBodies).toEqual([
      { skill: 'code-review:code-review', text: 'Posted review.' },
    ])
    expect(outcome.result.passes?.[0]?.captured).toBe(1)
  })

  it('fails the review when the skill run fails, even with other passes', async () => {
    await expect(
      nativeReview(
        [PHADA, NATIVE],
        [OUTPUT],
        new ProviderError('claude-cli', 'timeout', 'Claude did not answer within 1800s.'),
      ),
    ).rejects.toThrow('Claude did not answer within 1800s.')
  })

  it('turns an unreadable skill run into a warning when other passes answer', async () => {
    const { outcome } = await nativeReview(
      [PHADA, NATIVE],
      [OUTPUT],
      new ProviderError(
        'claude-cli',
        'invalid-output',
        'Claude did not finish the skill within 100 turns.',
      ),
    )

    if (outcome.status !== 'reviewed') throw new Error('expected a review')
    expect(outcome.result.findings).toHaveLength(1)
    expect(outcome.result.passes?.[1]).toMatchObject({
      skill: 'code-review:code-review',
      status: 'failed',
      mode: 'native',
      reason: 'Claude did not finish the skill within 100 turns.',
    })
    expect(outcome.result.warnings).toContain(
      'Skill code-review:code-review failed: Claude did not finish the skill within 100 turns.',
    )
  })

  it('still fails a single native pass whose run is unreadable', async () => {
    await expect(
      nativeReview([NATIVE], [], new ProviderError('claude-cli', 'invalid-output', 'empty')),
    ).rejects.toThrow('empty')
  })

  it('refuses a native pass without a skill runner', async () => {
    const provider = new FakeProvider(inTurn(OUTPUT))

    await expect(
      runReview({ pullRequest: pullRequestFixture(), passes: [NATIVE] }, { provider }),
    ).rejects.toThrow('Skill code-review:code-review runs natively but no skill runner was given.')
  })
})
