import { posix } from 'node:path'

export interface TsPaths {
  baseUrl?: string
  paths: readonly { pattern: string; targets: string[] }[]
}

export interface GoModule {
  dir: string
  module: string
}

export interface WorkspacePackage {
  name: string
  dir: string
  exports: readonly { pattern: string; target: string }[]
  main?: string
}

export interface ProjectConfig {
  tsconfigs: ReadonlyMap<string, TsPaths>
  goModules: readonly GoModule[]
  pythonRoots: readonly string[]
  workspacePackages: readonly WorkspacePackage[]
}

const TS_CONFIG = /(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$/
const MAIN_TS_CONFIG = /(^|\/)(tsconfig|jsconfig)\.json$/
const GO_MOD = /(^|\/)go\.mod$/
const PACKAGE_JSON = /(^|\/)package\.json$/
const EXPORT_CONDITIONS = ['import', 'default', 'require', 'node']
const PYTHON_PROJECT = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/
const MAX_EXTENDS = 5
export const DEPENDENCY_FOLDER = /(^|\/)(node_modules|bower_components|\.venv|venv|site-packages|vendor)\//
export const MAX_CONFIG_FILES = 300

type ReadText = (path: string) => Promise<string>

export async function loadProjectConfig(
  paths: ReadonlySet<string>,
  readText: ReadText,
): Promise<ProjectConfig> {
  const all = [...paths]
    .filter((path) => !DEPENDENCY_FOLDER.test(path))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
  let reads = 0
  const read: ReadText = async (path) => {
    reads += 1
    if (reads > MAX_CONFIG_FILES) throw new Error('too many config files')
    return readText(path)
  }
  const tsconfigs = new Map<string, TsPaths>()
  const configFiles = all
    .filter((item) => TS_CONFIG.test(item))
    .sort(
      (a, b) =>
        a.split('/').length - b.split('/').length ||
        Number(MAIN_TS_CONFIG.test(b)) - Number(MAIN_TS_CONFIG.test(a)) ||
        (a < b ? -1 : 1),
    )
  for (const path of configFiles) {
    if (reads >= MAX_CONFIG_FILES) break
    const loaded = await loadTsConfig(path, paths, read, 0)
    if (loaded === undefined) continue
    const dir = dirOf(path)
    const known = tsconfigs.get(dir)
    if (known === undefined) {
      tsconfigs.set(dir, loaded)
      continue
    }
    const patterns = new Set(known.paths.map((entry) => entry.pattern))
    const baseUrl = known.baseUrl ?? loaded.baseUrl
    tsconfigs.set(dir, {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      paths: [...known.paths, ...loaded.paths.filter((entry) => !patterns.has(entry.pattern))],
    })
  }
  const goModules: GoModule[] = []
  for (const path of all.filter((item) => GO_MOD.test(item))) {
    if (reads >= MAX_CONFIG_FILES) break
    const text = await read(path).catch(() => '')
    const match = /^\s*module\s+"?([^\s"]+)"?/m.exec(text)
    if (match?.[1] !== undefined) goModules.push({ dir: dirOf(path), module: match[1] })
  }
  const pythonRoots = ['', 'src']
  for (const path of all.filter((item) => PYTHON_PROJECT.test(item))) {
    const dir = dirOf(path)
    for (const root of [dir, dir === '' ? 'src' : `${dir}/src`]) {
      if (!pythonRoots.includes(root)) pythonRoots.push(root)
    }
  }
  const workspacePackages: WorkspacePackage[] = []
  for (const path of all.filter((item) => PACKAGE_JSON.test(item))) {
    if (reads >= MAX_CONFIG_FILES) break
    const parsed = parseJsonc(await read(path).catch(() => ''))
    if (typeof parsed !== 'object' || parsed === null) continue
    const manifest = parsed as { name?: unknown; main?: unknown; exports?: unknown }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    workspacePackages.push({
      name: manifest.name,
      dir: dirOf(path),
      exports: exportEntries(manifest.exports),
      ...(typeof manifest.main === 'string' ? { main: manifest.main } : {}),
    })
  }
  return { tsconfigs, goModules, pythonRoots, workspacePackages }
}

function exportEntries(exports: unknown): { pattern: string; target: string }[] {
  if (typeof exports === 'string') return [{ pattern: '.', target: exports }]
  if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) return []
  const entries = Object.entries(exports as Record<string, unknown>)
  if (entries.every(([key]) => !key.startsWith('.'))) {
    const target = conditionTarget(exports)
    return target === undefined ? [] : [{ pattern: '.', target }]
  }
  return entries.flatMap(([pattern, value]) => {
    if (!pattern.startsWith('.') || pattern.endsWith('package.json')) return []
    const target = conditionTarget(value)
    return target === undefined ? [] : [{ pattern, target }]
  })
}

function conditionTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  const conditions = value as Record<string, unknown>
  for (const condition of EXPORT_CONDITIONS) {
    const target = conditionTarget(conditions[condition])
    if (target !== undefined) return target
  }
  return undefined
}

async function loadTsConfig(
  path: string,
  paths: ReadonlySet<string>,
  readText: ReadText,
  depth: number,
): Promise<TsPaths | undefined> {
  const text = await readText(path).catch(() => undefined)
  const parsed = text === undefined ? undefined : parseJsonc(text)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined
  const dir = dirOf(path)
  const config = parsed as { extends?: unknown; compilerOptions?: unknown }
  let inherited: TsPaths = { paths: [] }
  if (typeof config.extends === 'string' && depth < MAX_EXTENDS && config.extends.startsWith('.')) {
    const target = posix.normalize(posix.join(dir, config.extends))
    const file = paths.has(target)
      ? target
      : paths.has(`${target}.json`)
        ? `${target}.json`
        : undefined
    if (file !== undefined)
      inherited = (await loadTsConfig(file, paths, readText, depth + 1)) ?? inherited
  }
  const options =
    typeof config.compilerOptions === 'object' && config.compilerOptions !== null
      ? (config.compilerOptions as { baseUrl?: unknown; paths?: unknown })
      : {}
  const baseUrl =
    typeof options.baseUrl === 'string' ? repoPath(dir, options.baseUrl) : inherited.baseUrl
  let aliases = inherited.paths
  if (typeof options.paths === 'object' && options.paths !== null) {
    const from = typeof options.baseUrl === 'string' ? (baseUrl ?? dir) : dir
    aliases = Object.entries(options.paths as Record<string, unknown>).map(
      ([pattern, targets]) => ({
        pattern,
        targets: (Array.isArray(targets) ? targets : [])
          .filter((target): target is string => typeof target === 'string')
          .map((target) => repoPath(from, target)),
      }),
    )
  }
  return { ...(baseUrl === undefined ? {} : { baseUrl }), paths: aliases }
}

function repoPath(dir: string, relative: string): string {
  const joined = posix.normalize(posix.join(dir, relative))
  return joined === '.' ? '' : joined.replace(/^\.\//, '').replace(/\/$/, '')
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[i + 1] ?? ''
        i += 1
      } else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) return undefined
      i += 1
    } else out += char
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}
