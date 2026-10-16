import { describe, expect, it } from 'vitest'
import { indexFixture, openFixtureStore } from '../../test/support/index-fixture.js'
import { openRepositoryGraph } from './repository-graph.js'
import type { CallersResult, DependenciesResult, RepositoryGraph } from './types.js'

async function graphOf(files: Record<string, string>): Promise<RepositoryGraph> {
  const { reader, readText } = await indexFixture(files)
  return openRepositoryGraph({ reader, readText })
}

function sites(result: CallersResult): string[] {
  return result.sites.map(
    (site) =>
      `${site.path}:${site.line} in ${site.in?.name ?? '(module)'} ${site.kind}${site.how === 'resolved' ? '' : ` ${site.how}`}`,
  )
}

function dependencies(result: DependenciesResult): string[] {
  return result.dependencies.map((dependency) => {
    const where =
      dependency.target === undefined
        ? `external${dependency.module === undefined ? '' : ` (${dependency.module})`}`
        : `${dependency.target.path}:${dependency.target.startLine}`
    return `${dependency.name} ${dependency.kind} → ${where}${dependency.how === 'resolved' ? '' : ` ${dependency.how}`}`
  })
}

const TYPESCRIPT = {
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
  'src/users.ts': `import { BaseService } from './base.js'
import express from 'express'
export interface User { id: string }
export function getUser(id: string): User {
  return db.find(id)
}
export default class UserService extends BaseService {
  load(id: string) {
    return this.fetchOne(id)
  }
}
export const app = express()
`,
  'src/base.ts': `export class BaseService {
  fetchOne(id: string) {
    return id
  }
}
`,
  'src/index.ts': `export { getUser as findUser } from './users.js'
export * from './base.js'
`,
  'src/api/routes.ts': `import { getUser } from '../users.js'
import { getUser as fetchUser } from '@/users'
export function handleGet(id: string) {
  return getUser(id)
}
export function handlePut(id: string) {
  return fetchUser(id)
}
export const handlers = [getUser]
`,
  'src/jobs/sync.ts': `import { findUser } from '../index.js'
import * as users from '../users.js'
export function run(id: string) {
  findUser(id)
  users.getUser(id)
}
`,
  'src/other.ts': `function getUser() {
  return 1
}
export function x() {
  return getUser()
}
`,
}

