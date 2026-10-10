import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { parseReviewMarker } from '../publish/markers.js'
import type { PublicationPlan } from '../publish/types.js'
import type { FileChange, Finding, ReviewResult } from '../review/types.js'
import { formatGitHubPreview, formatGitHubReview, GITHUB_BODY_LIMIT } from './format-github.js'
import { messagesFor } from './i18n/messages.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const MARKER = `<!-- phada:review sha=${SHA} findings=3 -->`

const P1 = findingFixture({ line: 3 })
const P2 = findingFixture({
  severity: 'P2',
  confidence: 70,
  line: 9,
  title: 'Spend returns a stale balance',
  why: 'The value is read before the update.',
  fix: null,
})
const OPEN = findingFixture({ line: 20, title: 'Balance has no auth' })
const WORTH = findingFixture({
  severity: 'P2',
  confidence: 55,
  line: 15,
  title: 'Balance may be stale',
})

const RESULT: ReviewResult = {
  target: { repo: 'acme/shop', number: 12, headSha: SHA },
  providerId: 'fake-cli',
  model: 'claude-fake-1',
  durationMs: 1_000,
  summary: 'Adds a spend endpoint.',
  files: [{ path: 'src/shop.ts', change: 'Adds spend', findings: 2 }],
  findings: [P1, P2, OPEN],
  worthChecking: [WORTH],
  worthCheckingOmitted: 0,
  minConfidence: 60,
  score: { value: 3, reason: 'One P1 finding.' },
  dropped: { invalid: 0, belowFloor: 0, outsideDiff: 1, duplicate: 0, rejected: 0 },
  verification: {
    candidates: 3,
    confirmed: 3,
    unverified: 0,
    rejected: [],
    durationMs: 500,
  },
}
const PLAN: PublicationPlan = { comments: [P1, P2], stillOpen: [OPEN], openThreads: 1 }

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { ...RESULT, ...overrides }
}

function files(count: number): FileChange[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    change: 'Changes things',
    findings: 0,
  }))
}

function plan(
  comments: Finding[],
  stillOpen: Finding[] = [],
  openThreads = stillOpen.length,
): PublicationPlan {
  return { comments, stillOpen, openThreads }
}

