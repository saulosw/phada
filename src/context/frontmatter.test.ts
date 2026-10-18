import { describe, expect, it } from 'vitest'
import { readFrontmatter } from './frontmatter.js'

function fields(text: string): Record<string, string[]> {
  const result = readFrontmatter(text)
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`)
  return Object.fromEntries(result.fields)
}

describe('readFrontmatter', () => {
  it('reports none when the file does not start with a front matter block', () => {
    expect(readFrontmatter('# Title\n---\nglobs: a\n---\n')).toEqual({ status: 'none' })
    expect(readFrontmatter('')).toEqual({ status: 'none' })
  })

  it('reports invalid when the block is never closed', () => {
    expect(readFrontmatter('---\nglobs: a\n# body\n')).toEqual({ status: 'invalid' })
  })

  it('splits unquoted values on commas even when they are not valid YAML', () => {
    expect(fields('---\nglobs: *.ts, src/**\n---\nbody')).toEqual({ globs: ['*.ts', 'src/**'] })
  })

  it('reads quoted comma lists, flow lists and block lists', () => {
    expect(fields('---\napplyTo: "**/*.ts,**/*.tsx"\n---\n')).toEqual({
      applyto: ['**/*.ts', '**/*.tsx'],
    })
    expect(fields(`---\nglobs: ['a/**', "b/*.go"]\n---\n`)).toEqual({ globs: ['a/**', 'b/*.go'] })
    expect(fields('---\nglobs:\n  - a\n  - "b"\n---\n')).toEqual({ globs: ['a', 'b'] })
  })

  it('keeps the description whole and reads booleans as text', () => {
    expect(fields('---\ndescription: Use when: x, y\nalwaysApply: true\n---\n')).toEqual({
      description: ['Use when: x, y'],
      alwaysapply: ['true'],
    })
  })

  it('accepts a byte order mark and CRLF line ends', () => {
    expect(fields('\uFEFF---\r\nexcludeAgent: "code-review"\r\n---\r\nbody')).toEqual({
      excludeagent: ['code-review'],
    })
  })

  it('reads keys case-insensitively and empty values as no values', () => {
    expect(fields('---\nApplyTo: src/**\nglobs:\n---\n')).toEqual({
      applyto: ['src/**'],
      globs: [],
    })
  })

  it('keeps commas inside braces in one pattern', () => {
    expect(
      fields('---\napplyTo: "**/*.{ts,tsx}"\nglobs: src/**/*.{ts,tsx}, lib/**\n---\n'),
    ).toEqual({
      applyto: ['**/*.{ts,tsx}'],
      globs: ['src/**/*.{ts,tsx}', 'lib/**'],
    })
  })

  it('drops a trailing comment from an unquoted value', () => {
    expect(
      fields("---\nalwaysApply: true # always\nglobs: src/** # api\napplyTo: 'a#b'\n---\n"),
    ).toEqual({
      alwaysapply: ['true'],
      globs: ['src/**'],
      applyto: ['a#b'],
    })
  })

  it('reads block lists that are not indented', () => {
    expect(fields('---\nglobs:\n- "*.ts"\n- src/**\nalwaysApply: false\n---\n')).toEqual({
      globs: ['*.ts', 'src/**'],
      alwaysapply: ['false'],
    })
  })

  it('reads a description written over several lines', () => {
    expect(fields('---\ndescription:\n  Database access\n  rules\nglobs:\n---\n')).toEqual({
      description: ['Database access rules'],
      globs: [],
    })
    expect(fields('---\ndescription: >\n  Folded text\n---\n')).toEqual({
      description: ['Folded text'],
    })
  })

  it('drops a comment after a quoted value', () => {
    expect(fields('---\napplyTo: "src/**" # backend\nglobs: \'a/**, b/**\' # two\n---\n')).toEqual({
      applyto: ['src/**'],
      globs: ['a/**', 'b/**'],
    })
  })

  it('reads patterns written as a block scalar on the next lines', () => {
    expect(fields('---\nglobs: >\n  src/**, lib/**\napplyTo: |\n  docs/**\n---\n')).toEqual({
      globs: ['src/**', 'lib/**'],
      applyto: ['docs/**'],
    })
  })

  it('reads a flow list written over several lines', () => {
    expect(fields('---\nglobs: [\n  "src/**",\n  lib/**\n]\nalwaysApply: false\n---\n')).toEqual({
      globs: ['src/**', 'lib/**'],
      alwaysapply: ['false'],
    })
  })
})
