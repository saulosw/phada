import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount, formatDuration, formatElapsed, formatTokens } from './units.js'

describe('units', () => {
  it.each([
    [420, '0.4s'],
    [42_149, '42.1s'],
    [59_940, '59.9s'],
    [59_960, '1m00s'],
    [60_000, '1m00s'],
    [131_400, '2m11s'],
  ])('formats a duration of %i ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it.each([
    [999, '0s'],
    [15_000, '15s'],
    [75_500, '1m15s'],
  ])('formats an elapsed time of %i ms as %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })

  it.each([
    [950, '950'],
    [1000, '1.0k'],
    [41_234, '41.2k'],
    [999_949, '999.9k'],
    [999_960, '1.0M'],
    [1_234_567, '1.2M'],
  ])('formats %i tokens as %s', (count, expected) => {
    expect(formatTokens(count)).toBe(expected)
  })

  it.each([
    [812, '812 B'],
    [1024, '1.0 KB'],
    [65_741, '64.2 KB'],
    [1_048_524, '1023.9 KB'],
    [1_048_575, '1.0 MB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it.each([
    [0, '0 files'],
    [1, '1 file'],
    [33, '33 files'],
  ])('counts %i files as %s', (count, expected) => {
    expect(formatCount(count, 'file')).toBe(expected)
  })
})
