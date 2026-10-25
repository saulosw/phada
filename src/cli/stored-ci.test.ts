import { describe, expect, it } from 'vitest'
import { ciSkipJson, storedCi } from './stored-ci.js'

describe('storedCi', () => {
  it('reads back the CI of a commit skipped for failing CI', () => {
    const json = ciSkipJson({
      waitMs: 0,
      onFailure: 'skip',
      summary: { state: 'failing', failing: ['test'], pending: [] },
      checks: [
        { name: 'build', state: 'passing' },
        { name: 'test', state: 'failing' },
      ],
    })

    expect(storedCi(json)).toEqual({
      state: 'failing',
      checks: [
        { name: 'build', state: 'passing' },
        { name: 'test', state: 'failing' },
      ],
    })
  })

  it('reads the state and the name and state of each check from the ci block of a review', () => {
    const review = {
      schemaVersion: 1,
      ci: {
        state: 'pending',
        total: 1,
        failing: [],
        pending: ['e2e'],
        checks: [{ name: 'e2e', state: 'pending', conclusion: null, annotations: 0 }],
      },
    }

    expect(storedCi(JSON.stringify(review))).toEqual({
      state: 'pending',
      checks: [{ name: 'e2e', state: 'pending' }],
    })
  })

  it('is null without a ci block, or with one it cannot read', () => {
    expect(storedCi(undefined)).toBeNull()
    expect(storedCi(JSON.stringify({ ci: null }))).toBeNull()
    expect(storedCi(JSON.stringify({ schemaVersion: 1 }))).toBeNull()
    expect(storedCi(JSON.stringify({ ci: { state: 'red', checks: [] } }))).toBeNull()
    expect(storedCi(JSON.stringify({ ci: { state: 'passing', checks: [{ name: 1 }] } }))).toBeNull()
    expect(storedCi('{')).toBeNull()
  })
})
