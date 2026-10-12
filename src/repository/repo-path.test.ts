import { describe, expect, it } from 'vitest'
import { InvalidRepoPathError, toRepoPath } from './repo-path.js'

describe('toRepoPath', () => {
  it.each([
    ['src/app.ts', 'src/app.ts'],
    ['./src//app.ts', 'src/app.ts'],
    ['docs/', 'docs'],
    ['  docs/guide.md  ', 'docs/guide.md'],
    ['pasta com espaço/ação.ts', 'pasta com espaço/ação.ts'],
    ['src/-x', 'src/-x'],
    ['a/./b', 'a/b'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(toRepoPath(input, { allowRoot: false })).toBe(expected)
  })

  it.each([undefined, '', '.', './', ' '])(
    'reads %j as the root when the root is allowed',
    (input) => {
      expect(toRepoPath(input, { allowRoot: true })).toBe('')
    },
  )

  it('asks for a file path when the root is not allowed', () => {
    expect(() => toRepoPath('.', { allowRoot: false })).toThrow(
      new InvalidRepoPathError('give a file path'),
    )
  })

  it.each(['../x', 'a/../../b', 'a/..', '/etc/passwd', 'C:\\x', 'C:/x', 'a\\b', 'a\0b', '-n'])(
    'refuses %j',
    (input) => {
      expect(() => toRepoPath(input, { allowRoot: true })).toThrow(
        new InvalidRepoPathError(`"${input}" is not a path inside the repository`),
      )
    },
  )
})
