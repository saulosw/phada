import { posix } from 'node:path'
import type { EffectiveConfig } from '../config/merge-config.js'
import type { ConfigLayer } from '../config/types.js'
import type { RepositoryTree } from '../github/repository-files.js'
import { docScope } from './doc-scope.js'
import { DEFAULT_IGNORE } from './ignore.js'
import {
  localCandidates,
  mapLimit,
  mergeLayers,
  READ_CONCURRENCY,
  readDoc,
  readRepositoryLayers,
  readTree,
  userConfigFiles,
} from './load-context.js'
import type { DocContent, PlannedDoc } from './load-context.js'
import { byteLength, DOCS_BUDGET_BYTES, repositoryDocCandidates } from './select-docs.js'
import type { ContextReport, ContextSources, DocReport, RuleReport } from './types.js'

const FOLDER_INSTRUCTIONS = new Set(['agents.md', 'claude.md', 'gemini.md'])
const NESTED_RULES = '/.cursor/rules/'

export interface ListedContext {
  report: ContextReport
  ignore: string[]
}

export async function listContext(input: {
  ref: string
  userLayers: readonly ConfigLayer[]
  sources: ContextSources
}): Promise<ListedContext> {
  const { sources, userLayers, ref } = input
  const warnings: string[] = []
  const tree = await readTree(sources, ref, warnings)
  const repository =
    tree === undefined
      ? { layers: [], configFiles: [] }
      : await readRepositoryLayers(tree, phadaFolders(tree), sources, ref, warnings)
  const merged = mergeLayers(userLayers, repository.layers)
  warnings.push(...merged.warnings)
  const docs = await listDocs(merged, tree, sources, ref, warnings)
  return {
    report: {
      configFiles: [...userConfigFiles(userLayers), ...repository.configFiles],
      rules: merged.rules.map((rule): RuleReport => ({
        key: rule.key,
        origin: rule.origin,
        scope: [...rule.scope],
        ...(rule.severity === undefined ? {} : { severity: rule.severity }),
        status: merged.disabledRules.has(rule.key) ? 'disabled' : 'listed',
      })),
      docs,
      ignored: [],
      budget: { limit: DOCS_BUDGET_BYTES, used: 0 },
      warnings,
    },
    ignore: [...DEFAULT_IGNORE, ...merged.ignore],
  }
}

function phadaFolders(tree: RepositoryTree): string[] {
  const dirs = new Set([''])
  for (const { path } of tree.entries) {
    const match = /^(?:(.*)\/)?\.phada\/(?:config\.yml|rules\.md)$/.exec(path)
    if (match !== null) dirs.add(match[1] ?? '')
  }
  return [...dirs].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
}

function instructionFolders(tree: RepositoryTree): Set<string> {
  const dirs = new Set<string>()
  for (const { path } of tree.entries) {
    const nested = path.indexOf(NESTED_RULES)
    if (nested > 0 && path.endsWith('.mdc')) dirs.add(path.slice(0, nested))
    const dir = posix.dirname(path)
    if (dir !== '.' && FOLDER_INSTRUCTIONS.has(posix.basename(path).toLowerCase())) dirs.add(dir)
  }
  return dirs
}

async function listDocs(
  merged: EffectiveConfig,
  tree: RepositoryTree | undefined,
  sources: ContextSources,
  ref: string,
  warnings: string[],
): Promise<DocReport[]> {
  const report: DocReport[] = []
  const folders = tree === undefined ? new Set<string>() : instructionFolders(tree)
  const repository =
    tree === undefined
      ? { candidates: [], missing: [] }
      : repositoryDocCandidates({
          entries: tree.entries,
          complete: !tree.truncated,
          changedFiles: [...folders].map((dir) => `${dir}/.`),
          declared: merged.files,
          defaults: merged.contextDefaults,
        })
  for (const file of repository.missing) {
    warnings.push(`${file.origin}: ${file.pattern} matches no file at ${ref}.`)
    report.push(notFound(file.pattern))
  }
  const fromRepository = repository.candidates
    .filter((doc) => doc.category !== 'module' || folders.has(doc.dir ?? posix.dirname(doc.path)))
    .map((doc): PlannedDoc => ({ ...doc, source: 'repository', readPath: doc.path }))
  const local = await localCandidates(merged, sources, warnings, report)
  const declaredCount = fromRepository.filter((doc) => doc.category === 'declared').length
  const planned = [
    ...fromRepository.slice(0, declaredCount),
    ...local,
    ...fromRepository.slice(declaredCount),
  ]
  const needsReading = (doc: PlannedDoc) => doc.size === undefined || doc.format !== undefined
  const contents = new Map<PlannedDoc, DocContent>()
  await mapLimit(planned.filter(needsReading), READ_CONCURRENCY, async (doc) => {
    contents.set(doc, await readDoc(doc, sources))
  })
  for (const doc of planned) {
    const entry = listedDoc(doc, contents.get(doc), needsReading(doc), ref, warnings)
    if (entry !== undefined) report.push(entry)
  }
  return report
}

function listedDoc(
  doc: PlannedDoc,
  content: DocContent | undefined,
  read: boolean,
  ref: string,
  warnings: string[],
): DocReport | undefined {
  const base = { path: doc.path, origin: doc.source, category: doc.category }
  if (!read) return { ...base, bytes: doc.size ?? 0, status: 'listed' }
  if (content instanceof Error) {
    warnings.push(`Could not read ${doc.path} at ${ref}: ${content.message}`)
    return { ...base, bytes: doc.size ?? 0, status: 'omitted', reason: 'unreadable' }
  }
  if (content === null || content === undefined) {
    return doc.category === 'declared' ? notFound(doc.path) : undefined
  }
  const bytes = byteLength(content)
  if (doc.format === undefined) {
    return { ...base, bytes, status: 'listed' }
  }
  const scope = docScope(doc.format, content, doc.dir ?? '')
  switch (scope.kind) {
    case 'globs':
      return { ...base, bytes, status: 'listed', scope: scope.patterns }
    case 'manual':
    case 'excluded':
      return { ...base, bytes, status: 'omitted', reason: scope.kind }
    case 'invalid':
      warnings.push(`${doc.path}: could not read its front matter; included without a scope.`)
      return { ...base, bytes, status: 'listed' }
    default:
      return { ...base, bytes, status: 'listed' }
  }
}

function notFound(path: string): DocReport {
  return {
    path,
    origin: 'repository',
    category: 'declared',
    bytes: 0,
    status: 'omitted',
    reason: 'not-found',
  }
}

function depth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length
}