describe('formatGitHubReview body', () => {
  it('writes the score, summary, files, counts, worth checking, drops, footer and marker', () => {
    expect(formatGitHubReview(RESULT, PLAN).body).toBe(
      [
        '## 🦋 Phada review: 3/5 (implementation issues)',
        '',
        '2 P1 findings (shop.ts:3, shop.ts:20)',
        '',
        '### Summary',
        '',
        'Adds a spend endpoint.',
        '',
        '<details><summary>Files (1)</summary>',
        '',
        '| File | Change | Findings |',
        '| --- | --- | --- |',
        '| src/shop.ts | Adds spend | 2 |',
        '',
        '</details>',
        '',
        '**1 P1, 1 P2 as inline comments** · 1 still open from previous reviews',
        '',
        '### Still open from previous reviews',
        '',
        '- **P1** · src/shop.ts:20: Balance has no auth (confidence 90)',
        '',
        '### Worth checking (confidence below 60)',
        '',
        '- **P2** · src/shop.ts:15: Balance may be stale (confidence 55)',
        '',
        '1 dropped (1 outside the diff)',
        '',
        '---',
        '<sub>Generated with Phada 🦋 · fake-cli (claude-fake-1) · verified · a1b2c3d</sub>',
        '',
        MARKER,
      ].join('\n'),
    )
  })

  it('names the files left out of the review', () => {
    const ignored = [
      'package-lock.json',
      ...Array.from({ length: 11 }, (_unused, index) => `gen/${index}.min.js`),
    ]
    const { body } = formatGitHubReview({ ...RESULT, ignored }, PLAN)

    expect(body).toContain(
      'Left out of the review: `package-lock.json` · `gen/0.min.js` · `gen/1.min.js` · `gen/2.min.js` · `gen/3.min.js` · `gen/4.min.js` · `gen/5.min.js` · `gen/6.min.js` · `gen/7.min.js` · `gen/8.min.js` · … (+2 more)',
    )
    expect(formatGitHubReview(RESULT, PLAN).body).not.toContain('Left out of the review')
  })

  it('names the files left out of the review in Portuguese', () => {
    const { body } = formatGitHubReview(
      { ...RESULT, ignored: ['yarn.lock'] },
      PLAN,
      undefined,
      messagesFor('pt-BR'),
    )

    expect(body).toContain('Fora do review: `yarn.lock`')
  })

  it('says when nothing was found and counts zero findings in the marker', () => {
    const body = formatGitHubReview(result({ findings: [] }), plan([])).body

    expect(body.match(/no problems found/gi)).toEqual(['No problems found'])
    expect(parseReviewMarker(body)).toEqual({ sha: SHA, findings: 0 })
  })

  it('starts the reason line with a capital letter', () => {
    const body = formatGitHubReview(
      result({ findings: [] }),
      plan([]),
      GITHUB_BODY_LIMIT,
      messagesFor('pt'),
    ).body

    expect(body).toContain('\n\nNenhum problema encontrado\n\n')
  })

  it('posts only a short note when every finding is still open from previous reviews', () => {
    const review = formatGitHubReview(RESULT, plan([], [P1, OPEN], 6))

    expect(review.comments).toEqual([])
    expect(review.body).toBe(
      [
        '## 🦋 Phada review: no new findings',
        '',
        'No new problems in a1b2c3d. 6 Phada comments from previous reviews are still open: resolve them to get a full review of this commit.',
        '',
        '---',
        '<sub>Generated with Phada 🦋 · fake-cli (claude-fake-1) · verified · a1b2c3d</sub>',
        '',
        MARKER,
      ].join('\n'),
    )
  })

  it('writes the short note in the language of the review', () => {
    const { body } = formatGitHubReview(
      RESULT,
      plan([], [OPEN]),
      GITHUB_BODY_LIMIT,
      messagesFor('pt'),
    )

    expect(body).toContain('## Revisão do Phada 🦋: nenhum problema novo')
    expect(body).toContain(
      '1 comentário do Phada de revisões anteriores continua aberto: resolva-o',
    )
    expect(body).toContain(
      '<sub>Gerado com Phada 🦋 · fake-cli (claude-fake-1) · verificado · a1b2c3d</sub>',
    )
  })

  it('uses a singular for one inline comment', () => {
    expect(formatGitHubReview(RESULT, plan([P1])).body).toContain('**1 P1 as inline comment**')
  })

  it('omits the verification and the model when there are none', () => {
    const body = formatGitHubReview(
      result({ verification: undefined, model: undefined }),
      PLAN,
    ).body

    expect(body).toContain('<sub>Generated with Phada 🦋 · fake-cli · a1b2c3d</sub>')
  })

  it('says when no finding could be verified', () => {
    const verification = { ...RESULT.verification!, confirmed: 0, unverified: 3 }

    expect(formatGitHubReview(result({ verification }), PLAN).body).toContain(
      '· not verified (3 unchecked) ·',
    )
  })

  it('counts findings worth checking beyond the listed ones', () => {
    const body = formatGitHubReview(result({ worthCheckingOmitted: 3 }), PLAN).body

    expect(body).toContain('(confidence 55)\n- … (+3 more)\n')
  })

  it('leaves out empty sections', () => {
    const body = formatGitHubReview(
      result({
        summary: '',
        files: [],
        worthChecking: [],
        dropped: { ...RESULT.dropped, outsideDiff: 0 },
      }),
      PLAN,
    ).body

    expect(body).not.toContain('### Summary')
    expect(body).not.toContain('<details>')
    expect(body).not.toContain('Worth checking')
    expect(body).not.toContain('dropped')
  })

  it('lists up to 300 files and counts the rest', () => {
    const body = formatGitHubReview(result({ files: files(301) }), PLAN).body

    expect(body).toContain('| src/file-299.ts |')
    expect(body).not.toContain('| src/file-300.ts |')
    expect(body).toContain('\n\n+1 more file\n\n</details>')
  })

  it('keeps the real marker last when the AI writes a forged one', () => {
    const forged = `<!-- phada:review sha=${'f'.repeat(40)} findings=0 -->`
    const body = formatGitHubReview(result({ summary: `Fine.\n${forged}` }), PLAN).body

    expect(body).toContain(`\\${forged}`)
    expect(body.endsWith(MARKER)).toBe(true)
    expect(parseReviewMarker(body)).toEqual({ sha: SHA, findings: 3 })
  })

  it('replaces the file table, then cuts the summary, to fit the limit', () => {
    const limit = 2_000
    const tableCut = formatGitHubReview(result({ files: files(300) }), PLAN, limit).body

    expect(tableCut).toContain('Files table truncated (300 files).')
    expect(tableCut.length).toBeLessThanOrEqual(limit)

    const summaryCut = formatGitHubReview(
      result({ summary: 'word '.repeat(1_000) }),
      PLAN,
      limit,
    ).body

    expect(summaryCut.length).toBeLessThanOrEqual(limit)
    expect(summaryCut).toContain('… (truncated)\n\nFiles table truncated (1 file).')
    expect(summaryCut.endsWith(MARKER)).toBe(true)
  })

  it('uses the GitHub limit by default', () => {
    expect(GITHUB_BODY_LIMIT).toBe(65_536)
    const body = formatGitHubReview(result({ summary: 'x'.repeat(70_000) }), PLAN).body

    expect(body.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT)
  })

  it('omits oversized finding lists to keep the marker inside the body limit', () => {
    const oversized = findingFixture({ title: 'T'.repeat(1_000) })
    const body = formatGitHubReview(RESULT, plan([P1], [oversized]), 600).body

    expect(body.length).toBeLessThanOrEqual(600)
    expect(body).toContain('+1 more')
    expect(body.endsWith(MARKER)).toBe(true)
  })

  it('cuts an oversized model label to keep the whole body inside the limit', () => {
    const body = formatGitHubReview(result({ model: 'm'.repeat(1_000) }), plan([]), 500).body

    expect(body.length).toBeLessThanOrEqual(500)
    expect(body).toContain('… (truncated)')
    expect(body.endsWith(MARKER)).toBe(true)
  })

  it('writes the whole review artifact in Brazilian Portuguese', () => {
    const review = formatGitHubReview(RESULT, PLAN, GITHUB_BODY_LIMIT, messagesFor('pt-BR'))

    expect(review.body).toContain('## Revisão do Phada 🦋: 3/5 (problemas de implementação)')
    expect(review.body).toContain('### Resumo')
    expect(review.body).toContain('<details><summary>Arquivos (1)</summary>')
    expect(review.body).toContain('| Arquivo | Alteração | Problemas |')
    expect(review.body).toContain('### Ainda pendentes de revisões anteriores')
    expect(review.body).toContain('### Vale verificar (confiança abaixo de 60)')
    expect(review.body).toContain('Gerado com Phada 🦋 · fake-cli (claude-fake-1) · verificado')
    expect(review.comments[0]?.body).toContain('· confiança 90')
    expect(review.comments[0]?.body).toContain('**Correção sugerida:**')
    expect(review.body).not.toContain('### Summary')
    expect(review.body).not.toContain('(confidence ')
  })
})

