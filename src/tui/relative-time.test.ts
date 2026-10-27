import { describe, expect, it } from 'vitest'
import { uiMessagesFor } from './i18n/messages.js'
import { absoluteTime, relativeTime } from './relative-time.js'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000).toISOString()

describe('relativeTime', () => {
  const en = uiMessagesFor('en').time

  it.each([
    [-3, 'just now'],
    [-45, '45s ago'],
    [-120, '2m ago'],
    [-59 * 60, '59m ago'],
    [-3 * 3600 - 59, '3h ago'],
    [-2 * 86400, '2d ago'],
    [240, 'in 4m'],
    [5, 'any moment'],
  ])('says %ds from now as "%s"', (seconds, text) => {
    expect(relativeTime(at(seconds), NOW, en)).toBe(text)
  })

  it('marks an estimate with ~, and an estimate already due as any moment', () => {
    expect(relativeTime(at(240), NOW, en, { estimated: true })).toBe('in ~4m')
    expect(relativeTime(at(-30), NOW, en, { estimated: true })).toBe('any moment')
  })

  it.each([
    ['pt', 'há 2m', 'em ~4m', 'agora'],
    ['es', 'hace 2m', 'en ~4m', 'ahora'],
  ])('is translated (%s)', (language, ago, estimate, now) => {
    const time = uiMessagesFor(language).time
    expect(relativeTime(at(-120), NOW, time)).toBe(ago)
    expect(relativeTime(at(240), NOW, time, { estimated: true })).toBe(estimate)
    expect(relativeTime(at(-1), NOW, time)).toBe(now)
  })

  it('keeps a text that is not a time', () => {
    expect(relativeTime('soon-ish', NOW, en)).toBe('soon-ish')
  })
})

describe('absoluteTime', () => {
  it('shows the local date and time to the minute', () => {
    expect(absoluteTime(new Date(2026, 9, 5, 9, 7, 30).toISOString())).toBe('2026-10-05 09:07')
  })
})
