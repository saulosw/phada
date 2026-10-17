import { describe, expect, it } from 'vitest'
import { normalizePythonName, readPackages } from './packages.js'

async function packagesOf(files: Record<string, string>) {
  return readPackages(new Set(Object.keys(files)), async (path) => {
    const text = files[path]
    if (text === undefined) throw new Error(`no ${path}`)
    return text
  })
}

const npm = (name: string) => ({ ecosystem: 'npm', name })
const go = (name: string) => ({ ecosystem: 'go', name })
const python = (name: string) => ({ ecosystem: 'python', name })

describe('readPackages', () => {
  it('reads every package.json of a monorepo, skipping dependency folders', async () => {
    const found = await packagesOf({
      'package.json': JSON.stringify({ name: 'acme', workspaces: ['packages/*'] }),
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core',
        dependencies: { zod: '^4' },
        devDependencies: { vitest: '^3' },
        peerDependencies: { react: '*' },
        optionalDependencies: { '@acme/native': '1' },
      }),
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad' }),
    })

    expect(found.published).toEqual([npm('acme'), npm('@acme/core')])
    expect(found.depends).toEqual([npm('zod'), npm('vitest'), npm('react'), npm('@acme/native')])
  })

  it('reads the module and the requirements of go.mod, without replace', async () => {
    const found = await packagesOf({
      'go.mod': [
        'module github.com/acme/app',
        '',
        'require (',
        '\tgithub.com/acme/core v1.2.0 // indirect',
        '\tgolang.org/x/text v0.3.0',
        ')',
        'require github.com/acme/log v1.0.0',
        'replace github.com/acme/core => ../core',
      ].join('\n'),
    })

    expect(found.published).toEqual([go('github.com/acme/app')])
    expect(found.depends).toEqual([
      go('github.com/acme/core'),
      go('golang.org/x/text'),
      go('github.com/acme/log'),
    ])
  })

  it('reads Python names and requirements from every kind of manifest, normalized', async () => {
    const found = await packagesOf({
      'pyproject.toml': [
        '[project]',
        'name = "My_Lib"',
        'dependencies = ["requests>=2", "acme-core[extra]; python_version>\'3.8\'"]',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'Acme.Util = "^1"',
      ].join('\n'),
      'requirements-dev.txt':
        '-r requirements.txt\n# tools\nacme_core==1.0\n\npytest>=8 ; python_version > "3"\n',
      'tools/setup.py': 'setup(\n    name="acme-tools",\n)',
      'cli/setup.cfg': '[metadata]\nname = acme_cli\n',
    })

    expect(found.published).toEqual([python('my-lib'), python('acme-cli'), python('acme-tools')])
    expect(found.depends).toEqual([
      python('requests'),
      python('acme-core'),
      python('acme-util'),
      python('pytest'),
    ])
  })

  it('skips a manifest it cannot parse', async () => {
    const found = await packagesOf({
      'package.json': '{ "name": ',
      'web/package.json': JSON.stringify({ name: 'web' }),
    })

    expect(found.published).toEqual([npm('web')])
  })
})

describe('normalizePythonName', () => {
  it('follows PEP 503', () => {
    expect(normalizePythonName('Acme__Core.Utils')).toBe('acme-core-utils')
  })
})
