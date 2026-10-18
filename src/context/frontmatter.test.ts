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
    expect(fields('﻿---\r\nexcludeAgent: "code-review"\r\n---\r\nbody')).toEqual({
      excludeagent: ['code-review'],
    })
  })

  it('reads keys case-insensitively and empty values as no values', () => {
    expect(fields('---\nApplyTo: src/**\nglobs:\n---\n')).toEqual({
      applyto: ['src/**'],
      globs: [],
    })
  })
})
