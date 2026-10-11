import { readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Boundary {
  dir: string
  values: ReadonlySet<string>
  types: ReadonlySet<string>
  expected: string[]
  globals?: string[]
}

const REVIEW: Boundary = {
  dir: 'review',
  values: new Set(['node:crypto', 'zod']),
  types: new Set([
    '../providers/types.js',
    '../investigation/toolbox.js',
    '../github/pull-request.js',
  ]),
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
const INVESTIGATION: Boundary = {
  dir: 'investigation',
  values: new Set([
    'node:crypto',
    'node:fs/promises',
    'node:net',
    'node:os',
    'node:path',
    'node:readline',
    'node:url',
    'zod',
    '../repository/checkout.js',
    '../repository/repo-path.js',
  ]),
  types: new Set([
    '../providers/types.js',
    '../review/types.js',
    '../repository/checkout.js',
    '../repository/git-mirror.js',
  ]),
  expected: [
    'toolbox.ts',
    'mcp/mcp-server.ts',
    'tools/repository-tools.ts',
    'tools/tool-registry.ts',
  ],
  globals: ['console'],
}
const REPOSITORY: Boundary = {
  dir: 'repository',
  values: new Set([
    'node:fs/promises',
    'node:os',
    'node:path',
    '../process/errors.js',
    '../process/run-command.js',
    '../providers/redact-secrets.js',
  ]),
  types: new Set(['../process/run-command.js']),
  expected: ['checkout.ts', 'git-checkout.ts', 'git-mirror.ts', 'mirror-lock.ts', 'repo-path.ts'],
}
const REPO_MAP: Boundary = {
  dir: 'repo-map',
  values: new Set(['web-tree-sitter', 'node:fs/promises', 'node:module']),
  types: new Set(),
  expected: ['extract.ts', 'grammars.ts', 'languages.ts', 'types.ts', 'walk.ts'],
}
const STORE: Boundary = {
  dir: 'store',
  values: new Set(['node:fs/promises', 'node:path', 'node:sqlite']),
  types: new Set(['../repo-map/types.js', '../repo-map/languages.js']),
  expected: ['index-store.ts', 'schema.ts'],
}
const APP: Boundary = {
  dir: 'app',
  values: new Set([
    '../context/load-context.js',
    '../config/merge-config.js',
    '../config/parse-config.js',
    '../context/ignore.js',
    '../investigation/open-investigation.js',
    '../investigation/tools/report.js',
    '../repo-map/languages.js',
    '../repository/git-checkout.js',
    '../review/run-review.js',
  ]),
  types: new Set([
    '../config/types.js',
    '../context/types.js',
    '../github/pull-request.js',
    '../investigation/open-investigation.js',
    '../investigation/tools/report.js',
    '../investigation/tools/tool-log.js',
    '../providers/types.js',
    '../repo-map/extract.js',
    '../repo-map/languages.js',
    '../repository/checkout.js',
    '../repository/git-checkout.js',
    '../repository/git-mirror.js',
    '../review/types.js',
    '../store/index-store.js',
  ]),
  expected: ['index-repository.ts', 'review-pull-request.ts'],
}
const STATIC_MODULE = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_MODULE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g
const FORBIDDEN_GLOBALS = ['process', 'console']

function sourcesOf({ dir }: Boundary) {
  const url = new URL(`./${dir}/`, import.meta.url)
  return readdirSync(url, { recursive: true, encoding: 'utf8' })
    .map((name) => name.split('\\').join('/'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, code: readFileSync(new URL(name, url), 'utf8') }))
}

function boundaryViolations(code: string, boundary: Boundary = REVIEW, file = ''): string[] {
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
    .filter(({ specifier, typeOnly }) => !isAllowedModule(specifier, typeOnly, boundary, file))
    .map(({ specifier }) => `imports '${specifier}'`)
  const codeWithoutStrings = code.replace(STRING_LITERAL, "''")
  for (const name of boundary.globals ?? FORBIDDEN_GLOBALS) {
    if (new RegExp(`\\b${name}\\b`).test(codeWithoutStrings)) violations.push(`uses ${name}`)
  }
  return violations
}

function isAllowedModule(
  specifier: string,
  typeOnly: boolean,
  boundary: Boundary,
  file: string,
): boolean {
  const resolved = specifier.startsWith('.')
    ? posix.normalize(posix.join(posix.dirname(file), specifier))
    : specifier
  const fromRoot =
    resolved.startsWith('.') || !specifier.startsWith('.') ? resolved : `./${resolved}`
  return (
    fromRoot.startsWith('./') ||
    boundary.values.has(fromRoot) ||
    (typeOnly && boundary.types.has(fromRoot))
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

describe('investigation boundary rules', () => {
  it('lets a subfolder import its siblings and the tools contract, not the outside', () => {
    const code = [
      "import { CheckoutError } from '../../repository/checkout.js'",
      "import type { Toolbox } from '../toolbox.js'",
    ].join('\n')

    expect(boundaryViolations(code, INVESTIGATION, 'tools/repository-tools.ts')).toEqual([])
    expect(
      boundaryViolations(
        "import { formatReview } from '../../cli/format-review.js'",
        INVESTIGATION,
        'tools/report.ts',
      ),
    ).not.toEqual([])
  })

  it('accepts sockets, the checkout and the tool contract', () => {
    const code = [
      "import { createServer } from 'node:net'",
      "import { CheckoutError } from '../repository/checkout.js'",
      "import type { Toolbox } from './toolbox.js'",
      'const path = process.execPath',
    ].join('\n')

    expect(boundaryViolations(code, INVESTIGATION)).toEqual([])
  })

  it.each([
    ['a concrete provider', "import { ClaudeCliProvider } from '../providers/claude.js'"],
    ['the CLI', "import { formatReview } from '../cli/format-review.js'"],
    ['the engine', "import { runReview } from '../review/run-review.js'"],
    ['git through the process runner', "import { runCommand } from '../process/run-command.js'"],
    ['the console', "console.log('debug')"],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, INVESTIGATION)).not.toEqual([])
  })
})

describe('app boundary rules', () => {
  it.each([
    ['the CLI formatters', "import { formatContextLine } from '../cli/format-context.js'"],
    ['a concrete provider', "import { ClaudeCliProvider } from '../providers/claude.js'"],
    ['the GitHub client', "import { fetchPullRequest } from '../github/pull-request.js'"],
    ['the terminal', "process.stderr.write('x')"],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, APP)).not.toEqual([])
  })
})

