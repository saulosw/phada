import { posix } from 'node:path'

export interface TsPaths {
  baseUrl?: string
  paths: readonly { pattern: string; targets: string[] }[]
}

export interface GoModule {
  dir: string
  module: string
}

export interface ProjectConfig {
  tsconfigs: ReadonlyMap<string, TsPaths>
  goModules: readonly GoModule[]
  pythonRoots: readonly string[]
}

const TS_CONFIG = /(^|\/)(tsconfig|jsconfig)\.json$/
const GO_MOD = /(^|\/)go\.mod$/
const PYTHON_PROJECT = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/
const MAX_EXTENDS = 5

type ReadText = (path: string) => Promise<string>

export async function loadProjectConfig(
  paths: ReadonlySet<string>,
  readText: ReadText,
): Promise<ProjectConfig> {
  const all = [...paths].sort()
  const tsconfigs = new Map<string, TsPaths>()
  for (const path of all.filter((item) => TS_CONFIG.test(item))) {
    const dir = dirOf(path)
    if (tsconfigs.has(dir) && path.endsWith('jsconfig.json')) continue
    const loaded = await loadTsConfig(path, paths, readText, 0)
    if (loaded !== undefined) tsconfigs.set(dir, loaded)
  }
  const goModules: GoModule[] = []
  for (const path of all.filter((item) => GO_MOD.test(item))) {
    const text = await readText(path).catch(() => '')
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
  return { tsconfigs, goModules, pythonRoots }
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