describe('repository graph for TypeScript', () => {
  it('finds every caller and use of a function through imports, aliases, re-exports and namespaces', async () => {
    const graph = await graphOf(TYPESCRIPT)

    const result = graph.callers({ name: 'getUser', path: 'src/users.ts' })

    expect(result.symbols.map((symbol) => `${symbol.path}:${symbol.startLine}`)).toEqual([
      'src/users.ts:4',
    ])
    expect(sites(result)).toEqual([
      'src/api/routes.ts:4 in handleGet calls',
      'src/api/routes.ts:7 in handlePut calls',
      'src/api/routes.ts:9 in (module) uses',
      'src/jobs/sync.ts:4 in run calls',
      'src/jobs/sync.ts:5 in run calls',
    ])
  })

  it('lists the classes that inherit from a class', async () => {
    const graph = await graphOf(TYPESCRIPT)

    expect(sites(graph.callers({ name: 'BaseService' }))).toEqual([
      'src/users.ts:7 in UserService inherits',
    ])
  })

  it('resolves this through the parent class and leaves packages external', async () => {
    const graph = await graphOf(TYPESCRIPT)

    expect(dependencies(graph.dependencies({ name: 'load', path: 'src/users.ts' }))).toEqual([
      'fetchOne calls → src/base.ts:2',
    ])
    expect(dependencies(graph.dependencies({ name: 'getUser', path: 'src/users.ts' }))).toEqual([
      'find calls → external',
    ])
    expect(dependencies(graph.dependencies({ name: 'UserService' }))).toEqual([
      'BaseService inherits → src/base.ts:1',
    ])
  })

  it('names the package of an external call made at the module level', async () => {
    const graph = await graphOf(TYPESCRIPT)

    expect(dependencies(graph.dependencies({ name: 'app' }))).toEqual([
      'express calls → external (express)',
    ])
  })

  it('guesses a method by name when one to three definitions have it, and gives up beyond that', async () => {
    const base = {
      'src/a.ts': 'export function caller(repo: any) {\n  return repo.save(1)\n}\n',
      'src/m1.ts': 'export class A {\n  save(x: number) {}\n}\n',
    }
    const one = await graphOf(base)
    expect(dependencies(one.dependencies({ name: 'caller' }))).toEqual([
      'save calls → src/m1.ts:2 inferred',
    ])
    expect(sites(one.callers({ name: 'save' }))).toEqual(['src/a.ts:2 in caller calls inferred'])

    const four = await graphOf({
      ...base,
      'src/m2.ts': 'export class B {\n  save() {}\n}\n',
      'src/m3.ts': 'export class C {\n  save() {}\n}\n',
      'src/m4.ts': 'export function save() {}\n',
    })
    expect(dependencies(four.dependencies({ name: 'caller' }))).toEqual(['save calls → external'])
  })

  it('stops following re-exports that loop', async () => {
    const graph = await graphOf({
      'a.ts': "export * from './b'\n",
      'b.ts': "export * from './a'\n",
      'c.ts': "import { nothing } from './a'\nexport function f() {\n  return nothing()\n}\n",
    })

    expect(dependencies(graph.dependencies({ name: 'f' }))).toEqual([
      'nothing calls → external (./a)',
    ])
  })

  it('finds definitions by name, then without case, and picks the innermost symbol at a line', async () => {
    const graph = await graphOf(TYPESCRIPT)

    expect(graph.findSymbol('getUser').map((symbol) => symbol.path)).toEqual([
      'src/users.ts',
      'src/other.ts',
    ])
    expect(graph.findSymbol('GETUSER').map((symbol) => symbol.path)).toEqual([
      'src/users.ts',
      'src/other.ts',
    ])
    expect(graph.findSymbol('getUser', 'class')).toEqual([])
    expect(graph.symbolAt('src/users.ts', 9)).toMatchObject({
      kind: 'method',
      name: 'load',
      owner: 'UserService',
    })
    expect(graph.symbolAt('src/users.ts', 1)).toBeUndefined()
  })

  it('uses the first definitions when no path is given and says how many others there are', async () => {
    const graph = await graphOf(TYPESCRIPT)

    const result = graph.targets({ name: 'getUser' })

    expect(result.symbols.map((symbol) => symbol.path)).toEqual(['src/users.ts', 'src/other.ts'])
    expect(result.others).toBe(0)
  })

  it('reads each file once to show its lines', async () => {
    const { reader } = await indexFixture({ 'a.ts': 'export const a = 1\nexport const b = 2\n' })
    let reads = 0
    const graph = await openRepositoryGraph({
      reader,
      readText: async () => {
        reads += 1
        return 'export const a = 1\nexport const b = 2\n'
      },
    })

    expect(await graph.lineText('a.ts', 2)).toBe('export const b = 2')
    expect(await graph.lineText('a.ts', 1)).toBe('export const a = 1')
    expect(await graph.lineText('a.ts', 9)).toBeUndefined()
    expect(reads).toBe(1)
  })

  it('answers for the commit it was opened on', async () => {
    const store = await openFixtureStore()
    const first = await indexFixture(
      { 'a.ts': 'export function f() {}\n', 'b.ts': "import { f } from './a'\nf()\n" },
      { store, sha: '1'.repeat(40) },
    )
    const second = await indexFixture(
      { 'a.ts': 'export function f() {}\n', 'b.ts': "import { f } from './a'\nconst x = 1\n" },
      { store, sha: '2'.repeat(40) },
    )

    const before = await openRepositoryGraph({ reader: first.reader, readText: first.readText })
    const after = await openRepositoryGraph({ reader: second.reader, readText: second.readText })

    expect(sites(before.callers({ name: 'f' }))).toEqual(['b.ts:2 in (module) calls'])
    expect(sites(after.callers({ name: 'f' }))).toEqual([])
  })
})

