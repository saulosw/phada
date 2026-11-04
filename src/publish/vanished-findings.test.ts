import { describe, expect, it } from 'vitest'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type { ComparedFile } from '../github/compare-commits.js'
import { FINDING_MARKER } from './markers.js'
import {
  comparisonKey,
  decideVanished,
  vanishedComparisons,
  vanishedElementSites,
} from './vanished-findings.js'
import type { FindingRun, VanishedInput } from './vanished-findings.js'

const FOUND_AT = 'f'.repeat(40)
const HEAD = 'h'.repeat(40)
const PULL = { repo: 'acme/shop', number: 3 }

const timeout = {
  file: 'README.md',
  line: 40,
  title: 'The invoke never times out',
  body: 'aws lambda invoke waits forever without --cli-read-timeout.',
}

function run(overrides: Partial<FindingRun> = {}): FindingRun {
  return {
    id: 4,
    headSha: FOUND_AT,
    source: 'replay',
    finishedAt: '2026-11-01T10:00:00Z',
    findings: [timeout],
    ...overrides,
  }
}

const lost = run({
  id: 7,
  headSha: HEAD,
  source: 'manual',
  finishedAt: '2026-11-02T10:00:00Z',
  findings: [],
})

function vanished(
  overrides: Partial<VanishedInput> = {},
  files: readonly ComparedFile[] | 'unavailable' = [],
) {
  return decideVanished({
    ...PULL,
    runs: [run(), lost],
    state: reviewState(),
    known: new Set(),
    comparisons: new Map([[comparisonKey(FOUND_AT, HEAD), files]]),
    ...overrides,
  })
}