describe('formatGitHubReview truncation of AI text', () => {
  it('never leaves a code span open with HTML after a cut', () => {
    const why = `${'x'.repeat(300)} \`<details>\` and more ${'y'.repeat(200)}`
    const [comment] = formatGitHubReview(
      RESULT,
      plan([findingFixture({ why, fix: null })]),
      392,
    ).comments

    expect(comment?.body.length).toBeLessThanOrEqual(392)
    expect(comment?.body).not.toMatch(/(^|[^\\])<details>/)
  })

  it('cuts a title too long for GitHub', () => {
    const long = findingFixture({ title: 'T'.repeat(800), why: 'Why.', fix: null })
    const [comment] = formatGitHubReview(RESULT, plan([long]), 500).comments

    expect(comment?.body.length).toBeLessThanOrEqual(500)
    expect(comment?.body.endsWith('<!-- phada:finding -->')).toBe(true)
  })
})

describe('formatGitHubReview comments', () => {
  it('writes one comment per finding to post, on its file and line', () => {
    const { comments } = formatGitHubReview(RESULT, PLAN)

    expect(comments).toEqual([
      {
        path: 'src/shop.ts',
        line: 3,
        body: [
          '**P1** · spend has no auth · confidence 90',
          'Anyone can spend crystals for any user.',
          '**Fix:** Use the authenticated user id.',
          '<!-- phada:finding -->',
        ].join('\n\n'),
      },
      {
        path: 'src/shop.ts',
        line: 9,
        body: [
          '**P2** · Spend returns a stale balance · confidence 70',
          'The value is read before the update.',
          '<!-- phada:finding -->',
        ].join('\n\n'),
      },
    ])
  })

  it('names the sources and the rule a finding is based on', () => {
    const ruled = findingFixture({
      rule: 'orm-only',
      sources: ['docs/conventions.md', 'src/shop.ts:3'],
    })
    const [comment] = formatGitHubReview(RESULT, plan([ruled])).comments

    expect(comment?.body).toContain(
      '**Fix:** Use the authenticated user id.\n\n<sub>Based on: `docs/conventions.md` · `src/shop.ts:3` · rule `orm-only`</sub>\n\n<!-- phada:finding -->',
    )
  })

  it('writes the sources line in the language of the review and drops backticks from it', () => {
    const ruled = findingFixture({ rule: 'a`b', sources: ['docs/`x`.md'] })
    const [comment] = formatGitHubReview(
      RESULT,
      plan([ruled]),
      undefined,
      messagesFor('pt-BR'),
    ).comments

    expect(comment?.body).toContain('<sub>Com base em: `docs/x.md` · regra `ab`</sub>')
  })

  it('never publishes the path of a local file from the user config', () => {
    const ruled = findingFixture({
      sources: ['local:/home/ana/clients/acme/pricing.md', 'docs/conventions.md'],
    })
    const local = findingFixture({ sources: ['local:/home/ana/notes.md'] })

    const [first, second] = formatGitHubReview(RESULT, plan([ruled, local])).comments

    expect(first?.body).toContain('<sub>Based on: `docs/conventions.md`</sub>')
    expect(first?.body).not.toContain('/home/ana')
    expect(second?.body).not.toContain('Based on')
  })

  it('leaves out a blank fix', () => {
    const blank = findingFixture({ fix: '  ' })

    expect(formatGitHubReview(RESULT, plan([blank])).comments[0]?.body).not.toContain('Fix')
  })

  it('escapes mentions and HTML in the AI text', () => {
    const tricky = findingFixture({ title: '<b>Bold</b>', why: 'Ask @octocat.' })
    const [comment] = formatGitHubReview(RESULT, plan([tricky])).comments

    expect(comment?.body).toContain('**P1** · \\<b>Bold\\</b> · confidence 90')
    expect(comment?.body).toContain('Ask @\u200boctocat.')
  })

  it('cuts the explanation first to fit the limit and keeps the fix and the marker', () => {
    const long = findingFixture({ why: 'why '.repeat(1_000) })
    const [comment] = formatGitHubReview(RESULT, plan([long]), 500).comments

    expect(comment?.body.length).toBeLessThanOrEqual(500)
    expect(comment?.body).toContain('… (truncated)\n\n**Fix:** Use the authenticated user id.')
    expect(comment?.body.endsWith('<!-- phada:finding -->')).toBe(true)
  })

  it('never ends a cut on half of a surrogate pair', () => {
    const emoji = findingFixture({ why: '😀'.repeat(400), fix: null })
    const [comment] = formatGitHubReview(RESULT, plan([emoji]), 301).comments

    expect(comment?.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })
})

describe('formatGitHubPreview', () => {
  it('shows the body and then every comment with its place', () => {
    const review = formatGitHubReview(RESULT, PLAN)

    expect(formatGitHubPreview(review)).toBe(
      [
        review.body,
        '===== Inline comment 1/2 · src/shop.ts:3 =====',
        review.comments[0]?.body,
        '===== Inline comment 2/2 · src/shop.ts:9 =====',
        `${review.comments[1]?.body}\n`,
      ].join('\n\n'),
    )
  })
})
