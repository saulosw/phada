import { mergeConfig } from '../config/merge-config.js'
import type { EffectiveConfig } from '../config/merge-config.js'
import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import type { RepositoryTree } from '../github/repository-files.js'
import type { ContextDoc, ContextRule } from '../review/types.js'
import { applyIgnore, DEFAULT_IGNORE, matcher } from './ignore.js'
import { phadaDirs, phadaFiles } from './phada-paths.js'
import {
  byteLength,
  DOC_LIMIT_BYTES,
  DOCS_BUDGET_BYTES,
  fitDoc,
  repositoryDocCandidates,
  truncateDoc,
} from './select-docs.js'
import type { DocCandidate } from './select-docs.js'
import { splitDiff } from './split-diff.js'
import type {
  ConfigFileReport,
  ContextSources,
  DocReport,
  LoadedContext,
  RuleReport,
} from './types.js'

const READ_CONCURRENCY = 4

type DocContent = string | null | Error

interface PlannedDoc extends DocCandidate {
  source: 'repository' | 'local'
  readPath: string
}

interface RepositoryLayers {
  layers: ConfigLayer[]
  configFiles: ConfigFileReport[]
}

export async function loadContext(input: {
  diff: string
  baseSha: string
  userLayers: readonly ConfigLayer[]
  sources: ContextSources
}): Promise<LoadedContext> {
  const { sources, userLayers } = input
  const sha = input.baseSha.slice(0, 7)
  const warnings: string[] = []
  const tree = await readTree(sources, sha, warnings)
  const changed = splitDiff(input.diff).sections.map((section) => section.path)
  const repository =
    tree === undefined
      ? { layers: [], configFiles: [] }
      : await readRepositoryLayers(tree, changed, sources, sha, warnings)
  const merged = mergeConfig([
    ...userLayers.filter((layer) => layer.kind === 'user'),
    ...repository.layers,
    ...userLayers.filter((layer) => layer.kind === 'user-repo'),
  ])
  warnings.push(...merged.warnings)
  const { diff, files, ignored } = applyIgnore(input.diff, [...DEFAULT_IGNORE, ...merged.ignore])
  const rules = selectRules(merged, files)
  const docs = await collectDocs(merged, tree, files, sources, sha, warnings)
  return {
    diff,
    options: {
      ...(merged.language === undefined ? {} : { language: merged.language }),
      ...(merged.minConfidence === undefined ? {} : { minConfidence: merged.minConfidence }),
      ...(merged.verify === undefined ? {} : { verify: merged.verify }),
      ...(merged.investigate === undefined ? {} : { investigate: merged.investigate }),
    },
    context: { rules: rules.applied, docs: docs.docs, ignored },
    report: {
      configFiles: [
        ...userLayers.map((layer): ConfigFileReport => ({
          path: layer.configLabel,
          origin: 'user',
          status: 'loaded',
        })),
        ...repository.configFiles,
      ],
      rules: rules.report,
      docs: docs.report,
      ignored,
      budget: { limit: DOCS_BUDGET_BYTES, used: docs.used },
      warnings,
    },
  }
}

async function readTree(
  sources: ContextSources,
  sha: string,
  warnings: string[],
): Promise<RepositoryTree | undefined> {
  try {
    const tree = await sources.readTree()
    if (tree.truncated) {
      warnings.push(
        `The repository tree at ${sha} is too large to list: only known paths were read.`,
      )
    }
    return tree
  } catch (error) {
    warnings.push(
      `Could not read the repository at ${sha} (${messageOf(error)}): reviewing without its rules and docs. Reading them needs a token with Contents: read.`,
    )
    return undefined
  }
}

async function readRepositoryLayers(
  tree: RepositoryTree,
  changed: readonly string[],
  sources: ContextSources,
  sha: string,
  warnings: string[],
): Promise<RepositoryLayers> {
  const present = new Set(tree.entries.map((entry) => entry.path))
  const wanted = (path: string) => tree.truncated || present.has(path)
  const dirs = phadaDirs(changed)
  const texts = await mapLimit(dirs, READ_CONCURRENCY, async (dir) => {
    const { config, rules } = phadaFiles(dir)
    const [configText, rulesText] = await Promise.all(
      [config, rules].map((path) =>
        wanted(path) ? readRepositoryText(sources, path, sha, warnings) : null,
      ),
    )
    return { dir, config, rules, configText: configText ?? null, rulesText: rulesText ?? null }
  })
  const result: RepositoryLayers = { layers: [], configFiles: [] }
  for (const { dir, config, rules, configText, rulesText } of texts) {
    if (configText === null && rulesText === null) continue
    const parsed = parseConfigText(configText ?? '')
    if (configText !== null) {
      result.configFiles.push({
        path: config,
        origin: 'repository',
        status: parsed.ok ? 'loaded' : 'invalid',
        ...(parsed.ok ? {} : { message: parsed.message }),
      })
    }
    if (!parsed.ok) warnings.push(`Ignoring ${config} at ${sha}: ${parsed.message}`)
    if (rulesText !== null) {
      result.configFiles.push({ path: rules, origin: 'repository', status: 'loaded' })
    }
    result.layers.push({
      kind: dir === '' ? 'repo-root' : 'repo-dir',
      dir,
      configLabel: config,
      config: parsed.ok ? parsed.config : {},
      ...(rulesText === null ? {} : { rulesMarkdown: { label: rules, text: rulesText } }),
    })
  }
  return result
}

