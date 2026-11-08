import { describe, expect, it } from 'vitest'
import { noReplies, repliedKinds } from './reply-kinds.js'

describe('repliedKinds', () => {
  it('lists the kinds with replies in the order of the kinds, with their counts', () => {
    expect(repliedKinds({ ...noReplies(), refuted: 1, question: 2 })).toEqual([
      { kind: 'question', count: 2 },
      { kind: 'refuted', count: 1 },
    ])
    expect(repliedKinds(noReplies())).toEqual([])
  })
})
