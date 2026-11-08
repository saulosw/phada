import { describe, expect, it } from 'vitest'
import { parseFixOutcomes } from './fix-outcomes.js'

describe('parseFixOutcomes', () => {
  it('reads one outcome per finding sent and keeps the rest of the answer as the summary', () => {
    const text = [
      'I changed the auth check and left the race alone.',
      '',
      '#3 skipped: the lock needs a design decision.',
      '#1 fixed: used the authenticated user id.',
    ].join('\n')

    expect(parseFixOutcomes(text, [1, 3])).toEqual({
      outcomes: [
        { number: 1, status: 'fixed', reason: 'used the authenticated user id.' },
        { number: 3, status: 'skipped', reason: 'the lock needs a design decision.' },
      ],
      unreported: [],
      summary: 'I changed the auth check and left the race alone.',
    })
  })

  it('accepts the lines as a markdown list or in bold, in any case', () => {
    const text = ['- **#2 Fixed:** guarded the null.', '* `#5 skipped` - not real'].join('\n')

    expect(parseFixOutcomes(text, [2, 5]).outcomes).toEqual([
      { number: 2, status: 'fixed', reason: 'guarded the null.' },
      { number: 5, status: 'skipped', reason: 'not real' },
    ])
  })

  it('names the findings the answer does not report and ignores numbers not sent', () => {
    const text = ['#1 fixed: done', '#1 skipped: second thoughts', '#9 fixed: other'].join('\n')

    expect(parseFixOutcomes(text, [1, 2])).toEqual({
      outcomes: [{ number: 1, status: 'fixed', reason: 'done' }],
      unreported: [2],
      summary: '#9 fixed: other',
    })
  })

  it('reports every finding as unreported when the answer has no outcome line', () => {
    expect(parseFixOutcomes('All done.', [1, 2])).toEqual({
      outcomes: [],
      unreported: [1, 2],
      summary: 'All done.',
    })
  })
})
