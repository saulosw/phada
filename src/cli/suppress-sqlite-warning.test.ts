import { describe, expect, it } from 'vitest'
import { suppressSqliteWarning } from './suppress-sqlite-warning.js'

function target() {
  const emitted: unknown[][] = []
  const value = { emitWarning: (...args: unknown[]) => void emitted.push(args) }
  suppressSqliteWarning(value as unknown as Pick<NodeJS.Process, 'emitWarning'>)
  return { value, emitted }
}

describe('suppressSqliteWarning', () => {
  it('drops the experimental warning of the built-in SQLite', () => {
    const { value, emitted } = target()
    const sqlite = new Error('SQLite is an experimental feature and might change at any time')
    sqlite.name = 'ExperimentalWarning'

    value.emitWarning(
      'SQLite is an experimental feature and might change at any time',
      'ExperimentalWarning',
    )
    value.emitWarning(sqlite)
    value.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' })

    expect(emitted).toEqual([])
  })

  it('passes every other warning through', () => {
    const { value, emitted } = target()

    value.emitWarning('old API', 'DeprecationWarning')
    value.emitWarning('VM modules are an experimental feature', 'ExperimentalWarning')

    expect(emitted).toEqual([
      ['old API', 'DeprecationWarning'],
      ['VM modules are an experimental feature', 'ExperimentalWarning'],
    ])
  })
})
