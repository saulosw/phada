import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Boundary {
  dir: string
  values: ReadonlySet<string>
  types: ReadonlySet<string>
  expected: string[]
}

const REVIEW: Boundary = {
  dir: 'review',
  values: new Set(['node:crypto', 'zod']),
  types: new Set(['../providers/types.js', '../github/pull-request.js']),
  expected: ['prompt.ts', 'run-review.ts', 'types.ts'],
}
const PUBLISH: Boundary = {
  dir: 'publish',
  values: new Set(),
  types: new Set(['../review/types.js', '../github/pull-request-reviews.js']),
  expected: ['decide-run.ts', 'markers.ts', 'plan-publication.ts'],
}
const CONTEXT: Boundary = {
  dir: 'context',
  values: new Set([
    'picomatch',
    'node:path',
    '../config/parse-config.js',
    '../config/merge-config.js',
  ]),
  types: new Set(['../review/types.js', '../config/types.js', '../github/repository-files.js']),
  expected: ['ignore.ts', 'load-context.ts', 'select-docs.ts', 'split-diff.ts'],
}
const STATIC_MODULE = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_MODULE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g
const FORBIDDEN_GLOBALS = ['process', 'console']

function sourcesOf({ dir }: Boundary) {
  const url = new URL(`./${dir}/`, import.meta.url)
  return readdirSync(url)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, code: readFileSync(new URL(name, url), 'utf8') }))
}

function boundaryViolations(code: string, boundary: Boundary = REVIEW): string[] {
  const modules = [
    ...[...code.matchAll(STATIC_MODULE)].map(([, typeOnly, specifier = '']) => ({
      specifier,
      typeOnly: typeOnly !== undefined,
    })),
    ...[...code.matchAll(DYNAMIC_MODULE)].map(([, specifier = '']) => ({
      specifier,
      typeOnly: false,
    })),
  ]
  const violations = modules
    .filter(({ specifier, typeOnly }) => !isAllowedModule(specifier, typeOnly, boundary))
    .map(({ specifier }) => `imports '${specifier}'`)
  const codeWithoutStrings = code.replace(STRING_LITERAL, "''")
  for (const name of FORBIDDEN_GLOBALS) {
    if (new RegExp(`\\b${name}\\b`).test(codeWithoutStrings)) violations.push(`uses ${name}`)
  }
  return violations
}

function isAllowedModule(specifier: string, typeOnly: boolean, boundary: Boundary): boolean {
  return (
    specifier.startsWith('./') ||
    boundary.values.has(specifier) ||
    (typeOnly && boundary.types.has(specifier))
  )
}

describe('boundaryViolations', () => {
  it('accepts its own files, node:crypto, zod and type-only imports of the interfaces', () => {
    const code = [
      "import { randomBytes } from 'node:crypto'",
      "import { z } from 'zod'",
      "import type { ReviewProvider } from '../providers/types.js'",
      "import type {\n  PullRequest,\n} from '../github/pull-request.js'",
      "import { buildReviewPrompt } from './prompt.js'",
      "export type { ReviewOutcome } from './types.js'",
      "export const LABEL = 'process the console output'",
    ].join('\n')

    expect(boundaryViolations(code)).toEqual([])
  })

  it.each([
    ['a concrete provider', "import { ClaudeCliProvider } from '../providers/claude.js'"],
    ['a value import of the interfaces', "import { ProviderError } from '../providers/types.js'"],
    [
      'a re-export of a concrete provider',
      "export { ClaudeCliProvider } from '../providers/claude.js'",
    ],
    ['a star re-export', "export * from '../providers/claude.js'"],
    ['a side-effect import', "import '../providers/claude.js'"],
    ['a dynamic import', "const claude = await import('../providers/claude.js')"],
    ['a double-quoted import', 'import { readFile } from "node:fs/promises"'],
    ['the file system', "import { readFile } from 'node:fs/promises'"],
    ['process.env', 'const token = process.env.GITHUB_TOKEN'],
    ['a destructured process', 'const { env } = process'],
    ['the console', "console.log('debug')"],
    ['a destructured console', 'const { log } = console'],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code)).not.toEqual([])
  })
})

describe('publish boundary rules', () => {
  it('accepts type-only imports of the review types and the review state', () => {
    const code = [
      "import type { Finding } from '../review/types.js'",
      "import type { PullRequestReviewState } from '../github/pull-request-reviews.js'",
      "import { FINDING_MARKER } from './markers.js'",
    ].join('\n')

    expect(boundaryViolations(code, PUBLISH)).toEqual([])
  })

  it.each([
    [
      'a value import of the GitHub client',
      "import { fetchReviewState } from '../github/pull-request-reviews.js'",
    ],
    ['the CLI formatters', "import { formatReview } from '../cli/format-review.js'"],
    ['zod', "import { z } from 'zod'"],
    ['process.env', 'const token = process.env.GITHUB_TOKEN'],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, PUBLISH)).not.toEqual([])
  })
})

describe('context boundary rules', () => {
  it('accepts picomatch, path, the pure config helpers and type-only imports', () => {
    const code = [
      "import picomatch from 'picomatch'",
      "import { posix } from 'node:path'",
      "import { mergeConfig } from '../config/merge-config.js'",
      "import type { ConfigLayer } from '../config/types.js'",
      "import type { RepositoryTree } from '../github/repository-files.js'",
    ].join('\n')

    expect(boundaryViolations(code, CONTEXT)).toEqual([])
  })

  it.each([
    ['the file system', "import { readFile } from 'node:fs/promises'"],
    ['the user config loader', "import { loadUserLayers } from '../config/user-config.js'"],
    [
      'a value import of the GitHub client',
      "import { fetchRepositoryTree } from '../github/repository-files.js'",
    ],
    ['process.env', 'const home = process.env.HOME'],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, CONTEXT)).not.toEqual([])
  })
})

describe.each([REVIEW, PUBLISH, CONTEXT])('$dir boundary', (boundary) => {
  const sources = sourcesOf(boundary)

  it('has source files to check', () => {
    expect(sources.map(({ name }) => name)).toEqual(expect.arrayContaining(boundary.expected))
  })

  it.each(sources)('$name stays inside the boundary', ({ code }) => {
    expect(boundaryViolations(code, boundary)).toEqual([])
  })
})
