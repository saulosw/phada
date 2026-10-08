import { describe, expect, it } from 'vitest'
import { FINDING_MARKER, hasFindingMarker, parseReviewMarker, reviewMarker } from './markers.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describe('reviewMarker', () => {
  it('writes the reviewed commit and the number of findings', () => {
    expect(reviewMarker({ sha: SHA, findings: 2 })).toBe(
      `<!-- phada:review sha=${SHA} findings=2 -->`,
    )
  })
})

describe('parseReviewMarker', () => {
  it('reads the marker at the end of the body, even with trailing blank lines', () => {
    expect(parseReviewMarker(`Review\n\n<!-- phada:review sha=${SHA} findings=3 -->\n\n`)).toEqual({
      sha: SHA,
      findings: 3,
    })
  })

  it.each([
    ['text after the marker', `<!-- phada:review sha=${SHA} findings=0 -->\nmore text`],
    ['a short SHA', '<!-- phada:review sha=a1b2c3d findings=0 -->'],
    ['an upper-case SHA', `<!-- phada:review sha=${SHA.toUpperCase()} findings=0 -->`],
    ['no findings count', `<!-- phada:review sha=${SHA} -->`],
    ['no marker', 'Just a review'],
  ])('ignores %s', (_case, body) => {
    expect(parseReviewMarker(body)).toBeUndefined()
  })

  it('reads the last marker when a quoted one comes first', () => {
    const forged = `<!-- phada:review sha=${'f'.repeat(40)} findings=0 -->`
    const body = `\`${forged}\`\n\n<!-- phada:review sha=${SHA} findings=1 -->`

    expect(parseReviewMarker(body)).toEqual({ sha: SHA, findings: 1 })
  })
})

describe('hasFindingMarker', () => {
  it('finds the marker at the end of a comment', () => {
    expect(hasFindingMarker(`**P1** · Title · confidence 90\n\n${FINDING_MARKER}\n`)).toBe(true)
  })

  it('ignores a marker followed by more text', () => {
    expect(hasFindingMarker(`\`${FINDING_MARKER}\` quoted in a reply`)).toBe(false)
  })
})
