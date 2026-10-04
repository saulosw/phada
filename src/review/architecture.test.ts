import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const REVIEW_DIR = new URL('./', import.meta.url)
const ALLOWED_VALUE_IMPORTS = new Set(['node:crypto'])
const ALLOWED_TYPE_IMPORTS = new Set(['../providers/types.js', '../github/pull-request.js'])
const STATIC_MODULE = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_MODULE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g
const FORBIDDEN_GLOBALS = ['process', 'console']

const sources = readdirSync(REVIEW_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, code: readFileSync(new URL(name, REVIEW_DIR), 'utf8') }))

function boundaryViolations(code: string): string[] {
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
    .filter(({ specifier, typeOnly }) => !isAllowedModule(specifier, typeOnly))
    .map(({ specifier }) => `imports '${specifier}'`)
  const codeWithoutStrings = code.replace(STRING_LITERAL, "''")
  for (const name of FORBIDDEN_GLOBALS) {
    if (new RegExp(`\\b${name}\\b`).test(codeWithoutStrings)) violations.push(`uses ${name}`)
  }
  return violations
}

function isAllowedModule(specifier: string, typeOnly: boolean): boolean {
  return (
    specifier.startsWith('./') ||
    ALLOWED_VALUE_IMPORTS.has(specifier) ||
    (typeOnly && ALLOWED_TYPE_IMPORTS.has(specifier))
  )
}

describe('boundaryViolations', () => {
  it('accepts its own files, node:crypto and type-only imports of the interfaces', () => {
    const code = [
      "import { randomBytes } from 'node:crypto'",
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

describe('review engine boundaries', () => {
  it('has source files to check', () => {
    expect(sources.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['prompt.ts', 'run-review.ts', 'types.ts']),
    )
  })

  it.each(sources)('$name stays inside the engine boundary', ({ code }) => {
    expect(boundaryViolations(code)).toEqual([])
  })
})
