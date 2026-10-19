import { describe, expect, it } from 'vitest'
import {
  insertStatement,
  PULL_TABLE,
  REPO_TABLE,
  UnknownHistoryFieldError,
  updateStatement,
  upsertStatement,
} from './history-columns.js'

describe('history statements', () => {
  it('upserts on the keys each table declares', () => {
    expect(upsertStatement(REPO_TABLE, { repo: 'Acme/Shop' }).sql).toContain('on conflict (repo)')
    expect(upsertStatement(PULL_TABLE, { repo: 'a/b', number: 3 }).sql).toContain(
      'on conflict (repo, number)',
    )
  })

  it('binds values, lowercases repositories and stores booleans as numbers', () => {
    const { values } = insertStatement(PULL_TABLE, {
      repo: 'Acme/Shop',
      number: 3,
      eligible: true,
    })

    expect(values).toEqual(['acme/shop', 3, 1])
  })

  it('refuses a field the table does not have', () => {
    expect(() => insertStatement(REPO_TABLE, { repo: 'a/b', nope: 1 })).toThrow(
      UnknownHistoryFieldError,
    )
  })

  it('updates nothing without changes', () => {
    expect(updateStatement(REPO_TABLE, 1, {})).toBeUndefined()
  })
})
