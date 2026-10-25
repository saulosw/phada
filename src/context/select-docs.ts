import { posix } from 'node:path'
import { escapeGlob } from '../config/merge-config.js'
import type { DeclaredFile } from '../config/merge-config.js'
import type { DocFormat } from './doc-scope.js'
import { byteLength } from './byte-cut.js'
import { matcher } from './ignore.js'

export type DocCategory = 'declared' | 'module' | 'agents' | 'contributing' | 'other'

export interface TreeEntry {
  path: string
  size: number
}

export interface DocCandidate {
  path: string
  category: DocCategory
  size?: number
  origin: string
  format?: DocFormat
  dir?: string
}

export type Fit = 'whole' | 'truncated' | 'omitted'

export const DOCS_BUDGET_BYTES = 60_000
export const DOC_LIMIT_BYTES = 20_000

const MODULE_NAMES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
const AGENT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md']
const AGENT_GLOB = '.claude/rules/**/*.md'
const INSTRUCTIONS_PATH = '.github/copilot-instructions.md'
const INSTRUCTIONS_GLOB = '.github/instructions/**/*.instructions.md'
const MDC_GLOB = '.cursor/rules/**/*.mdc'
const LATE_AGENT_PATHS = ['.cursorrules', '.windsurfrules', 'GEMINI.md']
const CONTRIBUTING_PATHS = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
  'README.md',
]
const OTHER_GLOBS = ['*.md', 'docs/**/*.md']
const EXCLUDED =
  /^(changelog|changes|history|license|licence|notice|code_of_conduct|security|authors)(\.[^.]+)?$/i
const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|pdf|zip|gz|tgz|tar|7z|jar|woff2?|ttf|otf|eot|mp[34]|mov|webm|wasm|exe|dll|so|dylib|class|bin)$/i
const GLOB_CHARS = /[*?[\]{}!]/

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function fitDoc(size: number, remaining: number): Fit {
  if (size <= DOC_LIMIT_BYTES) return size <= remaining ? 'whole' : 'omitted'
  return DOC_LIMIT_BYTES <= remaining ? 'truncated' : 'omitted'
}

export function truncateDoc(content: string): string {
  const bytes = encoder.encode(content)
  const head = decoder.decode(bytes.slice(0, DOC_LIMIT_BYTES)).replace(/�$/, '')
  const lineEnd = head.lastIndexOf('\n')
  const kept = lineEnd > 0 ? head.slice(0, lineEnd) : head
  return `${kept}\n[truncated by Phada: ${byteLength(kept)} of ${bytes.length} bytes]`
}

interface Scoped {
  format: DocFormat
  dir: string
}

export function repositoryDocCandidates(input: {
  entries: readonly TreeEntry[]
  complete: boolean
  changedFiles: readonly string[]
  declared: readonly DeclaredFile[]
  defaults: boolean
}): { candidates: DocCandidate[]; missing: DeclaredFile[] } {
  const sizes = new Map(input.entries.map((entry) => [entry.path, entry.size]))
  const byLowerPath = new Map(input.entries.map((entry) => [entry.path.toLowerCase(), entry.path]))
  const paths = input.entries.map((entry) => entry.path).sort(compare)
  const seen = new Set<string>()
  const candidates: DocCandidate[] = []
  const missing: DeclaredFile[] = []

  const add = (path: string, category: DocCategory, origin: string, scoped?: Scoped) => {
    if (seen.has(path)) return
    seen.add(path)
    const size = sizes.get(path)
    candidates.push({
      path,
      category,
      ...(size === undefined ? {} : { size }),
      origin,
      ...(scoped ?? {}),
    })
  }
  const addMatching = (glob: string, category: DocCategory, scoped: Scoped) => {
    for (const path of paths.filter(matcher([glob]))) add(path, category, 'default', scoped)
  }
  const addKnown = (path: string, category: DocCategory) => {
    const actual = byLowerPath.get(path.toLowerCase())
    if (actual !== undefined) add(actual, category, 'default')
    else if (!input.complete) add(path, category, 'default')
  }

  for (const file of input.declared) {
    if (GLOB_CHARS.test(file.pattern)) {
      const matches = paths
        .filter(matcher([file.pattern]))
        .filter((path) => !BINARY_EXTENSION.test(path))
      if (matches.length === 0 && input.complete) missing.push(file)
      for (const path of matches) add(path, 'declared', file.origin)
    } else if (sizes.has(file.pattern) || !input.complete) {
      add(file.pattern, 'declared', file.origin)
    } else {
      missing.push(file)
    }
  }
  if (!input.defaults) return { candidates, missing }

  for (const dir of moduleDirs(input.changedFiles)) {
    for (const name of MODULE_NAMES) addKnown(`${dir}/${name}`, 'module')
    addMatching(`${escapeGlob(dir)}/${MDC_GLOB}`, 'module', { format: 'mdc', dir })
  }
  for (const path of AGENT_PATHS) addKnown(path, 'agents')
  for (const path of paths.filter(matcher([AGENT_GLOB]))) add(path, 'agents', 'default')
  addKnown(INSTRUCTIONS_PATH, 'agents')
  addMatching(INSTRUCTIONS_GLOB, 'agents', { format: 'instructions', dir: '' })
  addMatching(MDC_GLOB, 'agents', { format: 'mdc', dir: '' })
  for (const path of LATE_AGENT_PATHS) addKnown(path, 'agents')
  for (const path of CONTRIBUTING_PATHS) addKnown(path, 'contributing')
  for (const path of paths.filter(matcher(OTHER_GLOBS))) {
    if (!EXCLUDED.test(posix.basename(path))) add(path, 'other', 'default')
  }
  return { candidates, missing }
}

function moduleDirs(changedFiles: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const file of changedFiles) {
    let dir = posix.dirname(file)
    while (dir !== '.' && dir !== '' && dir !== '/') {
      dirs.add(dir)
      dir = posix.dirname(dir)
    }
  }
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || compare(a, b))
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
