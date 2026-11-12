import { describe, expect, it } from 'vitest'
import { readStoredRun, titledFindings } from './stored-run.js'

const SHA = 'a'.repeat(40)
const TOKENS = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 }

const FINDING = {
  severity: 'P1',
  confidence: 90,
  file: 'src/a.ts',
  line: 3,
  title: 'Off by one',
  why: 'The loop skips the last item.',
  fix: 'Use <=.',
  rule: 'loops',
  existing: null,
  sources: ['rule:loops'],
  reason: null,
  suggestion: { startLine: 3, endLine: 3, original: 'i < n', replacement: 'i <= n' },
  skill: 'phada',
  scope: 'change',
  closeToCut: false,
}

const DOCUMENT = {
  schemaVersion: 1,
  status: 'reviewed',
  verdict: 'comments',
  pullRequest: {
    repo: 'acme/shop',
    number: 3,
    url: 'https://github.com/acme/shop/pull/3',
    title: 'Add the cart',
    headSha: SHA,
    state: 'open',
    draft: false,
  },
  review: {
    score: { value: 4, reason: 'One P1.' },
    coverage: {
      level: 'full',
      covered: 2,
      total: 2,
      declaredOnly: 0,
      skipped: 0,
      gaps: [],
      verified: true,
      reason: 'Every file was read.',
      continuation: null,
    },
    summary: 'Adds the cart.',
    claims: [{ claim: 'Adds a cart', verdict: 'confirmed', evidence: 'src/a.ts' }],
    findings: [FINDING],
    debt: [{ ...FINDING, title: 'Old loop', scope: 'repository' }],
    worthChecking: [{ ...FINDING, title: 'Maybe', suggestion: null }],
    minConfidence: 70,
    passes: [
      {
        skill: 'phada',
        origin: 'builtin',
        status: 'reviewed',
        mode: 'text',
        durationMs: 1200,
        usage: TOKENS,
        findings: 1,
        reason: null,
        output: null,
        captured: null,
        blocked: [{ tool: 'Bash', input: 'npm test', fix: 'allow npm test' }],
      },
    ],
    groups: [
      {
        label: 'src/',
        files: ['src/a.ts'],
        bytes: 900,
        link: 'directory',
        findings: 1,
        durationMs: 800,
        usage: TOKENS,
        failed: false,
      },
    ],
    usage: TOKENS,
  },
  publication: {
    status: 'dry-run',
    body: 'One finding.',
    comments: [{ path: 'src/a.ts', line: 3, body: 'Off by one' }],
    stillOpen: 0,
    dismissed: 0,
    wouldSkip: { reason: 'same-diff', openThreads: 0, since: SHA },
    wouldResolve: [{ threadId: 'T1' }],
  },
  context: null,
  conversation: null,
  ci: {
    state: 'failing',
    total: 2,
    failing: ['test'],
    pending: [],
    checks: [
      { name: 'build', state: 'passing', conclusion: 'success', annotations: 0, logBytes: null },
      { name: 'test', state: 'failing', conclusion: 'failure', annotations: 1, logBytes: 80 },
    ],
    annotations: { sent: 1, omitted: 0, limit: 50 },
    logs: { sent: 1, omitted: 0, limit: 20000 },
    truncated: 0,
    bytes: 300,
    warnings: [],
  },
  investigation: null,
  impact: null,
  related: null,
  usage: {
    passes: [{ pass: 'review', skill: 'phada', group: null, usage: TOKENS }],
    total: TOKENS,
  },
  publishedFrom: 5,
}

const EMPTY = {
  document: undefined,
  status: null,
  pullRequest: null,
  localTitle: null,
  publishedFrom: null,
  review: null,
  publication: null,
  ci: null,
  everyCiCheckRead: false,
  ciBlock: undefined,
  context: undefined,
  conversation: undefined,
  impact: undefined,
  related: undefined,
  investigation: undefined,
  usage: null,
}