describe('decideVanished', () => {
  it('keeps as a miss a finding of a replay that the later real review lost on a file the commits did not touch', () => {
    expect(vanished()).toEqual([
      {
        key: 'phada:4:README.md:theinvokenevertimesout',
        origin: 'phada',
        seen: 'missed-live',
        repo: 'acme/shop',
        number: 3,
        reviewedSha: HEAD,
        commitSha: HEAD,
        file: 'README.md',
        line: 40,
        author: 'phada',
        body: 'The invoke never times out\n\naws lambda invoke waits forever without --cli-read-timeout.',
        createdAt: '2026-11-02T10:00:00Z',
      },
    ])
  })

  function patched(patch: string): ComparedFile[] {
    return [{ path: 'README.md', status: 'modified', patch }]
  }

  it('moves the line by the hunks above the window', () => {
    expect(vanished({}, patched('@@ -10,3 +10,5 @@\n a\n+b\n+c\n d\n e'))).toEqual([
      expect.objectContaining({ file: 'README.md', line: 42 }),
    ])
  })

  it('finds the finding kept by the later review inside the window moved by the hunks above', () => {
    const kept = (line: number) =>
      vanished(
        { runs: [run(), { ...lost, findings: [{ ...timeout, title: 'Other words', line }] }] },
        patched('@@ -10,3 +10,5 @@'),
      )

    expect(kept(47)).toEqual([])
    expect(kept(36)).toEqual([expect.objectContaining({ line: 42 })])
  })

  it('keeps the miss when the later review found something else in the file, away from it', () => {
    const elsewhere = { ...lost, findings: [{ ...timeout, title: 'Another one', line: 80 }] }

    expect(vanished({ runs: [run(), elsewhere] })).toHaveLength(1)
  })

  it.each([
    ['ends right above the window', '@@ -30,5 +30,6 @@', 41],
    ['starts right below the window', '@@ -46,2 +46,1 @@', 40],
    ['inserts right before the window', '@@ -34,0 +35,2 @@', 42],
    ['inserts right after the window', '@@ -45,0 +46,2 @@', 40],
    ['inserts at the top of the file', '@@ -0,0 +1,3 @@', 43],
    ['changes one line far above, without a count', '@@ -3 +3,2 @@', 41],
  ])('keeps the miss when a hunk %s', (_case, header, line) => {
    expect(vanished({}, patched(header))).toEqual([expect.objectContaining({ line })])
  })

  it.each([
    ['ends on the first line of the window', '@@ -30,6 +30,6 @@'],
    ['starts on the last line of the window', '@@ -45,2 +45,2 @@'],
    ['inserts inside the window', '@@ -35,0 +36,1 @@'],
    ['inserts before the last line of the window', '@@ -44,0 +45,1 @@'],
    ['changes the line itself', '@@ -40 +40 @@'],
  ])('finds nothing when a hunk %s', (_case, header) => {
    expect(vanished({}, patched(header))).toEqual([])
  })

  it('takes the window from the code element that holds the finding at the commit that found it', () => {
    const elementsAt = (commitSha: string, file: string) =>
      commitSha === FOUND_AT && file === 'README.md' ? [{ startLine: 30, endLine: 60 }] : undefined

    expect(vanished({ elementsAt }, patched('@@ -55,2 +55,3 @@'))).toEqual([])
    expect(vanished({ elementsAt }, patched('@@ -61,2 +61,3 @@'))).toHaveLength(1)
  })

  it.each<[string, ComparedFile]>([
    ['renamed', { path: 'docs/README.md', previousPath: 'README.md', status: 'renamed' }],
    ['removed', { path: 'README.md', status: 'removed', patch: '@@ -1,90 +0,0 @@' }],
    ['changed without a patch', { path: 'README.md', status: 'modified' }],
  ])('finds nothing when the file was %s', (_case, file) => {
    expect(vanished({}, [file])).toEqual([])
  })

  it('finds nothing when the commits cannot be compared', () => {
    expect(vanished({}, 'unavailable')).toEqual([])
    expect(vanished({ comparisons: new Map() })).toEqual([])
  })

  it('finds nothing for a finding Phada published as a thread, by its title or near its line', () => {
    const thread = (title: string, line: number) =>
      reviewState({
        threads: [
          reviewThread({
            path: 'README.md',
            line,
            body: `**P2** · ${title} · confidence 68\n\nWhy.\n\n${FINDING_MARKER}`,
          }),
        ],
      })

    expect(vanished({ state: thread('The invoke never times out', 90) })).toEqual([])
    expect(vanished({ state: thread('Another title', 44) })).toEqual([])
    expect(vanished({ state: thread('Another title', 90) })).toHaveLength(1)
  })

  it('finds nothing for a finding already recorded as a miss, from that run or another', () => {
    expect(vanished({ known: new Set(['phada:4:README.md:theinvokenevertimesout']) })).toEqual([])
    expect(vanished({ known: new Set(['phada:2:README.md:theinvokenevertimesout']) })).toEqual([])
    expect(vanished({ known: new Set(['PRRT_1']) })).toHaveLength(1)
  })

  it('keeps one miss for a finding that several runs found, from the first of them', () => {
    const again = run({ id: 5, finishedAt: '2026-11-01T11:00:00Z' })

    expect(vanished({ runs: [again, run(), lost] })).toEqual([
      expect.objectContaining({ key: 'phada:4:README.md:theinvokenevertimesout' }),
    ])
  })

  it('takes a live run that found it and a later live run at another commit that lost it', () => {
    const live = run({ source: 'watch' })

    expect(vanished({ runs: [live, lost] })).toEqual([
      expect.objectContaining({ commitSha: HEAD, createdAt: lost.finishedAt }),
    ])
  })

  it('finds nothing for a live run with no later real review at another commit', () => {
    const live = run({ source: 'watch', finishedAt: '2026-11-03T10:00:00Z' })

    expect(vanished({ runs: [lost, live] })).toEqual([])
    expect(vanished({ runs: [run({ source: 'manual' }), { ...lost, headSha: FOUND_AT }] })).toEqual(
      [],
    )
  })

  it('judges by the latest real review, never by a replay', () => {
    const middle = 'm'.repeat(40)
    const earlier = { ...lost, id: 6, headSha: middle, finishedAt: '2026-11-01T12:00:00Z' }
    const keeps = { ...lost, findings: [timeout] }
    const replayAtHead = { ...lost, id: 8, source: 'replay' as const, findings: [] }

    expect(vanished({ runs: [run(), earlier, keeps] })).toEqual([])
    expect(vanished({ runs: [run(), keeps, replayAtHead] })).toEqual([])
  })

  it('asks for the code elements and the comparisons only of the findings left to decide', () => {
    const input = {
      ...PULL,
      runs: [run({ findings: [timeout, { ...timeout, title: 'Known one', line: 9 }] }), lost],
      state: reviewState(),
      known: new Set(['phada:4:README.md:knownone']),
    }
    const published = {
      ...input,
      state: reviewState({
        threads: [
          reviewThread({
            path: 'README.md',
            line: 41,
            body: `**P2** · Something · confidence 70\n\nWhy.\n\n${FINDING_MARKER}`,
          }),
        ],
      }),
    }

    expect(vanishedElementSites(input)).toEqual([{ commitSha: FOUND_AT, file: 'README.md' }])
    expect(vanishedComparisons(input)).toEqual([{ base: FOUND_AT, head: HEAD }])
    expect(vanishedComparisons(published)).toEqual([])
    expect(vanishedElementSites({ ...input, runs: [run()] })).toEqual([])
  })
})
