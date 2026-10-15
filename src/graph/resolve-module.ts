import { posix } from 'node:path'
import type { Language } from '../repo-map/languages.js'
import { dirOf } from './project-config.js'
import type { ProjectConfig } from './project-config.js'

export type ModuleTarget = { kind: 'files'; paths: string[] } | { kind: 'external'; module: string }

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const COMPILED_TO_SOURCE: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

export function resolveModule(
  importer: string,
  specifier: string,
  language: Language,
  paths: ReadonlySet<string>,
  config: ProjectConfig,
): ModuleTarget {
  const found =
    language === 'python'
      ? resolvePython(importer, specifier, paths, config)
      : language === 'go'
        ? resolveGo(specifier, paths, config)
        : resolveScript(importer, specifier, paths, config)
  return found === undefined || found.length === 0
    ? { kind: 'external', module: specifier }
    : { kind: 'files', paths: found }
}

function resolveScript(
  importer: string,
  specifier: string,
  paths: ReadonlySet<string>,
  config: ProjectConfig,
): string[] | undefined {
  if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    const base = inside(posix.join(dirOf(importer), specifier))
    return base === undefined ? undefined : scriptFile(base, paths)
  }
  const tsconfig = nearest(config.tsconfigs, dirOf(importer))
  if (tsconfig === undefined) return undefined
  for (const { pattern, targets } of tsconfig.paths) {
    const star = matchPattern(pattern, specifier)
    if (star === undefined) continue
    for (const target of targets) {
      const base = inside(target.replace('*', star))
      const file = base === undefined ? undefined : scriptFile(base, paths)
      if (file !== undefined) return file
    }
  }
  if (tsconfig.baseUrl !== undefined) {
    const base = inside(posix.join(tsconfig.baseUrl, specifier))
    return base === undefined ? undefined : scriptFile(base, paths)
  }
  return undefined
}

function scriptFile(base: string, paths: ReadonlySet<string>): string[] | undefined {
  const extension = posix.extname(base)
  const stem = base.slice(0, base.length - extension.length)
  const candidates = [
    ...(COMPILED_TO_SOURCE[extension] ?? []).map((source) => `${stem}${source}`),
    base,
    ...SCRIPT_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SCRIPT_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ]
  const hit = candidates.find((candidate) => paths.has(candidate))
  return hit === undefined ? undefined : [hit]
}

function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === specifier ? '' : undefined
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined
  if (specifier.length < prefix.length + suffix.length) return undefined
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function nearest<T>(byDir: ReadonlyMap<string, T>, dir: string): T | undefined {
  let current = dir
  for (;;) {
    const found = byDir.get(current)
    if (found !== undefined) return found
    if (current === '') return undefined
    current = dirOf(current)
  }
}

function resolvePython(
  importer: string,
  specifier: string,
  paths: ReadonlySet<string>,
  config: ProjectConfig,
): string[] | undefined {
  const dots = /^\.*/.exec(specifier)?.[0].length ?? 0
  const rest = specifier.slice(dots).replaceAll('.', '/')
  if (dots > 0) {
    let dir = dirOf(importer)
    for (let level = 1; level < dots; level += 1) {
      if (dir === '') return undefined
      dir = dirOf(dir)
    }
    return pythonFile(rest === '' ? dir : posix.join(dir, rest), paths, rest === '')
  }
  for (const root of config.pythonRoots) {
    const found = pythonFile(root === '' ? rest : posix.join(root, rest), paths, false)
    if (found !== undefined) return found
  }
  return undefined
}

export function pythonFile(
  base: string,
  paths: ReadonlySet<string>,
  packageOnly: boolean,
): string[] | undefined {
  const init = base === '' ? '__init__.py' : `${base}/__init__.py`
  const candidates = packageOnly ? [init] : [`${base}.py`, `${base}.pyi`, init]
  const hit = candidates.find((candidate) => paths.has(candidate))
  return hit === undefined ? undefined : [hit]
}

function resolveGo(
  specifier: string,
  paths: ReadonlySet<string>,
  config: ProjectConfig,
): string[] | undefined {
  const modules = [...config.goModules].sort((a, b) => b.module.length - a.module.length)
  for (const { dir, module } of modules) {
    if (specifier !== module && !specifier.startsWith(`${module}/`)) continue
    const sub = specifier.slice(module.length + 1)
    const folder = [dir, sub].filter((part) => part !== '').join('/')
    return goPackageFiles(folder, paths)
  }
  return undefined
}

export function goPackageFiles(folder: string, paths: ReadonlySet<string>): string[] {
  return [...paths]
    .filter((path) => dirOf(path) === folder && path.endsWith('.go') && !path.endsWith('_test.go'))
    .sort()
}

function inside(path: string): string | undefined {
  const normal = posix.normalize(path)
  if (normal === '..' || normal.startsWith('../') || posix.isAbsolute(normal)) return undefined
  return normal === '.' ? '' : normal
}
