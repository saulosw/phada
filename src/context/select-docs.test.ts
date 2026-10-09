import { describe, expect, it } from 'vitest'
import {
  byteLength,
  DOC_LIMIT_BYTES,
  fitDoc,
  repositoryDocCandidates,
  truncateDoc,
} from './select-docs.js'

const TREE = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CHANGELOG.md',
  'LICENSE.md',
  'SECURITY.md',
  'NOTES.md',
  '.claude/CLAUDE.md',
  '.claude/rules/api.md',
  '.github/CONTRIBUTING.md',
  'docs/architecture.md',
  'docs/guide/setup.md',
  'docs/logo.png',
  'src/README.md',
  'src/api/Agents.md',
  'src/api/users.ts',
  'src/web/a.ts',
  'lib/x.md',
].map((path) => ({ path, size: 100 }))

describe('repositoryDocCandidates', () => {
  it('orders declared, module, agent, contributing and other docs without duplicates', () => {
    const { candidates } = repositoryDocCandidates({
      entries: TREE,
      complete: true,
      changedFiles: ['src/api/users.ts'],
      declared: [{ pattern: 'docs/architecture.md', origin: '.phada/config.yml' }],
      defaults: true,
    })

    expect(candidates.map((candidate) => [candidate.path, candidate.category])).toEqual([
      ['docs/architecture.md', 'declared'],
      ['src/api/Agents.md', 'module'],
      ['src/README.md', 'module'],
      ['AGENTS.md', 'agents'],
      ['CLAUDE.md', 'agents'],
      ['.claude/CLAUDE.md', 'agents'],
      ['.claude/rules/api.md', 'agents'],
      ['.github/CONTRIBUTING.md', 'contributing'],
      ['README.md', 'contributing'],
      ['NOTES.md', 'other'],
      ['docs/guide/setup.md', 'other'],
    ])
    expect(candidates[0]).toEqual({
      path: 'docs/architecture.md',
      category: 'declared',
      size: 100,
      origin: '.phada/config.yml',
    })
  })

  it('keeps only declared files without defaults and expands globs', () => {
    const { candidates } = repositoryDocCandidates({
      entries: TREE,
      complete: true,
      changedFiles: ['src/api/users.ts'],
      declared: [{ pattern: 'docs/**/*.md', origin: 'user:config.yml' }],
      defaults: false,
    })

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'docs/architecture.md',
      'docs/guide/setup.md',
    ])
  })

  it('reports declared files and globs that match nothing', () => {
    const declared = [
      { pattern: 'docs/missing.md', origin: '.phada/config.yml' },
      { pattern: 'specs/**/*.md', origin: '.phada/config.yml' },
    ]

    const { candidates, missing } = repositoryDocCandidates({
      entries: TREE,
      complete: true,
      changedFiles: [],
      declared,
      defaults: false,
    })

    expect(candidates).toEqual([])
    expect(missing).toEqual(declared)
  })

  it('probes known paths without sizes when the tree is incomplete', () => {
    const { candidates, missing } = repositoryDocCandidates({
      entries: [],
      complete: false,
      changedFiles: ['src/api/users.ts'],
      declared: [{ pattern: 'docs/a.md', origin: 'x' }],
      defaults: true,
    })

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'docs/a.md',
      'src/api/README.md',
      'src/api/AGENTS.md',
      'src/api/CLAUDE.md',
      'src/README.md',
      'src/AGENTS.md',
      'src/CLAUDE.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      'CONTRIBUTING.md',
      '.github/CONTRIBUTING.md',
      'docs/CONTRIBUTING.md',
      'README.md',
    ])
    expect(candidates.every((candidate) => candidate.size === undefined)).toBe(true)
    expect(missing).toEqual([])
  })
})

describe('fitDoc', () => {
  it.each([
    [100, 60_000, 'whole'],
    [20_000, 20_000, 'whole'],
    [20_001, 20_000, 'truncated'],
    [20_001, 19_999, 'omitted'],
    [500, 499, 'omitted'],
  ] as const)('fits %i bytes into %i as %s', (size, remaining, fit) => {
    expect(fitDoc(size, remaining)).toBe(fit)
  })
})

describe('truncateDoc', () => {
  it('cuts at a line end inside the limit, with valid UTF-8 and the marker', () => {
    const content = `${'é'.repeat(99)}\n`.repeat(150)

    const cut = truncateDoc(content)
    const kept = cut.slice(0, cut.lastIndexOf('\n['))

    expect(byteLength(kept)).toBeLessThanOrEqual(DOC_LIMIT_BYTES)
    expect(kept.endsWith('é')).toBe(true)
    expect(cut).not.toContain('�')
    expect(
      cut.endsWith(`[truncated by Phada: ${byteLength(kept)} of ${byteLength(content)} bytes]`),
    ).toBe(true)
  })

  it('cuts inside a multibyte character without breaking it when there is no line end', () => {
    const content = '€'.repeat(10_000)

    const cut = truncateDoc(content)

    expect(cut).not.toContain('�')
    expect(cut.startsWith('€'.repeat(6_666))).toBe(true)
  })
})
