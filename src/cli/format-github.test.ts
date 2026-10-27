import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { parseReviewMarker } from '../publish/markers.js'
import type { PublicationPlan } from '../publish/types.js'
import type { CiSummary } from '../context/types.js'
import type { FileChange, Finding, ReviewResult } from '../review/types.js'
import {
  formatGitHubPreview,
  formatGitHubReview,
  formatIgnoredOnlyReview,
  formatResolvedReply,
  GITHUB_BODY_LIMIT,
} from './format-github.js'
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
const PLAN: PublicationPlan = {
  comments: [P1, P2],
  stillOpen: [OPEN],
  dismissed: [],
  fixedAgain: [],
  fixedThreads: 0,
  openThreads: 1,
}

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
  return { comments, stillOpen, dismissed: [], fixedAgain: [], fixedThreads: 0, openThreads }
}

describe('formatGitHubReview body', () => {
  it('writes the score, summary, files, counts, worth checking, drops and marker', () => {
    expect(formatGitHubReview(RESULT, PLAN).body).toBe(
      [
        '## 🦋 3/5 (implementation issues)',
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
        MARKER,
      ].join('\n'),
    )
  })

  it('writes the CI summary right below the score, without changing the verdict', () => {
    const ci: CiSummary = {
      state: 'failing',
      total: 7,
      failing: ['test', 'lint'],
      pending: ['e2e'],
    }

    const lines = formatGitHubReview(RESULT, PLAN, undefined, messagesFor('en'), ci).body.split(
      '\n',
    )

    expect(lines.slice(0, 5)).toEqual([
      '## 🦋 3/5 (implementation issues)',
      '',
      'CI: 2 of 7 checks failing (test, lint) · 1 pending',
      '',
      '2 P1 findings (shop.ts:3, shop.ts:20)',
    ])
  })

  it.each<[CiSummary, string, string, string]>([
    [
      { state: 'failing', total: 1, failing: ['test'], pending: [] },
      'CI: 1 of 1 check failing (test)',
      'CI: 1 de 1 check falhando (test)',
      'CI: 1 de 1 check fallido (test)',
    ],
    [
      { state: 'pending', total: 3, failing: [], pending: ['e2e', 'deploy'] },
      'CI: 2 of 3 checks pending (e2e, deploy)',
      'CI: 2 de 3 checks pendentes (e2e, deploy)',
      'CI: 2 de 3 checks pendientes (e2e, deploy)',
    ],
    [
      { state: 'passing', total: 4, failing: [], pending: [] },
      'CI: all 4 checks passing',
      'CI: todos os 4 checks passando',
      'CI: todos los 4 checks aprobados',
    ],
    [
      { state: 'passing', total: 1, failing: [], pending: [] },
      'CI: 1 check passing',
      'CI: 1 check passando',
      'CI: 1 check aprobado',
    ],
    [
      { state: 'failing', total: 9, failing: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], pending: ['h'] },
      'CI: 7 of 9 checks failing (a, b, c, d, e, 2 more) · 1 pending',
      'CI: 7 de 9 checks falhando (a, b, c, d, e, 2 a mais) · 1 pendente',
      'CI: 7 de 9 checks fallidos (a, b, c, d, e, 2 más) · 1 pendiente',
    ],
  ])(
    'writes the CI line of %j in English, Portuguese and Spanish',
    (ci, english, portuguese, spanish) => {
      const line = (language: string) =>
        formatGitHubReview(RESULT, PLAN, undefined, messagesFor(language), ci).body
      expect(line('en')).toContain(`\n\n${english}\n\n`)
      expect(line('pt')).toContain(`\n\n${portuguese}\n\n`)
      expect(line('es')).toContain(`\n\n${spanish}\n\n`)
    },
  )

  it('escapes the names of the checks, which their authors chose', () => {
    const ci: CiSummary = { state: 'failing', total: 1, failing: ['<b>@team</b>'], pending: [] }

    const body = formatGitHubReview(RESULT, PLAN, undefined, messagesFor('en'), ci).body

    expect(body).toContain('CI: 1 of 1 check failing (\\<b>@\u200bteam\\</b>)')
  })

  it('writes nothing about CI without checks that count', () => {
    const none: CiSummary = { state: 'none', total: 0, failing: [], pending: [] }

    expect(formatGitHubReview(RESULT, PLAN, undefined, messagesFor('en'), none).body).toBe(
      formatGitHubReview(RESULT, PLAN).body,
    )
  })

  it('writes the CI line below the heading of the short note too', () => {
    const ci: CiSummary = { state: 'pending', total: 2, failing: [], pending: ['e2e'] }

    const body = formatGitHubReview(RESULT, plan([], [OPEN]), undefined, messagesFor('en'), ci).body

    expect(body.split('\n\n').slice(0, 2)).toEqual([
      '## 🦋 no new findings',
      'CI: 1 of 2 checks pending (e2e)',
    ])
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

  it('writes the fingerprint of the reviewed diff in the marker', () => {
    const target = { ...RESULT.target, diffFingerprint: '0123456789abcdef' }
    const full = formatGitHubReview(result({ target }), PLAN).body
    const short = formatGitHubReview(result({ target }), plan([], [OPEN])).body

    expect(parseReviewMarker(full)).toEqual({ sha: SHA, findings: 3, diff: '0123456789abcdef' })
    expect(parseReviewMarker(short)).toMatchObject({ diff: '0123456789abcdef' })
  })

  it('says how many comments from previous reviews were found fixed', () => {
    const fixed = { ...plan([P1]), fixedThreads: 2 }
    const onlyOpen = { ...plan([], [OPEN]), fixedThreads: 1 }

    expect(formatGitHubReview(RESULT, fixed).body).toContain(
      '2 comments from previous reviews are fixed in a1b2c3d.',
    )
    expect(formatGitHubReview(RESULT, onlyOpen).body).toContain(
      '1 comment from previous reviews is fixed in a1b2c3d.',
    )
    expect(formatGitHubReview(RESULT, plan([P1])).body).not.toContain('previous reviews is fixed')
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
        '## 🦋 no new findings',
        '',
        'No new problems in a1b2c3d. 6 comments from previous reviews are still open: resolve them to get a full review of this commit.',
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

    expect(body).toContain('## 🦋 nenhum problema novo')
    expect(body).toContain('1 comentário de revisões anteriores continua aberto: resolva-o')
  })

  it('uses a singular for one inline comment', () => {
    expect(formatGitHubReview(RESULT, plan([P1])).body).toContain('**1 P1 as inline comment**')
  })

  it('ends with the marker, without a footer naming Phada, the provider, the model or the verification', () => {
    for (const messages of [messagesFor('en'), messagesFor('pt'), messagesFor('es')]) {
      const { body } = formatGitHubReview(RESULT, PLAN, GITHUB_BODY_LIMIT, messages)

      expect(body.startsWith('## 🦋 3/5 (')).toBe(true)
      expect(body).not.toContain('Phada 🦋')
      expect(body).not.toContain('fake-cli')
      expect(body).not.toContain('claude-fake-1')
      expect(body).not.toContain('<sub>')
      expect(body.endsWith(`\n\n${MARKER}`)).toBe(true)
    }
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

  it('writes the whole review artifact in Brazilian Portuguese', () => {
    const review = formatGitHubReview(RESULT, PLAN, GITHUB_BODY_LIMIT, messagesFor('pt-BR'))

    expect(review.body).toContain('## 🦋 3/5 (problemas de implementação)')
    expect(review.body).toContain('### Resumo')
    expect(review.body).toContain('<details><summary>Arquivos (1)</summary>')
    expect(review.body).toContain('| Arquivo | Alteração | Problemas |')
    expect(review.body).toContain('### Ainda pendentes de revisões anteriores')
    expect(review.body).toContain('### Vale verificar (confiança abaixo de 60)')
    expect(review.comments[0]?.body).toContain('· confiança 90')
    expect(review.comments[0]?.body).toContain('**Correção sugerida:**')
    expect(review.body).not.toContain('### Summary')
    expect(review.body).not.toContain('(confidence ')
  })

  it('writes the whole review artifact in Spanish', () => {
    const ci: CiSummary = { state: 'failing', total: 3, failing: ['test'], pending: ['e2e'] }
    const review = formatGitHubReview(
      result({ dropped: { invalid: 0, belowFloor: 0, outsideDiff: 1, duplicate: 1, rejected: 0 } }),
      { ...PLAN, fixedThreads: 2 },
      GITHUB_BODY_LIMIT,
      messagesFor('es-MX'),
      ci,
    )

    expect(review.body).toBe(
      [
        '## 🦋 3/5 (problemas de implementación)',
        '',
        'CI: 1 de 3 checks fallido (test) · 1 pendiente',
        '',
        '2 hallazgos P1 (shop.ts:3, shop.ts:20)',
        '',
        '### Resumen',
        '',
        'Adds a spend endpoint.',
        '',
        '<details><summary>Archivos (1)</summary>',
        '',
        '| Archivo | Cambio | Hallazgos |',
        '| --- | --- | --- |',
        '| src/shop.ts | Adds spend | 2 |',
        '',
        '</details>',
        '',
        '**1 P1, 1 P2 como comentarios en línea** · 1 pendiente de revisiones anteriores',
        '',
        '2 comentarios de revisiones anteriores están corregidos en a1b2c3d.',
        '',
        '### Pendientes de revisiones anteriores',
        '',
        '- **P1** · src/shop.ts:20: Balance has no auth (confianza 90)',
        '',
        '### Vale la pena revisar (confianza por debajo de 60)',
        '',
        '- **P2** · src/shop.ts:15: Balance may be stale (confianza 55)',
        '',
        '2 descartados (1 fuera del diff, 1 duplicado)',
        '',
        MARKER,
      ].join('\n'),
    )
    expect(review.comments.map((comment) => comment.body)).toEqual([
      [
        '**P1** · spend has no auth · confianza 90',
        'Anyone can spend crystals for any user.',
        '**Corrección sugerida:** Use the authenticated user id.',
        '<!-- phada:finding -->',
      ].join('\n\n'),
      [
        '**P2** · Spend returns a stale balance · confianza 70',
        'The value is read before the update.',
        '<!-- phada:finding -->',
      ].join('\n\n'),
    ])
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

  describe('with a suggestion', () => {
    const one = { startLine: 3, endLine: 3, original: 'a', replacement: 'b(user.id)' }

    it('adds a suggestion block after the fix, anchored on the last line', () => {
      const [comment] = formatGitHubReview(
        RESULT,
        plan([findingFixture({ line: 3, suggestion: one })]),
      ).comments

      expect(comment).toEqual({
        path: 'src/shop.ts',
        line: 3,
        body: [
          '**P1** · spend has no auth · confidence 90',
          'Anyone can spend crystals for any user.',
          '**Fix:** Use the authenticated user id.',
          '```suggestion\nb(user.id)\n```',
          '<!-- phada:finding -->',
        ].join('\n\n'),
      })
    })

    it('publishes an empty block that deletes the lines and never adds a blank line', () => {
      const comment = (replacement: string) =>
        formatGitHubReview(
          RESULT,
          plan([findingFixture({ line: 3, suggestion: { ...one, replacement } })]),
        ).comments[0]?.body

      expect(comment('')).toContain('```suggestion\n```')
      expect(comment('b(user.id)\n')).toContain('```suggestion\nb(user.id)\n```')
      expect(comment('a\r\nb\r\n')).toContain('```suggestion\na\nb\n```')
    })

    it('starts a comment of several lines on the first line of the suggestion', () => {
      const several = { startLine: 2, endLine: 4, original: 'a\nb\nc', replacement: 'd' }
      const [comment] = formatGitHubReview(
        RESULT,
        plan([findingFixture({ line: 3, suggestion: several })]),
      ).comments

      expect(comment).toMatchObject({ path: 'src/shop.ts', startLine: 2, line: 4 })
    })

    it('uses a fence longer than any backtick run in the code', () => {
      const fenced = { ...one, replacement: 'const md = "```js"\nconst x = "````"' }
      const [comment] = formatGitHubReview(
        RESULT,
        plan([findingFixture({ line: 3, suggestion: fenced })]),
      ).comments

      expect(comment?.body).toContain(`\`\`\`\`\`suggestion\n${fenced.replacement}\n\`\`\`\`\``)
    })

    it('drops the suggestion when the comment cannot fit it', () => {
      const huge = { ...one, replacement: 'x'.repeat(600) }
      const [comment] = formatGitHubReview(
        RESULT,
        plan([findingFixture({ line: 3, suggestion: huge })]),
        500,
      ).comments

      expect(comment?.body.length).toBeLessThanOrEqual(500)
      expect(comment?.body).not.toContain('```suggestion')
      expect(comment).not.toHaveProperty('startLine')
      expect(comment?.line).toBe(3)
    })

    it('never shows a suggestion in the body of the review', () => {
      const suggested = findingFixture({ line: 20, title: 'Balance has no auth', suggestion: one })
      const { body } = formatGitHubReview(
        result({ worthChecking: [suggested] }),
        plan([], [suggested]),
      )

      expect(body).not.toContain('suggestion')
    })
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

  it('names a source in a related repository as owner/repo:path', () => {
    const crossing = findingFixture({ sources: ['acme/web:src/pages/invoice-page.ts:12'] })
    const [comment] = formatGitHubReview(RESULT, plan([crossing])).comments

    expect(comment?.body).toContain('<sub>Based on: `acme/web:src/pages/invoice-page.ts:12`</sub>')
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

describe('formatResolvedReply', () => {
  it('names the commit and escapes the reason of the AI', () => {
    expect(formatResolvedReply(SHA, 'Now checks @admin <b>auth</b>.')).toBe(
      'Fixed in `a1b2c3d`: Now checks @\u200badmin \\<b>auth\\</b>.',
    )
    expect(formatResolvedReply(SHA, 'Ok.', messagesFor('pt-BR'))).toBe(
      'Corrigido em `a1b2c3d`: Ok.',
    )
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

describe('formatIgnoredOnlyReview', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

  it('writes the fingerprint of the filtered diff in the marker', () => {
    const { body } = formatIgnoredOnlyReview(SHA, ['yarn.lock'], undefined, '0123456789abcdef')

    expect(parseReviewMarker(body)).toEqual({ sha: SHA, findings: 0, diff: '0123456789abcdef' })
  })

  it('posts a short note that names the files left out and counts zero findings', () => {
    expect(formatIgnoredOnlyReview(SHA, ['package-lock.json', 'app.min.js'])).toEqual({
      body: [
        '## 🦋 nothing to review',
        'Every changed file in a1b2c3d was left out of the review, so the AI did not look at this commit.',
        'Left out of the review: `package-lock.json` · `app.min.js`',
        `<!-- phada:review sha=${SHA} findings=0 -->`,
      ].join('\n\n'),
      comments: [],
    })
  })

  it('writes the note in the language of the review', () => {
    const { body } = formatIgnoredOnlyReview(SHA, ['yarn.lock'], messagesFor('pt-BR'))

    expect(body).toContain('## 🦋 nada para revisar')
    expect(body).toContain('Todos os arquivos alterados em a1b2c3d ficaram fora do review')
    expect(body).toContain('Fora do review: `yarn.lock`')
  })
})

describe('formatGitHubReview with native skills', () => {
  const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`

  it('puts the output of a skill that anchored nothing in the body', () => {
    const body = formatGitHubReview(
      {
        ...RESULT,
        skillBodies: [
          { skill: 'code-review:code-review', text: '### Code review\nNo issues found.' },
        ],
      },
      PLAN,
    ).body

    expect(body).toContain(
      '**Review by skill code-review:code-review**\n\n\\### Code review\nNo issues found.',
    )
  })

  it('labels the body of each skill', () => {
    const body = formatGitHubReview(
      {
        ...RESULT,
        skillBodies: [
          { skill: 'a', text: 'From a.' },
          { skill: 'b', text: 'From b.' },
        ],
      },
      PLAN,
    ).body

    expect(body).toContain('**Review by skill a**\n\nFrom a.\n\n**Review by skill b**\n\nFrom b.')
  })

  it('writes the label in the review language', () => {
    const body = formatGitHubReview(
      { ...RESULT, skillBodies: [{ skill: 'x', text: 'Sem problemas.' }] },
      PLAN,
      undefined,
      messagesFor('pt-BR'),
    ).body

    expect(body).toContain('**Revisão da skill x**')
  })

  it('never publishes a token the AI wrote', () => {
    const leaking = findingFixture({ line: 3, why: `The token ${TOKEN} is in the code.` })
    const review = formatGitHubReview(
      {
        ...RESULT,
        summary: `Summary ${TOKEN}`,
        findings: [leaking],
        skillBodies: [{ skill: 'x', text: `Posted ${TOKEN}` }],
      },
      plan([leaking]),
    )

    expect(review.body).not.toContain(TOKEN)
    expect(review.body).toContain('[REDACTED]')
    expect(review.comments.every((comment) => !comment.body.includes(TOKEN))).toBe(true)
    expect(formatResolvedReply(SHA, `fixed ${TOKEN}`, messagesFor(undefined))).not.toContain(TOKEN)
  })
})