async function readRepositoryText(
  sources: ContextSources,
  path: string,
  sha: string,
  warnings: string[],
): Promise<string | null> {
  try {
    return await sources.readRepoFile(path)
  } catch (error) {
    warnings.push(`Could not read ${path} at ${sha}: ${messageOf(error)}`)
    return null
  }
}

function selectRules(
  merged: EffectiveConfig,
  files: readonly string[],
): { applied: ContextRule[]; report: RuleReport[] } {
  const applied: ContextRule[] = []
  const report: RuleReport[] = []
  for (const rule of merged.rules) {
    const inScope = files.filter(matcher(rule.scope))
    const except = merged.disabledIn.get(rule.key) ?? []
    const turnedOff = matcher(except)
    const status =
      merged.disabledRules.has(rule.key) || (inScope.length > 0 && inScope.every(turnedOff))
        ? 'disabled'
        : inScope.length > 0
          ? 'applied'
          : 'out-of-scope'
    report.push({ key: rule.key, origin: rule.origin, status })
    if (status === 'applied') applied.push(except.length === 0 ? rule : { ...rule, except })
  }
  return { applied, report }
}

async function collectDocs(
  merged: EffectiveConfig,
  tree: RepositoryTree | undefined,
  files: readonly string[],
  sources: ContextSources,
  sha: string,
  warnings: string[],
): Promise<{ docs: ContextDoc[]; report: DocReport[]; used: number }> {
  const report: DocReport[] = []
  const repository =
    tree === undefined
      ? { candidates: [], missing: [] }
      : repositoryDocCandidates({
          entries: tree.entries,
          complete: !tree.truncated,
          changedFiles: files,
          declared: merged.files,
          defaults: merged.contextDefaults,
        })
  for (const file of repository.missing) {
    warnings.push(`${file.origin}: ${file.pattern} matches no file at ${sha}.`)
    report.push(omitted(file.pattern, 'repository', 'not-found'))
  }
  const local = await localCandidates(merged, sources, warnings, report)
  const fromRepository = repository.candidates.map((candidate): PlannedDoc => ({
    ...candidate,
    source: 'repository',
    readPath: candidate.path,
  }))
  const declaredCount = fromRepository.filter((doc) => doc.category === 'declared').length
  const planned = [
    ...fromRepository.slice(0, declaredCount),
    ...local,
    ...fromRepository.slice(declaredCount),
  ]
  const probing = tree?.truncated ?? false
  return fillBudget(planned, sources, sha, warnings, report, probing)
}

async function localCandidates(
  merged: EffectiveConfig,
  sources: ContextSources,
  warnings: string[],
  report: DocReport[],
): Promise<PlannedDoc[]> {
  const planned: PlannedDoc[] = []
  const seen = new Set<string>()
  for (const ref of merged.localFiles) {
    let docs
    try {
      docs = await sources.listLocalDocs(ref.path)
    } catch (error) {
      warnings.push(`${ref.origin}: could not read ${ref.path}: ${messageOf(error)}`)
      report.push(omitted(`local:${ref.path}`, 'local', 'unreadable'))
      continue
    }
    if (docs === null) {
      warnings.push(`${ref.origin}: ${ref.path} does not exist.`)
      report.push(omitted(`local:${ref.path}`, 'local', 'not-found'))
      continue
    }
    for (const doc of docs) {
      if (seen.has(doc.path)) continue
      seen.add(doc.path)
      planned.push({
        path: `local:${doc.path}`,
        category: 'declared',
        size: doc.size,
        origin: ref.origin,
        source: 'local',
        readPath: doc.path,
      })
    }
  }
  return planned
}