describe('readStoredRun', () => {
  it('reads nothing from a run without a stored document', () => {
    expect(readStoredRun(undefined)).toEqual(EMPTY)
  })

  it('reads nothing from a document that is not JSON', () => {
    expect(readStoredRun('{')).toEqual(EMPTY)
  })

  it('keeps a document that is not an object, and reads no field from it', () => {
    expect(readStoredRun('[1]')).toEqual({ ...EMPTY, document: [1] })
  })

  it('reads every block of a full document', () => {
    const stored = readStoredRun(JSON.stringify(DOCUMENT))

    expect(stored.document).toEqual(DOCUMENT)
    expect(stored.status).toBe('reviewed')
    expect(stored.pullRequest).toEqual({
      url: 'https://github.com/acme/shop/pull/3',
      title: 'Add the cart',
    })
    expect(stored.publishedFrom).toBe(5)
    expect(stored.review?.score).toEqual({ value: 4, reason: 'One P1.' })
    expect(stored.review?.coverage?.level).toBe('full')
    expect(stored.review?.summary).toBe('Adds the cart.')
    expect(stored.review?.claims).toEqual([
      { claim: 'Adds a cart', verdict: 'confirmed', evidence: 'src/a.ts' },
    ])
    expect(stored.review?.findings).toEqual([
      {
        severity: 'P1',
        confidence: 90,
        file: 'src/a.ts',
        line: 3,
        title: 'Off by one',
        why: 'The loop skips the last item.',
        fix: 'Use <=.',
        rule: 'loops',
        skill: 'phada',
        sources: ['rule:loops'],
        scope: 'change',
        closeToCut: false,
        suggestion: { startLine: 3, endLine: 3, original: 'i < n', replacement: 'i <= n' },
      },
    ])
    expect(stored.review?.debt?.[0]).toMatchObject({ title: 'Old loop', scope: 'repository' })
    expect(stored.review?.worthChecking?.[0]?.title).toBe('Maybe')
    expect(stored.review?.minConfidence).toBe(70)
    expect(stored.review?.closeToCutMarked).toBe(true)
    expect(stored.review?.passes?.reports).toEqual([
      {
        skill: 'phada',
        origin: 'builtin',
        status: 'reviewed',
        durationMs: 1200,
        usage: TOKENS,
        findings: 1,
        blocked: [{ tool: 'Bash', input: 'npm test' }],
      },
    ])
    expect([...(stored.review?.passes?.fixes.values() ?? [])]).toEqual(['allow npm test'])
    expect(stored.review?.groups).toEqual([
      {
        label: 'src/',
        files: ['src/a.ts'],
        bytes: 900,
        link: 'directory',
        findings: 1,
        durationMs: 800,
        usage: TOKENS,
      },
    ])
    expect(stored.review?.usage).toEqual({ input: 100, cached: 40, output: 20 })
    expect(stored.publication).toEqual({
      status: 'dry-run',
      url: null,
      comments: 1,
      wouldResolve: 1,
      reason: 'same-diff',
      posted: {
        body: 'One finding.',
        comments: [{ path: 'src/a.ts', line: 3, body: 'Off by one' }],
      },
    })
    expect(stored.ci).toEqual({
      state: 'failing',
      failing: ['test'],
      pending: [],
      checks: [
        { name: 'build', state: 'passing' },
        { name: 'test', state: 'failing' },
      ],
    })
    expect(stored.everyCiCheckRead).toBe(true)
    expect(stored.ciBlock?.checks).toHaveLength(2)
    expect(stored.context).toBeNull()
    expect(stored.conversation).toBeNull()
    expect(stored.investigation).toBeNull()
    expect(stored.impact).toBeNull()
    expect(stored.related).toBeNull()
    expect(stored.usage).toEqual({
      passes: [
        {
          pass: 'review',
          skill: 'phada',
          group: null,
          tokens: { input: 100, cached: 40, output: 20 },
        },
      ],
      total: { input: 100, cached: 40, output: 20 },
    })
  })

  it('reads an older document with what it has, leaving the newer fields empty', () => {
    const older = {
      local: { title: 'Local changes' },
      review: { findings: [{ file: 'src/a.ts', title: 'Off by one', line: 3 }] },
      publication: { status: 'published', url: 'https://github.com/acme/shop/pull/3', comments: 2 },
    }

    const stored = readStoredRun(JSON.stringify(older))

    expect(stored.pullRequest).toBeNull()
    expect(stored.localTitle).toBe('Local changes')
    expect(stored.review).toEqual({
      score: { value: null, reason: null },
      coverage: null,
      summary: null,
      claims: null,
      findings: [
        {
          severity: null,
          confidence: null,
          file: 'src/a.ts',
          line: 3,
          title: 'Off by one',
          why: null,
          fix: null,
          rule: null,
          skill: null,
          sources: [],
          scope: 'change',
          closeToCut: false,
        },
      ],
      closeToCutMarked: false,
      minConfidence: null,
      debt: null,
      worthChecking: null,
      groups: null,
      passes: null,
      usage: null,
    })
    expect(stored.publication).toEqual({
      status: 'published',
      url: 'https://github.com/acme/shop/pull/3',
      comments: 2,
      wouldResolve: null,
      reason: null,
      posted: null,
    })
    expect(stored.ciBlock).toBeUndefined()
    expect(stored.usage).toBeNull()
  })

  it('keeps a finding without a title and leaves out one without a file or that is not an object', () => {
    const findings = [{ file: 'src/a.ts', line: 3 }, { title: 'No file' }, 'not a finding']

    const stored = readStoredRun(JSON.stringify({ review: { findings } }))

    expect(stored.review?.findings?.map(({ file, title }) => ({ file, title }))).toEqual([
      { file: 'src/a.ts', title: null },
    ])
    expect(stored.review?.closeToCutMarked).toBe(false)
  })

  it('keeps a stored suggestion with its four fields only', () => {
    const suggestion = { startLine: 3, endLine: 4, original: 'a', replacement: 'b' }
    const findings = [{ ...FINDING, suggestion: { ...suggestion, extra: true } }]

    const [finding] = readStoredRun(JSON.stringify({ review: { findings } })).review?.findings ?? []

    expect(finding?.suggestion).toEqual(suggestion)
  })

  it.each([
    ['null', null],
    ['missing a field', { startLine: 3, endLine: 4, original: 'a' }],
    ['a field of the wrong type', { startLine: '3', endLine: 4, original: 'a', replacement: 'b' }],
    ['not an object', 'replace a with b'],
  ])('leaves out a suggestion that is %s', (_case, suggestion) => {
    const findings = [{ ...FINDING, suggestion }]

    const [finding] = readStoredRun(JSON.stringify({ review: { findings } })).review?.findings ?? []

    expect(finding).toBeDefined()
    expect(finding).not.toHaveProperty('suggestion')
  })

  it('tells a pull request block it cannot read from a missing one', () => {
    expect(readStoredRun(JSON.stringify({ pullRequest: 'acme/shop#3' })).pullRequest).toEqual({
      url: null,
      title: null,
    })
    expect(readStoredRun(JSON.stringify({ pullRequest: null })).pullRequest).toBeNull()
  })

  it('reads the checks it can of a CI block and says when it left one out', () => {
    const ci = {
      state: 'pending',
      failing: 'test',
      checks: [{ name: 'e2e', state: 'pending' }, { name: 1 }],
    }

    const stored = readStoredRun(JSON.stringify({ ci }))

    expect(stored.ci).toEqual({
      state: 'pending',
      failing: [],
      pending: [],
      checks: [{ name: 'e2e', state: 'pending' }],
    })
    expect(stored.everyCiCheckRead).toBe(false)
    expect(stored.ciBlock).toBeUndefined()
  })

  it('reads a block stored as null as null, and one it cannot read as missing', () => {
    const stored = readStoredRun(JSON.stringify({ context: null, conversation: 'none' }))

    expect(stored.context).toBeNull()
    expect(stored.conversation).toBeUndefined()
    expect(stored.impact).toBeUndefined()
  })

  it('reads no passes when one of them cannot be read', () => {
    const passes = [{ skill: 'phada', origin: 'builtin', status: 'unknown' }]

    expect(readStoredRun(JSON.stringify({ review: { passes } })).review?.passes).toBeNull()
  })

  it('reads the usage of a review stored before the usage block', () => {
    const stored = readStoredRun(JSON.stringify({ review: { usage: TOKENS } }))

    expect(stored.usage).toBeNull()
    expect(stored.review?.usage).toEqual({ input: 100, cached: 40, output: 20 })
  })
})

describe('titledFindings', () => {
  it('keeps the findings that have a title', () => {
    const findings = readStoredRun(
      JSON.stringify({ review: { findings: [FINDING, { file: 'src/b.ts', line: 1 }] } }),
    ).review?.findings

    expect(titledFindings(findings ?? []).map(({ file, title }) => ({ file, title }))).toEqual([
      { file: 'src/a.ts', title: 'Off by one' },
    ])
  })
})
