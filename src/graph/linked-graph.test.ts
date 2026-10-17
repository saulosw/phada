import { describe, expect, it } from 'vitest'
import { indexFixture } from '../../test/support/index-fixture.js'
import { linkGraphs } from './linked-graph.js'
import type { PackageRef } from './packages.js'
import { openRepositoryGraph } from './repository-graph.js'
import type { RepositoryLink } from './repository-links.js'
import type { RepositoryGraph, Site } from './types.js'

async function graphOf(files: Record<string, string>): Promise<RepositoryGraph> {
  const { reader, readText } = await indexFixture(files)
  return openRepositoryGraph({ reader, readText })
}

const npm = (name: string): PackageRef => ({ ecosystem: 'npm', name })
const consumes = (...refs: PackageRef[]): RepositoryLink => ({
  consumedByRelated: refs,
  consumedByReviewed: [],
})
const publishes = (...refs: PackageRef[]): RepositoryLink => ({
  consumedByRelated: [],
  consumedByReviewed: refs,
})
const brief = (site: Site) =>
  `${site.repo ?? '.'}:${site.path}:${site.line}${site.how === 'resolved' ? '' : ` ${site.how}`}`

const CORE = {
  'package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
  'src/index.ts': "export * from './users.js'\nexport { Client } from './client.js'\n",
  'src/users.ts': 'export function getUser(id: string) {\n  return id\n}\n',
  'src/client.ts': 'export class Client {\n  fetch(id: string) {\n    return id\n  }\n}\n',
  'src/admin.ts': "import { getUser } from './users.js'\nexport const admin = getUser('root')\n",
}

const WEB = {
  'package.json': JSON.stringify({ name: 'web', dependencies: { '@acme/core': '^1' } }),
  'src/page.ts': [
    "import { getUser, Client } from '@acme/core'",
    'export function load(id: string) {',
    '  const client = new Client()',
    '  client.fetch(id)',
    '  return getUser(id)',
    '}',
  ].join('\n'),
  'src/local.ts': 'function getUser() {\n  return 1\n}\nexport const x = getUser()\n',
}

describe('linkGraphs callers', () => {
  it('adds the call sites of the consumers to the callers of an exported symbol', async () => {
    const graph = linkGraphs(await graphOf(CORE), [
      { repo: 'acme/web', graph: await graphOf(WEB), link: consumes(npm('@acme/core')) },
    ])

    expect(graph.callers({ name: 'getUser', path: 'src/users.ts' }).sites.map(brief)).toEqual([
      '.:src/admin.ts:2',
      'acme/web:src/page.ts:5',
    ])
  })

  it('never links a homonym of a consumer, nor a related repository without a link', async () => {
    const homonym = linkGraphs(await graphOf(CORE), [
      { repo: 'acme/web', graph: await graphOf(WEB), link: consumes(npm('@acme/core')) },
      { repo: 'acme/other', graph: await graphOf(WEB), link: consumes() },
    ])

    const sites = homonym.callers({ name: 'getUser', path: 'src/users.ts' }).sites
    expect(sites.filter((site) => site.path === 'src/local.ts')).toEqual([])
    expect(sites.filter((site) => site.repo === 'acme/other')).toEqual([])
  })

  it('never links a call to a package of the reviewed repository the consumer does not declare', async () => {
    const graph = linkGraphs(await graphOf(CORE), [
      { repo: 'acme/web', graph: await graphOf(WEB), link: consumes(npm('@acme/other')) },
    ])

    const sites = graph.callers({ name: 'getUser', path: 'src/users.ts' }).sites
    expect(sites.filter((site) => site.repo === 'acme/web')).toEqual([])
  })

  it('guesses a method call on an instance when the file imports the package', async () => {
    const graph = linkGraphs(await graphOf(CORE), [
      { repo: 'acme/web', graph: await graphOf(WEB), link: consumes(npm('@acme/core')) },
    ])

    expect(graph.callers({ name: 'fetch', path: 'src/client.ts' }).sites.map(brief)).toEqual([
      'acme/web:src/page.ts:4 inferred',
    ])
  })

  it('does not guess when the publisher has more than three methods with the name', async () => {
    const many = Object.fromEntries(
      [1, 2, 3, 4].map((n) => [
        `src/c${n}.ts`,
        `export class C${n} {\n  fetch() {\n    return ${n}\n  }\n}\n`,
      ]),
    )
    const graph = linkGraphs(await graphOf({ ...CORE, ...many }), [
      { repo: 'acme/web', graph: await graphOf(WEB), link: consumes(npm('@acme/core')) },
    ])

    expect(graph.callers({ name: 'fetch', path: 'src/client.ts' }).sites).toEqual([])
  })

  it('reaches a Go function through the module path', async () => {
    const lib = await graphOf({
      'go.mod': 'module github.com/acme/lib\n',
      'pkg/users/users.go': 'package users\n\nfunc Get(id int) int {\n\treturn id\n}\n',
    })
    const app = await graphOf({
      'go.mod': 'module github.com/acme/app\n\nrequire github.com/acme/lib v1.0.0\n',
      'main.go':
        'package main\n\nimport "github.com/acme/lib/pkg/users"\n\nfunc main() {\n\tusers.Get(1)\n}\n',
    })
    const graph = linkGraphs(lib, [
      {
        repo: 'acme/app',
        graph: app,
        link: consumes({ ecosystem: 'go', name: 'github.com/acme/lib' }),
      },
    ])

    expect(graph.callers({ name: 'Get' }).sites.map(brief)).toEqual(['acme/app:main.go:6'])
  })

  it('reaches a Python function through a submodule import', async () => {
    const lib = await graphOf({
      'pyproject.toml': '[project]\nname = "acme-lib"\n',
      'src/acme_lib/__init__.py': '',
      'src/acme_lib/users.py': 'def get(user_id):\n    return user_id\n',
    })
    const app = await graphOf({
      'app.py': 'from acme_lib import users\n\n\ndef run():\n    return users.get(1)\n',
    })
    const graph = linkGraphs(lib, [
      {
        repo: 'acme/app',
        graph: app,
        link: consumes({ ecosystem: 'python', name: 'acme-lib' }),
      },
    ])

    expect(graph.callers({ name: 'get' }).sites.map(brief)).toEqual(['acme/app:app.py:5'])
  })
})

describe('linkGraphs dependencies and lines', () => {
  it('points a dependency on a published package to the definition in the publisher', async () => {
    const graph = linkGraphs(await graphOf(WEB), [
      { repo: 'acme/core', graph: await graphOf(CORE), link: publishes(npm('@acme/core')) },
    ])

    const found = graph.dependencies({ name: 'load' }).dependencies
    const getUser = found.find((item) => item.name === 'getUser')
    expect(getUser?.repo).toBe('acme/core')
    expect(getUser?.target).toMatchObject({
      repo: 'acme/core',
      path: 'src/users.ts',
      name: 'getUser',
    })
  })

  it('reads a line of a related repository', async () => {
    const graph = linkGraphs(await graphOf(CORE), [
      { repo: 'acme/web', graph: await graphOf(WEB), link: consumes(npm('@acme/core')) },
    ])

    expect(await graph.lineText('src/page.ts', 5, 'acme/web')).toBe('  return getUser(id)')
    expect(await graph.lineText('src/users.ts', 2)).toBe('  return id')
  })
})
