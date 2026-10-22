import { describe, expect, it } from 'vitest'
import { DURATION, durationMs } from './duration.js'

describe('durationMs', () => {
  it.each([
    ['90s', 90_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['30d', 2_592_000_000],
  ])('reads %s', (text, ms) => {
    expect(DURATION.test(text)).toBe(true)
    expect(durationMs(text)).toBe(ms)
  })

  it('refuses other units', () => {
    expect(DURATION.test('1y')).toBe(false)
  })
})
