import { describe, expect, it } from 'vitest'
import { loadProjectConfig } from './project-config.js'

function reader(files: Record<string, string>) {
  return {
    paths: new Set(Object.keys(files)),
    readText: async (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error(`missing ${path}`)
      return text
    },
  }
}

describe('loadProjectConfig', () => {
  it('reads tsconfig paths and baseUrl relative to the repository root', async () => {
    const { paths, readText } = reader({
      'tsconfig.json': `{
        // aliases
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~lib": ["lib/index.ts"], }, },
      }`,
    })

    const config = await loadProjectConfig(paths, readText)

    expect(config.tsconfigs.get('')).toEqual({
      baseUrl: '',
      paths: [
        { pattern: '@/*', targets: ['src/*'] },
        { pattern: '~lib', targets: ['lib/index.ts'] },
      ],
    })
  })

  it('inherits paths through a relative extends and keeps targets relative to the file that declared them', async () => {
    const { paths, readText } = reader({
      'tsconfig.base.json':
        '{ "compilerOptions": { "paths": { "@shared/*": ["packages/shared/src/*"] } } }',
      'packages/web/tsconfig.json':
        '{ "extends": "../../tsconfig.base", "compilerOptions": { "baseUrl": "src" } }',
    })

    const config = await loadProjectConfig(paths, readText)

    expect(config.tsconfigs.get('packages/web')).toEqual({
      baseUrl: 'packages/web/src',
      paths: [{ pattern: '@shared/*', targets: ['packages/shared/src/*'] }],
    })
  })

  it('ignores an extends that points at a package and a config that is not JSON', async () => {
    const { paths, readText } = reader({
      'tsconfig.json':
        '{ "extends": "@tsconfig/node22/tsconfig.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      'jsconfig.json': 'not json',
      'web/jsconfig.json': '{ oops',
    })

    const config = await loadProjectConfig(paths, readText)

    expect(config.tsconfigs.get('')).toEqual({ paths: [{ pattern: '@/*', targets: ['src/*'] }] })
    expect(config.tsconfigs.has('web')).toBe(false)
  })

  it('reads the paths of tsconfig.app.json when tsconfig.json only references it', async () => {
    const { paths, readText } = reader({
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
      'tsconfig.app.json':
        '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
      'tsconfig.node.json': '{ "compilerOptions": { "types": ["node"] } }',
    })

    const config = await loadProjectConfig(paths, readText)

    expect(config.tsconfigs.get('')).toEqual({
      baseUrl: '',
      paths: [{ pattern: '@/*', targets: ['src/*'] }],
    })
  })

  it('reads the module of each go.mod', async () => {
    const { paths, readText } = reader({
      'go.mod': 'module github.com/spf13/cobra\n\ngo 1.21\n',
      'tools/go.mod': 'module "example.com/tools"\n',
    })

    const config = await loadProjectConfig(paths, readText)

    expect(config.goModules).toEqual([
      { dir: '', module: 'github.com/spf13/cobra' },
      { dir: 'tools', module: 'example.com/tools' },
    ])
  })

  it('looks for Python packages at the root, in src and next to each project file', async () => {
    const { paths, readText } = reader({
      'services/api/pyproject.toml': '[project]',
      'setup.py': '',
    })

    const config = await loadProjectConfig(paths, readText)

    expect(config.pythonRoots).toEqual(['', 'src', 'services/api', 'services/api/src'])
  })
})
