import { DEPENDENCY_FOLDER, MAX_CONFIG_FILES, parseJsonc } from './project-config.js'
import { parseTomlTables } from './toml.js'

export type Ecosystem = 'npm' | 'go' | 'python'

export interface PackageRef {
  ecosystem: Ecosystem
  name: string
}

export interface RepositoryPackages {
  published: PackageRef[]
  depends: PackageRef[]
}

const PACKAGE_JSON = /(^|\/)package\.json$/
const GO_MOD = /(^|\/)go\.mod$/
const PYPROJECT = /(^|\/)pyproject\.toml$/
const SETUP_PY = /(^|\/)setup\.py$/
const SETUP_CFG = /(^|\/)setup\.cfg$/
const REQUIREMENTS = /(^|\/)requirements[^/]*\.txt$/
const MANIFEST = [PACKAGE_JSON, GO_MOD, PYPROJECT, SETUP_PY, SETUP_CFG, REQUIREMENTS]
const NPM_DEPENDENCIES = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
const REQUIREMENT_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/

export async function readPackages(
  paths: ReadonlySet<string>,
  readText: (path: string) => Promise<string>,
): Promise<RepositoryPackages> {
  const manifests = [...paths]
    .filter((path) => !DEPENDENCY_FOLDER.test(path) && MANIFEST.some((rule) => rule.test(path)))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
    .slice(0, MAX_CONFIG_FILES)
  const published = new PackageSet()
  const depends = new PackageSet()
  for (const path of manifests) {
    const text = await readText(path).catch(() => undefined)
    if (text === undefined) continue
    if (PACKAGE_JSON.test(path)) readPackageJson(text, published, depends)
    else if (GO_MOD.test(path)) readGoMod(text, published, depends)
    else if (PYPROJECT.test(path)) readPyproject(text, published, depends)
    else if (SETUP_PY.test(path)) {
      const name = /\bname\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1]
      if (name !== undefined) published.add('python', name)
    } else if (SETUP_CFG.test(path)) {
      const metadata = /^\[metadata\]([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? ''
      const name = /^\s*name\s*=\s*(\S+)/m.exec(metadata)?.[1]
      if (name !== undefined) published.add('python', name)
    } else {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.startsWith('-') || trimmed.startsWith('#') || trimmed.includes('://')) continue
        const name = REQUIREMENT_NAME.exec(trimmed)?.[1]
        if (name !== undefined) depends.add('python', name)
      }
    }
  }
  return { published: published.list(), depends: depends.list() }
}

export function packageKey({ ecosystem, name }: PackageRef): string {
  return `${ecosystem}\0${name}`
}

export function normalizePythonName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase()
}

class PackageSet {
  readonly #items = new Map<string, PackageRef>()

  add(ecosystem: Ecosystem, raw: string): void {
    const name = ecosystem === 'python' ? normalizePythonName(raw) : raw
    if (name === '') return
    const key = packageKey({ ecosystem, name })
    if (!this.#items.has(key)) this.#items.set(key, { ecosystem, name })
  }

  list(): PackageRef[] {
    return [...this.#items.values()]
  }
}

function readPackageJson(text: string, published: PackageSet, depends: PackageSet): void {
  const manifest = parseJsonc(text)
  if (typeof manifest !== 'object' || manifest === null) return
  const fields = manifest as Record<string, unknown>
  if (typeof fields.name === 'string') published.add('npm', fields.name)
  for (const key of NPM_DEPENDENCIES) {
    const listed = fields[key]
    if (typeof listed !== 'object' || listed === null || Array.isArray(listed)) continue
    for (const name of Object.keys(listed)) depends.add('npm', name)
  }
}

function readGoMod(text: string, published: PackageSet, depends: PackageSet): void {
  let inRequire = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (inRequire) {
      if (line === ')') inRequire = false
      else if (line !== '') depends.add('go', line.split(/\s+/)[0] ?? '')
      continue
    }
    const module = /^module\s+"?([^\s"]+)"?/.exec(line)?.[1]
    if (module !== undefined) published.add('go', module)
    if (/^require\s*\($/.test(line)) inRequire = true
    const single = /^require\s+([^\s(]+)/.exec(line)?.[1]
    if (single !== undefined) depends.add('go', single)
  }
}

function readPyproject(text: string, published: PackageSet, depends: PackageSet): void {
  const tables = parseTomlTables(text)
  for (const table of ['project', 'tool.poetry']) {
    const name = tables.get(table)?.get('name')
    if (typeof name === 'string') published.add('python', name)
  }
  const listed = tables.get('project')?.get('dependencies')
  for (const requirement of Array.isArray(listed) ? listed : []) {
    const name = REQUIREMENT_NAME.exec(requirement)?.[1]
    if (name !== undefined) depends.add('python', name)
  }
  for (const name of tables.get('tool.poetry.dependencies')?.keys() ?? []) {
    if (name !== 'python') depends.add('python', name)
  }
}
