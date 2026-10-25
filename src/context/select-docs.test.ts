import { describe, expect, it } from 'vitest'
import { byteLength } from './byte-cut.js'
import { DOC_LIMIT_BYTES, fitDoc, repositoryDocCandidates, truncateDoc } from './select-docs.js'

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

  it('leaves images and other binary files out of declared globs', () => {
    const entries = ['docs/a.md', 'docs/diagram.png', 'docs/spec.PDF', 'docs/api.yaml'].map(
      (path) => ({ path, size: 30_000 }),
    )

    const { candidates } = repositoryDocCandidates({
      entries,
      complete: true,
      changedFiles: [],
      declared: [{ pattern: 'docs/**', origin: '.phada/config.yml' }],
      defaults: false,
    })

    expect(candidates.map((candidate) => candidate.path)).toEqual(['docs/a.md', 'docs/api.yaml'])
  })

  it('keeps docs whose names only start like an excluded file', () => {
    const entries = [
      'docs/security-model.md',
      'docs/SECURITY.md',
      'LICENSE.md',
      'docs/licensing.md',
    ].map((path) => ({ path, size: 10 }))

    const { candidates } = repositoryDocCandidates({
      entries,
      complete: true,
      changedFiles: [],
      declared: [],
      defaults: true,
    })

    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'docs/licensing.md',
      'docs/security-model.md',
    ])
  })

  it('finds a declared file whose folder name has brackets', () => {
    const { candidates, missing } = repositoryDocCandidates({
      entries: [{ path: 'app/[id]/README.md', size: 10 }],
      complete: true,
      changedFiles: [],
      declared: [{ pattern: 'app/[id]/README.md', origin: 'x' }],
      defaults: false,
    })

    expect(candidates.map((candidate) => candidate.path)).toEqual(['app/[id]/README.md'])
    expect(missing).toEqual([])
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
      'src/api/GEMINI.md',
      'src/README.md',
      'src/AGENTS.md',
      'src/CLAUDE.md',
      'src/GEMINI.md',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/CLAUDE.md',
      '.github/copilot-instructions.md',
      '.cursorrules',
      '.windsurfrules',
      'GEMINI.md',
      'CONTRIBUTING.md',
      '.github/CONTRIBUTING.md',
      'docs/CONTRIBUTING.md',
      'README.md',
    ])
    expect(candidates.every((candidate) => candidate.size === undefined)).toBe(true)
    expect(missing).toEqual([])
  })
  it('reads the instruction files of other tools after the agent docs, in a fixed order', () => {
    const entries = [
      'GEMINI.md',
      '.windsurfrules',
      '.cursorrules',
      '.cursor/rules/x.mdc',
      '.cursor/rules/db/a.mdc',
      '.cursor/rules/notes.md',
      '.github/instructions/a.instructions.md',
      '.github/instructions/api/b.instructions.md',
      '.github/instructions/notes.md',
      '.github/copilot-instructions.md',
      '.claude/rules/a.md',
      'AGENTS.md',
    ].map((path) => ({ path, size: 10 }))

    const { candidates } = repositoryDocCandidates({
      entries,
      complete: true,
      changedFiles: ['src/a.ts'],
      declared: [],
      defaults: true,
    })

    expect(
      candidates.map(({ path, category, format, dir }) => [path, category, format, dir]),
    ).toEqual([
      ['AGENTS.md', 'agents', undefined, undefined],
      ['.claude/rules/a.md', 'agents', undefined, undefined],
      ['.github/copilot-instructions.md', 'agents', undefined, undefined],
      ['.github/instructions/a.instructions.md', 'agents', 'instructions', ''],
      ['.github/instructions/api/b.instructions.md', 'agents', 'instructions', ''],
      ['.cursor/rules/db/a.mdc', 'agents', 'mdc', ''],
      ['.cursor/rules/x.mdc', 'agents', 'mdc', ''],
      ['.cursorrules', 'agents', undefined, undefined],
      ['.windsurfrules', 'agents', undefined, undefined],
      ['GEMINI.md', 'agents', undefined, undefined],
    ])
  })

  it('reads GEMINI.md and nested mdc rules from the folders of the changed files', () => {
    const entries = [
      'packages/web/README.md',
      'packages/web/GEMINI.md',
      'packages/web/.cursor/rules/r.mdc',
      'packages/api/.cursor/rules/s.mdc',
      'packages/web/src/a.ts',
    ].map((path) => ({ path, size: 10 }))

    const { candidates } = repositoryDocCandidates({
      entries,
      complete: true,
      changedFiles: ['packages/web/src/a.ts'],
      declared: [],
      defaults: true,
    })

    expect(
      candidates.map(({ path, category, format, dir }) => [path, category, format, dir]),
    ).toEqual([
      ['packages/web/README.md', 'module', undefined, undefined],
      ['packages/web/GEMINI.md', 'module', undefined, undefined],
      ['packages/web/.cursor/rules/r.mdc', 'module', 'mdc', 'packages/web'],
    ])
  })

  it('finds GEMINI.md whatever its case and reads no instruction file without defaults', () => {
    const entries = ['gemini.md', '.cursorrules', '.cursor/rules/x.mdc'].map((path) => ({
      path,
      size: 10,
    }))
    const input = { entries, complete: true, changedFiles: [], declared: [] }

    expect(
      repositoryDocCandidates({ ...input, defaults: true }).candidates.map((c) => c.path),
    ).toEqual(['.cursor/rules/x.mdc', '.cursorrules', 'gemini.md'])
    expect(repositoryDocCandidates({ ...input, defaults: false }).candidates).toEqual([])
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
