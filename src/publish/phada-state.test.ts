import { describe, expect, it } from 'vitest'
import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import { FINDING_MARKER, resolvedMarker } from './markers.js'
import { resolvedByPhada } from './phada-state.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const STATE: PullRequestReviewState = { viewer: 'me', reviews: [], threads: [] }

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    isResolved: true,
    path: 'src/shop.ts',
    line: 3,
    author: 'me',
    body: `**P1** · Title · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
    reviewId: 'R1',
    replies: [{ author: 'me', body: `Fixed in \`a1b2c3d\`: ok.\n\n${resolvedMarker(SHA)}` }],
    ...overrides,
  }
}

describe('resolvedByPhada', () => {
  it('is true for a resolved thread with a reply of the viewer that ends in the marker', () => {
    expect(resolvedByPhada(STATE, thread())).toBe(true)
  })

  it('is false once the thread is open again', () => {
    expect(resolvedByPhada(STATE, thread({ isResolved: false }))).toBe(false)
  })

  it('is false when the marker comes from someone else or is quoted', () => {
    const quoted = { author: 'me', body: `\`${resolvedMarker(SHA)}\` was here` }

    expect(
      resolvedByPhada(STATE, thread({ replies: [{ ...thread().replies[0]!, author: 'x' }] })),
    ).toBe(false)
    expect(resolvedByPhada(STATE, thread({ replies: [quoted] }))).toBe(false)
  })
})
