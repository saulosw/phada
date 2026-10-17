import { describe, expect, it } from 'vitest'
import { indexFixture } from '../../test/support/index-fixture.js'
import { openRepositoryGraph } from './repository-graph.js'
import type { ExternalSite, RepositoryGraph } from './types.js'

async function graphOf(files: Record<string, string>): Promise<RepositoryGraph> {
  const { reader, readText } = await indexFixture(files)
  return openRepositoryGraph({ reader, readText })
}

const brief = (site: ExternalSite) =>
  `${site.path}:${site.line} ${site.module ?? '-'} ${site.imported ?? '-'}${site.member === undefined ? '' : `.${site.member}`}`

describe('exported', () => {
  it('finds what a package exports, through re-exports and default', async () => {
    const graph = await graphOf({
      'package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
      'src/index.ts': "export * from './users.js'\nexport { default } from './client.js'\n",
      'src/users.ts': 'export function getUser(id: string) {\n  return id\n}\n',
      'src/client.ts': 'export default class Client {\n  fetch() {\n    return 1\n  }\n}\n',
    })

    expect(graph.exported('@acme/core', 'getUser', 'typescript').map((s) => s.path)).toEqual([
      'src/users.ts',
    ])
    expect(graph.exported('@acme/core', 'default', 'typescript').map((s) => s.name)).toEqual([
      'Client',
    ])
    expect(graph.exported('@acme/other', 'getUser', 'typescript')).toEqual([])
  })

  it('lists the methods of exported classes by name', async () => {
    const graph = await graphOf({
      'src/a.ts':
        'export class Client {\n  fetch() {\n    return 1\n  }\n}\nclass Hidden {\n  fetch() {\n    return 2\n  }\n}\n',
    })

    expect(graph.exportedMethods('fetch').map((s) => `${s.owner}.${s.name}`)).toEqual([
      'Client.fetch',
    ])
  })
})

describe('externalSites', () => {
  it('lists the calls that leave the repository, with the module and the name they ask for', async () => {
    const graph = await graphOf({
      'src/page.ts': [
        "import { getUser } from '@acme/core'",
        "import { getUser as gu } from '@acme/core/users'",
        "import * as core from '@acme/core'",
        "import { Client } from '@acme/core'",
        'export function load(id: string) {',
        '  getUser(id)',
        '  gu(id)',
        '  core.getUser(id)',
        '  Client.create()',
        '}',
      ].join('\n'),
      'src/local.ts': 'function getUser() {\n  return 1\n}\ngetUser()\n',
    })

    expect(graph.externalSites('getUser').map(brief)).toEqual([
      'src/page.ts:6 @acme/core getUser',
      'src/page.ts:7 @acme/core/users getUser',
      'src/page.ts:8 @acme/core getUser',
    ])
    expect(graph.externalSites('create').map(brief)).toEqual([
      'src/page.ts:9 @acme/core Client.create',
    ])
    expect(graph.importsModule('src/page.ts', (module) => module.startsWith('@acme/'))).toBe(true)
    expect(graph.importsModule('src/local.ts', () => true)).toBe(false)
  })

  it('reads Go package calls with the package path', async () => {
    const graph = await graphOf({
      'go.mod': 'module github.com/acme/app\n',
      'main.go':
        'package main\n\nimport "github.com/acme/lib/pkg/users"\n\nfunc main() {\n\tusers.Get(1)\n}\n',
    })

    expect(graph.externalSites('Get').map(brief)).toEqual([
      'main.go:6 github.com/acme/lib/pkg/users Get',
    ])
  })
})
