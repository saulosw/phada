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
  types: new Set([
    '../review/types.js',
    '../github/pull-request-reviews.js',
    '../github/compare-commits.js',
  ]),
  expected: [
    'decide-run.ts',
    'feedback.ts',
    'markers.ts',
    'plan-publication.ts',
    'recheck-candidates.ts',
  ],
}
const WATCH: Boundary = {
  dir: 'watch',
  values: new Set(),
  types: new Set(['../config/watch-settings.js', '../github/list-pull-requests.js']),
  expected: ['failures.ts', 'filters.ts', 'next-job.ts', 'plan-cycle.ts', 'time.ts', 'types.ts'],
  globals: ['process', 'console', 'Date.now', 'setTimeout'],
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
    'node:child_process',
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
    '../providers/redact-secrets.js',
  ]),
  types: new Set([
    '../providers/types.js',
    '../review/types.js',
    '../repository/checkout.js',
    '../graph/types.js',
    '../config/mcp-servers.js',
  ]),
  expected: [
    'toolbox.ts',
    'create-investigation.ts',
    'tools/graph-tools.ts',
    'tools/history-tool.ts',
    'mcp/mcp-client.ts',
    'mcp/mcp-server.ts',
    'tools/repository-tools.ts',
    'tools/tool-registry.ts',
  ],
  globals: ['console'],
}
const REPOSITORY: Boundary = {
  dir: 'repository',
  values: new Set([
    'node:crypto',
    'node:fs/promises',
    'node:os',
    'node:path',
    'node:process',
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
  types: new Set([
    '../repo-map/types.js',
    '../repo-map/languages.js',
    '../watch/types.js',
    '../publish/feedback.js',
    '../review/types.js',
  ]),
  expected: ['index-store.ts', 'schema.ts'],
}
const SKILLS: Boundary = {
  dir: 'skills',
  values: new Set(['node:path', '../context/frontmatter.js']),
  types: new Set(['../config/local-files.js']),
  expected: ['installed-skills.ts', 'resolve-skill.ts', 'skill-locations.ts', 'skill-text.ts'],
}
const GH_FACADE: Boundary = {
  dir: 'gh-facade',
  values: new Set([
    'node:child_process',
    'node:fs',
    'node:crypto',
    'node:fs/promises',
    'node:net',
    'node:os',
    'node:path',
    'node:url',
  ]),
  types: new Set(['../review/types.js']),
  expected: [
    'gh-answer.ts',
    'gh-bridge.ts',
    'gh-command.ts',
    'gh-jq.ts',
    'gh-server.ts',
    'git-bridge.ts',
    'git-guard.ts',
    'types.ts',
  ],
  globals: ['console'],
}
const GRAPH: Boundary = {
  dir: 'graph',
  values: new Set(['node:path', '../review/diff-lines.js']),
  types: new Set([
    '../repo-map/languages.js',
    '../repo-map/types.js',
    '../store/index-reader.js',
    '../store/observed-store.js',
    '../review/types.js',
  ]),
  expected: [
    'impact.ts',
    'linked-graph.ts',
    'observe.ts',
    'packages.ts',
    'project-config.ts',
    'report.ts',
    'repository-graph.ts',
    'repository-links.ts',
    'resolve-module.ts',
    'resolve-name.ts',
    'similar.ts',
    'toml.ts',
    'types.ts',
  ],
}
const APP: Boundary = {
  dir: 'app',
  values: new Set([
    'node:path',
    '../gh-facade/gh-server.js',
    '../process/work-dirs.js',
    '../repository/work-tree.js',
    '../review/native-context.js',
    '../review/convert-prompt.js',
    '../watch/filters.js',
    '../config/errors.js',
    '../context/load-context.js',
    '../context/list-context.js',
    '../context/split-diff.js',
    '../skills/errors.js',
    '../config/merge-config.js',
    '../config/parse-config.js',
    '../context/ignore.js',
    '../graph/impact.js',
    '../graph/linked-graph.js',
    '../graph/observe.js',
    '../graph/packages.js',
    '../graph/report.js',
    '../graph/repository-graph.js',
    '../graph/repository-links.js',
    '../investigation/create-investigation.js',
    '../investigation/mcp/mcp-client.js',
    '../investigation/tools/mcp-tools.js',
    '../investigation/tools/report.js',
    '../publish/decide-run.js',
    '../publish/feedback.js',
    '../publish/markers.js',
    '../publish/plan-publication.js',
    '../publish/recheck-candidates.js',
    '../repo-map/languages.js',
    '../repository/git-checkout.js',
    '../review/diff-fingerprint.js',
    '../review/impact-text.js',
    '../review/prompt.js',
    '../review/recheck-threads.js',
    '../review/run-review.js',
    '../store/index-store.js',
    '../watch/failures.js',
    '../watch/next-job.js',
    '../watch/plan-cycle.js',
    '../watch/request-policy.js',
    '../watch/time.js',
  ]),
  types: new Set([
    '../gh-facade/gh-server.js',
    '../gh-facade/types.js',
    '../repository/work-tree.js',
    '../config/mcp-servers.js',
    '../config/types.js',
    '../config/watch-settings.js',
    '../context/types.js',
    '../github/compare-commits.js',
    '../github/create-review.js',
    '../github/pull-request-ref.js',
    '../github/pull-request-reviews.js',
    '../github/list-pull-requests.js',
    '../github/pull-request.js',
    '../github/repository.js',
    '../graph/packages.js',
    '../graph/report.js',
    '../graph/repository-links.js',
    '../graph/types.js',
    '../investigation/create-investigation.js',
    '../investigation/mcp/mcp-client.js',
    '../investigation/tools/mcp-tools.js',
    '../investigation/toolbox.js',
    '../investigation/tools/report.js',
    '../investigation/tools/tool-log.js',
    '../providers/types.js',
    '../publish/recheck-candidates.js',
    '../publish/types.js',
    '../repo-map/extract.js',
    '../repo-map/languages.js',
    '../repository/checkout.js',
    '../repository/git-checkout.js',
    '../repository/git-mirror.js',
    '../review/types.js',
    '../store/index-store.js',
    '../store/history-store.js',
    '../watch/types.js',
    '../store/observed-store.js',
  ]),
  expected: [
    'error-message.ts',
    'feedback.ts',
    'review-and-publish.ts',
    'watch-repositories.ts',
    'index-repository.ts',
    'related-report.ts',
    'related-repositories.ts',
    'review-pull-request.ts',
    'select-related.ts',
  ],
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

describe('watch boundary rules', () => {
  it('accepts type-only imports of the settings, the listing and the history records', () => {
    const code = [
      "import type { WatchedRepoSettings } from '../config/watch-settings.js'",
      "import type { OpenPull } from '../github/list-pull-requests.js'",
      "import type { JobRecord } from './types.js'",
      "import { later } from './failures.js'",
    ].join('\n')

    expect(boundaryViolations(code, WATCH)).toEqual([])
  })

  it.each([
    [
      'a value import of the history store',
      "import { openHistoryStore } from '../store/history-store.js'",
    ],
    ['the GitHub client', "import { listOpenPullRequests } from '../github/list-pull-requests.js'"],
    ['the clock', 'const now = Date.now()'],
    ['a timer', 'setTimeout(() => {}, 10)'],
  ])('flags %s', (_case, code) => {
    expect(boundaryViolations(code, WATCH)).not.toEqual([])
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
      "import { createInvestigation } from '../investigation/create-investigation.js'",
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

describe.each([
  REVIEW,
  PUBLISH,
  WATCH,
  CONTEXT,
  INVESTIGATION,
  REPOSITORY,
  REPO_MAP,
  STORE,
  GRAPH,
  APP,
  SKILLS,
  GH_FACADE,
])('$dir boundary', (boundary) => {
  const sources = sourcesOf(boundary)

  it('has source files to check', () => {
    expect(sources.map(({ name }) => name)).toEqual(expect.arrayContaining(boundary.expected))
  })

  it.each(sources)('$name stays inside the boundary', ({ name, code }) => {
    expect(boundaryViolations(code, boundary, name)).toEqual([])
  })
})