async function fillBudget(
  planned: readonly PlannedDoc[],
  sources: ContextSources,
  sha: string,
  warnings: string[],
  report: DocReport[],
  probing: boolean,
): Promise<{ docs: ContextDoc[]; report: DocReport[]; used: number }> {
  const contents = new Map<PlannedDoc, DocContent>()
  const read = (docs: readonly PlannedDoc[]) =>
    mapLimit(docs, READ_CONCURRENCY, async (doc) => {
      contents.set(doc, await readDoc(doc, sources))
    })
  await read(planned.filter((doc) => doc.size === undefined))
  const dropped = new Set<PlannedDoc>()
  const skipped = new Set<PlannedDoc>()
  for (const doc of planned.filter((candidate) => candidate.size === undefined)) {
    if (typeof contents.get(doc) === 'string') continue
    const silent = contents.get(doc) === null && doc.category !== 'declared' && probing
    if (silent) skipped.add(doc)
    else dropped.add(doc)
  }

  let plan = planBudget(planned, contents, (doc) => dropped.has(doc) || skipped.has(doc))
  for (;;) {
    await read(plan.chosen.filter((doc) => !contents.has(doc)))
    const failed = plan.chosen.filter((doc) => dropReason(contents.get(doc)) !== undefined)
    if (failed.length === 0) break
    for (const doc of failed) dropped.add(doc)
    plan = planBudget(planned, contents, (doc) => dropped.has(doc) || skipped.has(doc))
  }

  report.push(...plan.omitted)
  for (const doc of planned.filter((candidate) => dropped.has(candidate))) {
    const content = contents.get(doc)
    if (content instanceof Error) {
      warnings.push(`Could not read ${doc.path} at ${sha}: ${content.message}`)
    }
    const bytes = typeof content === 'string' ? byteLength(content) : (doc.size ?? 0)
    report.push({
      ...omitted(doc.path, doc.source, dropReason(content) ?? 'not-found', doc),
      bytes,
    })
  }
  const docs: ContextDoc[] = []
  let used = 0
  for (const doc of plan.chosen) {
    const content = contents.get(doc)
    if (typeof content !== 'string') continue
    const bytes = byteLength(content)
    const truncated = bytes > DOC_LIMIT_BYTES
    const shown = truncated ? truncateDoc(content) : content
    used += truncated ? byteLength(shown.slice(0, shown.lastIndexOf('\n['))) : bytes
    docs.push({ path: doc.path, content: shown })
    report.push({
      path: doc.path,
      origin: doc.source,
      category: doc.category,
      bytes,
      status: truncated ? 'truncated' : 'included',
    })
  }
  return { docs, report: orderLike(report, planned), used }
}

function planBudget(
  planned: readonly PlannedDoc[],
  contents: ReadonlyMap<PlannedDoc, DocContent>,
  isOut: (doc: PlannedDoc) => boolean,
): { chosen: PlannedDoc[]; omitted: DocReport[] } {
  let remaining = DOCS_BUDGET_BYTES
  const chosen: PlannedDoc[] = []
  const omittedDocs: DocReport[] = []
  for (const doc of planned) {
    if (isOut(doc)) continue
    const content = contents.get(doc)
    const size = doc.size ?? (typeof content === 'string' ? byteLength(content) : 0)
    if (fitDoc(size, remaining) === 'omitted') {
      omittedDocs.push({ ...omitted(doc.path, doc.source, 'budget', doc), bytes: size })
      continue
    }
    remaining -= Math.min(size, DOC_LIMIT_BYTES)
    chosen.push(doc)
  }
  return { chosen, omitted: omittedDocs }
}

function dropReason(content: DocContent | undefined): DocReport['reason'] | undefined {
  if (content instanceof Error) return 'unreadable'
  if (content === null || content === undefined) return 'not-found'
  return content.includes('\u0000') ? 'binary' : undefined
}

async function readDoc(doc: PlannedDoc, sources: ContextSources): Promise<DocContent> {
  try {
    return doc.source === 'local'
      ? await sources.readLocalFile(doc.readPath)
      : await sources.readRepoFile(doc.readPath)
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

function omitted(
  path: string,
  origin: 'repository' | 'local',
  reason: NonNullable<DocReport['reason']>,
  doc?: PlannedDoc,
): DocReport {
  return {
    path,
    origin,
    category: doc?.category ?? 'declared',
    bytes: doc?.size ?? 0,
    status: 'omitted',
    reason,
  }
}

function orderLike(report: readonly DocReport[], planned: readonly PlannedDoc[]): DocReport[] {
  const order = new Map(planned.map((doc, index) => [doc.path, index]))
  const rank = (entry: DocReport) => order.get(entry.path) ?? Number.MAX_SAFE_INTEGER
  return [...report].sort((a, b) => rank(a) - rank(b))
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
