import { describe, expect, it } from 'vitest'
import { BINARY, MODIFIED, modifiedFile } from '../../test/support/diff-sections.js'
import { applyIgnore, DEFAULT_IGNORE, matcher } from './ignore.js'

describe('applyIgnore', () => {
  it('drops ignored files whole and keeps the rest byte for byte', () => {
    const diff =
      MODIFIED + modifiedFile('package-lock.json') + modifiedFile('web/yarn.lock') + BINARY

    expect(applyIgnore(diff, DEFAULT_IGNORE)).toEqual({
      diff: MODIFIED + BINARY,
      files: ['src/a.ts', 'logo.png'],
      ignored: ['package-lock.json', 'web/yarn.lock'],
    })
  })

  it('adds config patterns and matches dotfiles', () => {
    expect(applyIgnore(modifiedFile('.cache/x.snap'), ['**/*.snap']).ignored).toEqual([
      '.cache/x.snap',
    ])
  })

  it('keeps everything without patterns', () => {
    expect(applyIgnore(MODIFIED, [])).toEqual({ diff: MODIFIED, files: ['src/a.ts'], ignored: [] })
  })
})

describe('DEFAULT_IGNORE', () => {
  it.each(['app.min.js', 'dist/x.min.css', 'a.js.map', 'go.sum', 'bun.lockb', 'Cargo.lock'])(
    'ignores %s',
    (path) => {
      expect(matcher(DEFAULT_IGNORE)(path)).toBe(true)
    },
  )

  it.each(['dist/index.js', 'src/lock.ts', 'docs/package-lock.md', 'yarn.lock.md'])(
    'keeps %s',
    (path) => {
      expect(matcher(DEFAULT_IGNORE)(path)).toBe(false)
    },
  )
})
