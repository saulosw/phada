import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import { verdictFixture, verificationJson } from '../../test/support/verification.js'
import { ProviderError } from '../providers/types.js'
import type { ReviewOutput, ReviewPrompt, ReviewProvider } from '../providers/types.js'
import { buildReviewPrompt } from './prompt.js'
import { runReview } from './run-review.js'
import type { Finding, NativeSkillRun, ReviewRequest, SkillPass } from './types.js'

const LINE = 'x'.repeat(99)

function created(path: string, kb: number): string {
  const lines = Math.round((kb * 1000) / 101)
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, () => `+${LINE}`),
    '',
  ].join('\n')
}

const LARGE = created('api/a.ts', 16) + created('web/b.ts', 16)

interface GroupTurn {
  summary?: string
  files?: string[]
  findings?: Finding[]
  claims?: unknown[]
  error?: Error
  output?: Partial<ReviewOutput>
}

const OUTPUT: ReviewOutput = {
  text: '',
  durationMs: 1000,
  model: 'claude-fake-1',
  usage: { inputTokens: 100, outputTokens: 10 },
}

function groupOf(prompt: ReviewPrompt): string {
  return /Group (\d+) of \d+/.exec(prompt.data)?.[1] ?? 'whole'
}

function byGroup(
  turns: Record<string, GroupTurn>,
  verify?: string,
): ReviewProvider & { prompts: ReviewPrompt[] } {
  const prompts: ReviewPrompt[] = []
  return {
    id: 'fake-cli',
    prompts,
    review: async (prompt) => {
      prompts.push(prompt)
      if (prompt.instructions.includes('skeptical senior engineer') && verify !== undefined) {
        return { ...OUTPUT, text: verify }
      }
      const turn = turns[groupOf(prompt)] ?? {}
      if (turn.error !== undefined) throw turn.error
      return {
        ...OUTPUT,
        text: reviewReportJson({
          summary: turn.summary ?? 'Changes things.',
          files: (turn.files ?? []).map((path) => ({
            path,
            checked: 'diff',
            against: null,
            change: '',
          })),
          findings: turn.findings ?? [],
          claims: turn.claims ?? [],
        }),
        ...turn.output,
      }
    },
  }
}

function requestOf(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    pullRequest: pullRequestFixture({ diff: LARGE }),
    verify: false,
    continuation: false,
    groups: { concurrency: 1 },
    ...overrides,
  }
}

async function reviewed(request: ReviewRequest, provider: ReviewProvider) {
  const outcome = await runReview(request, { provider, createNonce: () => 'abcdefabcdef' })
  if (outcome.status !== 'reviewed') throw new Error('expected a review')
  return outcome.result
}

const API: GroupTurn = { summary: 'Adds the api.', files: ['api/a.ts'] }
const WEB: GroupTurn = { summary: 'Adds the web.', files: ['web/b.ts'] }

