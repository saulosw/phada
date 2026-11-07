import { describe, expect, it } from 'vitest'
import { runPlace, runTarget } from './run-target.js'

const PULL = { source: 'watch' as const, repo: 'acme/shop', number: 3, headSha: 'a'.repeat(40) }
const LOCAL = { ...PULL, source: 'local' as const, number: 0, headSha: 'b'.repeat(40) }

describe('runTarget', () => {
  it('names the pull request of a remote review', () => {
    expect(runTarget(PULL)).toBe('acme/shop#3')
    expect(runPlace(PULL)).toBe('#3')
  })

  it('names the branch of a local review, starred when it had uncommitted changes', () => {
    expect(runTarget({ ...LOCAL, branch: 'feat/spend', dirty: false })).toBe(
      'acme/shop@feat/spend (local)',
    )
    expect(runTarget({ ...LOCAL, branch: 'feat/spend', dirty: true })).toBe(
      'acme/shop@feat/spend* (local)',
    )
    expect(runPlace({ ...LOCAL, branch: 'feat/spend', dirty: true })).toBe('@feat/spend* (local)')
  })

  it('names a detached head by its short sha', () => {
    expect(runTarget(LOCAL)).toBe('acme/shop@bbbbbbb (local)')
  })
})
