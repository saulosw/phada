import { describe, expect, it } from 'vitest'
import {
  FINDING_MARKER,
  findingMarker,
  hasFindingMarker,
  hasResolvedMarker,
  parseReviewMarker,
  resolvedMarker,
  reviewMarker,
} from './markers.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describe('reviewMarker', () => {
  it('writes the reviewed commit and the number of findings', () => {
    expect(reviewMarker({ sha: SHA, findings: 2 })).toBe(
      `<!-- phada:review sha=${SHA} findings=2 -->`,
    )
  })

  it('writes the fingerprint of the diff when there is one', () => {
    expect(reviewMarker({ sha: SHA, findings: 2, diff: '0123456789abcdef' })).toBe(
      `<!-- phada:review sha=${SHA} findings=2 diff=0123456789abcdef -->`,
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

  it('reads the fingerprint of the diff', () => {
    expect(
      parseReviewMarker(`<!-- phada:review sha=${SHA} findings=1 diff=0123456789abcdef -->`),
    ).toEqual({ sha: SHA, findings: 1, diff: '0123456789abcdef' })
  })

  it.each([
    ['a short fingerprint', `<!-- phada:review sha=${SHA} findings=0 diff=0123 -->`],
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

  it('finds the marker that names the skill of the finding', () => {
    expect(hasFindingMarker(`Title\n\n${findingMarker('code-review:code-review')}`)).toBe(true)
    expect(hasFindingMarker(`\`${findingMarker('x')}\` quoted`)).toBe(false)
  })
})

describe('findingMarker', () => {
  it('names the skill of the finding, hidden from the reader', () => {
    expect(findingMarker('code-review:code-review')).toBe(
      '<!-- phada:finding skill=code-review:code-review -->',
    )
  })

  it('is the plain marker for a finding of the built-in review', () => {
    expect(findingMarker(undefined)).toBe(FINDING_MARKER)
  })

  it('encodes a skill name that could close the comment early', () => {
    expect(findingMarker('a --> b')).toBe('<!-- phada:finding skill=a%20--%3E%20b -->')
  })
})

describe('resolvedMarker', () => {
  it('writes the commit the thread was found fixed in and is read back only at the end', () => {
    expect(resolvedMarker(SHA)).toBe(`<!-- phada:resolved sha=${SHA} -->`)
    expect(hasResolvedMarker(`Fixed in \`a1b2c3d\`.\n\n${resolvedMarker(SHA)}\n`)).toBe(true)
    expect(hasResolvedMarker(`\`${resolvedMarker(SHA)}\` quoted`)).toBe(false)
  })
})