describe('runReview with diff groups', () => {
  it('sends each group only its diff and the list of every changed file', async () => {
    const provider = byGroup({ '1': API, '2': WEB })

    await reviewed(requestOf(), provider)

    expect(provider.prompts).toHaveLength(2)
    const [api, web] = provider.prompts
    expect(api?.data).toContain('+++ b/api/a.ts')
    expect(api?.data).not.toContain('+++ b/web/b.ts')
    expect(web?.data).toContain('+++ b/web/b.ts')
    expect(web?.data).not.toContain('+++ b/api/a.ts')
    expect(api?.data).toContain(
      [
        '<<<PHADA_GROUP_abcdefabcdef',
        'Group 1 of 2: api (1 file, 16 KB)',
        'Changed files of the pull request (* in this group):',
        '* api/a.ts (+158 -0)',
        '  web/b.ts (+158 -0)',
        'PHADA_GROUP_abcdefabcdef>>>',
      ].join('\n'),
    )
    expect(api?.instructions).toContain('reviews it in groups of files')
    expect(api?.instructions).toContain(
      'A problem whose cause is in a file of another group belongs to that group',
    )
  })

  it('sends a small diff the prompt of a review without groups', async () => {
    const provider = byGroup({ whole: {} })
    const request = requestOf({ pullRequest: pullRequestFixture() })

    await reviewed(request, provider)

    const { groups: _groups, ...plain } = request
    expect(provider.prompts).toEqual([buildReviewPrompt(plain, 'abcdefabcdef')])
  })

  it('does not group when groups are off', async () => {
    const provider = byGroup({ whole: {} })
    const { groups: _groups, ...off } = requestOf()

    await reviewed(off, provider)

    expect(provider.prompts).toHaveLength(1)
    expect(provider.prompts[0]?.data).not.toContain('PHADA_GROUP')
  })

  it('drops a finding a group reports on a line of another group and counts it', async () => {
    const own = findingFixture({ file: 'api/a.ts', line: 3, title: 'Own' })
    const elsewhere = findingFixture({ file: 'web/b.ts', line: 4, title: 'Elsewhere' })
    const provider = byGroup({ '1': { ...API, findings: [own, elsewhere] }, '2': WEB })

    const result = await reviewed(requestOf(), provider)

    expect(result.findings.map(({ title }) => title)).toEqual(['Own'])
    expect(result.dropped.outsideDiff).toBe(1)
  })

  it('joins the groups into one review: summary, claims and coverage', async () => {
    const claim = { claim: 'Adds both apps', verdict: 'confirmed', evidence: 'api/a.ts:1' }
    const provider = byGroup({
      '1': { ...API, claims: [{ ...claim, verdict: 'unverified', evidence: '' }] },
      '2': { ...WEB, claims: [claim] },
    })

    const result = await reviewed(requestOf(), provider)

    expect(result.summary).toBe('Adds the api. Adds the web.')
    expect(result.claims).toEqual([claim])
    expect(result.coverage).toMatchObject({ level: 'full', covered: 2, total: 2 })
  })

  it('continues once over the gaps of every group, with the whole diff', async () => {
    const provider = byGroup({ '1': { files: [] }, '2': { files: [] } })

    const result = await reviewed(requestOf({ continuation: true }), provider)

    expect(provider.prompts).toHaveLength(3)
    const continued = provider.prompts[2]
    expect(continued?.data).not.toContain('PHADA_GROUP')
    expect(continued?.data).toContain('+++ b/api/a.ts')
    expect(continued?.data).toContain('+++ b/web/b.ts')
    expect(result.coverage?.continuation).toBeDefined()
  })

  it('verifies once with the whole diff', async () => {
    const provider = byGroup(
      {
        '1': { ...API, findings: [findingFixture({ file: 'api/a.ts', line: 3 })] },
        '2': { ...WEB, findings: [findingFixture({ file: 'web/b.ts', line: 3, title: 'Two' })] },
      },
      verificationJson([verdictFixture({ id: 1 }), verdictFixture({ id: 2 })]),
    )

    const result = await reviewed(requestOf({ verify: true }), provider)

    const verifying = provider.prompts.filter(({ instructions }) =>
      instructions.includes('skeptical senior engineer'),
    )
    expect(verifying).toHaveLength(1)
    expect(verifying[0]?.data).toContain('+++ b/api/a.ts')
    expect(verifying[0]?.data).toContain('+++ b/web/b.ts')
    expect(result.verification?.candidates).toBe(2)
  })

  it('runs no more groups at once than the concurrency', async () => {
    const diff = created('a/one.ts', 16) + created('b/two.ts', 16) + created('c/three.ts', 16)
    let running = 0
    let most = 0
    const provider: ReviewProvider = {
      id: 'fake-cli',
      review: async () => {
        running++
        most = Math.max(most, running)
        await Promise.resolve()
        await Promise.resolve()
        running--
        return { ...OUTPUT, text: reviewReportJson({ findings: [], files: [] }) }
      },
    }

    await reviewed(
      requestOf({ pullRequest: pullRequestFixture({ diff }), groups: { concurrency: 2 } }),
      provider,
    )
    expect(most).toBe(2)

    most = 0
    await reviewed(requestOf({ pullRequest: pullRequestFixture({ diff }) }), provider)
    expect(most).toBe(1)
  })

  it('keeps the other groups with a warning when a group answers an invalid review', async () => {
    const provider = byGroup({
      '1': { output: { text: 'not json' } },
      '2': { ...WEB, findings: [findingFixture({ file: 'web/b.ts', line: 3 })] },
    })

    const result = await reviewed(requestOf(), provider)

    expect(result.findings).toHaveLength(1)
    expect(result.warnings?.some((warning) => warning.startsWith('Group 1/2 (api) failed'))).toBe(
      true,
    )
    expect(result.coverage?.gaps).toEqual([{ path: 'api/a.ts', kind: 'missing' }])
    expect(result.groups?.[0]).toMatchObject({ label: 'api', failed: true })
  })

  it('fails the review when the provider fails', async () => {
    const provider = byGroup({
      '1': API,
      '2': { error: new ProviderError('fake-cli', 'usage-limit', 'Usage limit reached') },
    })

    await expect(reviewed(requestOf(), provider)).rejects.toThrow('Usage limit reached')
  })

  it('reports each group with its files, findings, time and tokens', async () => {
    const provider = byGroup({
      '1': { ...API, findings: [findingFixture({ file: 'api/a.ts', line: 3 })] },
      '2': { ...WEB, output: { durationMs: 2000, usage: { inputTokens: 200, outputTokens: 20 } } },
    })

    const result = await reviewed(requestOf(), provider)

    expect(result.groups).toEqual([
      {
        label: 'api',
        files: ['api/a.ts'],
        bytes: expect.any(Number),
        link: 'directory',
        findings: 1,
        durationMs: 1000,
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      {
        label: 'web',
        files: ['web/b.ts'],
        bytes: expect.any(Number),
        link: 'directory',
        findings: 0,
        durationMs: 2000,
        usage: { inputTokens: 200, outputTokens: 20 },
      },
    ])
    expect(result.passUsage).toEqual([
      { pass: 'review', group: 'api', usage: { inputTokens: 100, outputTokens: 10 } },
      { pass: 'review', group: 'web', usage: { inputTokens: 200, outputTokens: 20 } },
    ])
    expect(result.durationMs).toBe(3000)
  })

  it('leaves out the files marked as generated', async () => {
    const diff = created('api/a.ts', 16) + created('web/b.ts', 16) + created('web/gen.ts', 30)
    const provider = byGroup({ '1': API, '2': WEB, '3': {} })

    await reviewed(
      requestOf({
        pullRequest: pullRequestFixture({
          diff: created('api/a.ts', 9) + created('web/gen.ts', 30),
        }),
        context: { rules: [], docs: [], ignored: [], generated: ['web/gen.ts'] },
      }),
      provider,
    )
    expect(provider.prompts).toHaveLength(1)

    provider.prompts.length = 0
    await reviewed(requestOf({ pullRequest: pullRequestFixture({ diff }) }), provider)
    expect(provider.prompts).toHaveLength(3)
  })

  it('reports the start of each group of each text pass', async () => {
    const started: string[] = []
    const passes: SkillPass[] = [
      { skill: 'phada', lens: { kind: 'default' } },
      { skill: 'deep', lens: { kind: 'default' }, mode: 'native' },
    ]
    const run: NativeSkillRun = { text: 'ok', captured: [], durationMs: 1, blocked: [] }

    await runReview(requestOf({ passes }), {
      provider: byGroup({ '1': API, '2': WEB }),
      runSkill: async () => run,
      createNonce: () => 'abcdefabcdef',
      events: {
        groupStarted: (group, index, total, pass) =>
          started.push(`${pass?.skill} ${index + 1}/${total} ${group.label}`),
      },
    })

    expect(started).toEqual(['phada 1/2 api', 'phada 2/2 web'])
  })
})
