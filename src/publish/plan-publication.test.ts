import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import { FINDING_MARKER } from './markers.js'
import { normalizeTitle, planPublication } from './plan-publication.js'

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    isResolved: false,
    path: 'src/shop.ts',
    line: 10,
    author: 'me',
    body: `**P1** · Spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
    reviewId: 'R1',
    ...overrides,
  }
}

function state(threads: ReviewThread[]): PullRequestReviewState {
  return { viewer: 'me', reviews: [], threads }
}

describe('planPublication', () => {
  it('posts every finding when there is no open Phada thread', () => {
    const findings = [findingFixture({ line: 10 }), findingFixture({ line: 20 })]

    expect(planPublication(findings, state([]))).toEqual({
      comments: findings,
      stillOpen: [],
      openThreads: 0,
    })
  })

  it('keeps a finding within 3 lines of an open thread in the same file as still open', () => {
    const near = findingFixture({ line: 13, title: 'Other problem' })
    const far = findingFixture({ line: 14, title: 'Other problem' })

    expect(planPublication([near, far], state([thread()]))).toEqual({
      comments: [far],
      stillOpen: [near],
      openThreads: 1,
    })
  })

  it('matches the same title anywhere in the file, ignoring case, punctuation and escapes', () => {
    const moved = findingFixture({ line: 40, title: 'spend has NO \\<auth>!' })

    expect(planPublication([moved], state([thread()])).stillOpen).toEqual([moved])
  })

  it('matches the title of a thread published in another language', () => {
    const portuguese = thread({
      line: null,
      body: `**P1** · Spend has no auth · confiança 90\n\nPor quê.\n\n${FINDING_MARKER}`,
    })
    const same = findingFixture({ line: 40, title: 'Spend has no auth' })

    expect(planPublication([same], state([portuguese])).stillOpen).toEqual([same])
  })

  it('posts a finding of another file even with the same line and title', () => {
    const other = findingFixture({ file: 'src/db.ts', line: 10, title: 'Spend has no auth' })

    expect(planPublication([other], state([thread()])).comments).toEqual([other])
  })

  it('ignores resolved threads', () => {
    const finding = findingFixture({ line: 10, title: 'Spend has no auth' })

    expect(planPublication([finding], state([thread({ isResolved: true })])).comments).toEqual([
      finding,
    ])
  })

  it('ignores threads written by someone else or without the marker', () => {
    const finding = findingFixture({ line: 10 })
    const threads = [thread({ author: 'mallory' }), thread({ body: 'A human comment' })]

    expect(planPublication([finding], state(threads)).comments).toEqual([finding])
  })

  it('matches an outdated thread only by title', () => {
    const outdated = thread({ line: null })
    const same = findingFixture({ line: 10, title: 'Spend has no auth' })
    const other = findingFixture({ line: 10, title: 'Balance is stale' })

    expect(planPublication([same, other], state([outdated]))).toEqual({
      comments: [other],
      stillOpen: [same],
      openThreads: 1,
    })
  })

  it('matches by line only when the first line of the thread is not a Phada title', () => {
    const odd = thread({ body: `Spend has no auth\n\n${FINDING_MARKER}` })
    const sameTitleFar = findingFixture({ line: 40, title: 'Spend has no auth' })
    const near = findingFixture({ line: 11, title: 'Anything' })

    expect(planPublication([sameTitleFar, near], state([odd]))).toEqual({
      comments: [sameTitleFar],
      stillOpen: [near],
      openThreads: 1,
    })
  })

  it('keeps the order of the findings in both lists', () => {
    const findings = [
      findingFixture({ line: 30, title: 'A' }),
      findingFixture({ line: 9, title: 'B' }),
      findingFixture({ line: 50, title: 'C' }),
      findingFixture({ line: 11, title: 'D' }),
    ]

    const plan = planPublication(findings, state([thread()]))

    expect(plan.comments.map(({ title }) => title)).toEqual(['A', 'C'])
    expect(plan.stillOpen.map(({ title }) => title)).toEqual(['B', 'D'])
  })
})

describe('planPublication open threads', () => {
  it('counts every open Phada thread, whether or not a finding matches it', () => {
    const threads = [thread(), thread({ path: 'src/other.ts' }), thread({ isResolved: true })]

    expect(planPublication([], state(threads)).openThreads).toBe(2)
  })
})

describe('normalizeTitle', () => {
  it('keeps only lower-case letters and digits', () => {
    expect(normalizeTitle('Spend @\u200buser <b>!')).toBe('spenduserb')
    expect(normalizeTitle('Ação nº 2')).toBe('açãonº2')
  })
})