describe('repository graph for Python', () => {
  const PYTHON = {
    'app/__init__.py': '',
    'app/models.py': `class Base:
    def touch(self):
        pass


class User(Base):
    def save(self):
        self.touch()
        return format_name(self)


def format_name(u):
    return u
`,
    'app/utils/__init__.py': '',
    'app/utils/text.py': 'def slugify(s):\n    return s\n',
    'app/views.py': `from .models import User as U
from app.utils import text
import app.utils.text as t


def show():
    u = U()
    text.slugify("x")
    t.slugify("y")
    return u
`,
  }

  it('resolves self through the parent class and local functions', async () => {
    const graph = await graphOf(PYTHON)

    expect(dependencies(graph.dependencies({ name: 'save' }))).toEqual([
      'touch calls → app/models.py:2',
      'format_name calls → app/models.py:12',
    ])
  })

  it('finds callers through an aliased import, a submodule import and a dotted import', async () => {
    const graph = await graphOf(PYTHON)

    expect(sites(graph.callers({ name: 'slugify' }))).toEqual([
      'app/views.py:8 in show calls',
      'app/views.py:9 in show calls',
    ])
    expect(sites(graph.callers({ name: 'User' }))).toEqual(['app/views.py:7 in show calls'])
  })
})

describe('repository graph for Go', () => {
  const GO = {
    'go.mod': 'module example.com/m\n',
    'store/store.go': `package store

type Store struct{}

func (s *Store) Load(id string) error { return s.check(id) }

func (s *Store) check(id string) error { return nil }

func Open() *Store { return helper() }
`,
    'store/helper.go': 'package store\n\nfunc helper() *Store { return &Store{} }\n',
    'cmd/main.go': `package main

import "example.com/m/store"

func main() {
	s := store.Open()
	var x store.Store
	_, _ = s, x
}
`,
  }

  it('resolves calls in the same package, through the receiver and from another package', async () => {
    const graph = await graphOf(GO)

    expect(dependencies(graph.dependencies({ name: 'Open' }))).toEqual([
      'helper calls → store/helper.go:3',
    ])
    expect(dependencies(graph.dependencies({ name: 'Load' }))).toEqual([
      'check calls → store/store.go:7',
    ])
    expect(sites(graph.callers({ name: 'Open' }))).toEqual(['cmd/main.go:6 in main calls'])
    expect(sites(graph.callers({ name: 'Store' }))).toEqual(['cmd/main.go:7 in main uses'])
  })
})

describe('repository graph time limits', () => {
  it('stops checking call sites when a query runs out of time and says it was capped', async () => {
    const calls = Array.from({ length: 30 }, () => '  f()').join('\n')
    const { reader, readText } = await indexFixture({
      'a.ts': 'export function f() {}\n',
      'b.ts': `import { f } from './a'\nexport function g() {\n${calls}\n}\n`,
    })
    let clock = 0
    const graph = await openRepositoryGraph({
      reader,
      readText,
      now: () => {
        clock += 500
        return clock
      },
    })

    const result = graph.callers({ name: 'f' })

    expect(result.capped).toBe(true)
    expect(result.sites.length).toBeLessThan(30)
  })
})

describe('repository graph lookups', () => {
  it('looks up the definitions of a name it guesses only once per graph', async () => {
    const { reader, readText } = await indexFixture({
      'src/a.ts': 'export function a(repo: any) {\n  return repo.save(1)\n}\n',
      'src/b.ts': 'export function b(repo: any) {\n  return repo.save(2)\n}\n',
      'src/store.ts': 'export class Store {\n  save(x: number) {}\n}\n',
    })
    const looked: string[] = []
    const counting = new Proxy(reader, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        if (property !== 'symbolsNamed') return value.bind(target)
        return (name: string, options?: { ignoreCase?: boolean }) => {
          looked.push(name)
          return value.call(target, name, options)
        }
      },
    })
    const graph = await openRepositoryGraph({ reader: counting, readText })

    graph.dependencies({ name: 'a' })
    graph.dependencies({ name: 'b' })

    expect(looked.filter((name) => name === 'save')).toHaveLength(1)
  })
})