describe('repository boundary rules', () => {
  it.each([
    [
      'the investigation',
      "import { openInvestigation } from '../investigation/open-investigation.js'",
    ],
    ['a concrete provider', "import { ClaudeCliProvider } from '../providers/claude.js'"],
    ['process.env', 'const token = process.env.GITHUB_TOKEN'],
    ['the console', "console.log('debug')"],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, REPOSITORY)).not.toEqual([])
  })
})

describe('repo-map boundary rules', () => {
  it.each([
    ['SQLite', "import { DatabaseSync } from 'node:sqlite'"],
    ['the process runner', "import { runCommand } from '../process/run-command.js'"],
    ['the repository mirror', "import { openGitMirror } from '../repository/git-mirror.js'"],
    ['process.env', 'const home = process.env.HOME'],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, REPO_MAP)).not.toEqual([])
  })
})

describe('store boundary rules', () => {
  it('accepts SQLite and the types of the extracted map', () => {
    const code = [
      "import type { DatabaseSync } from 'node:sqlite'",
      "import type { FileMap } from '../repo-map/types.js'",
      "const sqlite = await import('node:sqlite')",
    ].join('\n')

    expect(boundaryViolations(code, STORE)).toEqual([])
  })

  it.each([
    ['tree-sitter', "import { Parser } from 'web-tree-sitter'"],
    ['a subprocess', "import { spawn } from 'node:child_process'"],
    ['a value import of the extractor', "import { createExtractor } from '../repo-map/extract.js'"],
    ['the console', "console.log('debug')"],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, STORE)).not.toEqual([])
  })
})

describe.each([REVIEW, PUBLISH, CONTEXT, INVESTIGATION, REPOSITORY, REPO_MAP, STORE, APP])(
  '$dir boundary',
  (boundary) => {
    const sources = sourcesOf(boundary)

    it('has source files to check', () => {
      expect(sources.map(({ name }) => name)).toEqual(expect.arrayContaining(boundary.expected))
    })

    it.each(sources)('$name stays inside the boundary', ({ name, code }) => {
      expect(boundaryViolations(code, boundary, name)).toEqual([])
    })
  },
)
