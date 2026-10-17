import { describe, expect, it } from 'vitest'
import type { ProjectConfig } from './project-config.js'
import { resolveModule, resolvePackage } from './resolve-module.js'

const NONE: ProjectConfig = {
  tsconfigs: new Map(),
  goModules: [],
  pythonRoots: ['', 'src'],
  workspacePackages: [],
}

function files(...paths: string[]): ReadonlySet<string> {
  return new Set(paths)
}

describe('resolveModule for TypeScript and JavaScript', () => {
  it('resolves a relative import written with the .js extension to the TypeScript file', () => {
    expect(
      resolveModule('src/a.ts', './user.js', 'typescript', files('src/user.ts'), NONE),
    ).toEqual({
      kind: 'files',
      paths: ['src/user.ts'],
    })
  })

  it('resolves a folder to its index file and tries tsx', () => {
    const paths = files('lib/index.ts', 'src/view/x.tsx')
    expect(resolveModule('src/a.ts', '../lib', 'typescript', paths, NONE)).toEqual({
      kind: 'files',
      paths: ['lib/index.ts'],
    })
    expect(resolveModule('src/view/a.tsx', './x', 'tsx', paths, NONE)).toEqual({
      kind: 'files',
      paths: ['src/view/x.tsx'],
    })
  })

  it('treats a relative import that leaves the repository or finds nothing as external', () => {
    expect(resolveModule('a.ts', '../outside', 'typescript', files('outside.ts'), NONE)).toEqual({
      kind: 'external',
      module: '../outside',
    })
    expect(resolveModule('src/a.ts', './gone', 'typescript', files(), NONE)).toEqual({
      kind: 'external',
      module: './gone',
    })
  })

  it('resolves tsconfig paths and baseUrl from the nearest config above the importer', () => {
    const config: ProjectConfig = {
      ...NONE,
      tsconfigs: new Map([
        ['', { baseUrl: 'src', paths: [{ pattern: '@/*', targets: ['src/*'] }] }],
        ['packages/web', { paths: [{ pattern: '@/*', targets: ['packages/web/app/*'] }] }],
      ]),
    }
    const paths = files('src/lib/user.ts', 'src/util/date.ts', 'packages/web/app/lib/user.ts')

    expect(resolveModule('src/api/a.ts', '@/lib/user', 'typescript', paths, config)).toEqual({
      kind: 'files',
      paths: ['src/lib/user.ts'],
    })
    expect(resolveModule('src/api/a.ts', 'util/date', 'typescript', paths, config)).toEqual({
      kind: 'files',
      paths: ['src/util/date.ts'],
    })
    expect(resolveModule('packages/web/app/page.tsx', '@/lib/user', 'tsx', paths, config)).toEqual({
      kind: 'files',
      paths: ['packages/web/app/lib/user.ts'],
    })
  })

  it('treats a package as external', () => {
    expect(resolveModule('src/a.ts', 'react', 'typescript', files('react.ts'), NONE)).toEqual({
      kind: 'external',
      module: 'react',
    })
  })
})

describe('resolveModule for packages of the same repository', () => {
  const config: ProjectConfig = {
    ...NONE,
    workspacePackages: [
      {
        name: '@nestjs/common',
        dir: 'packages/common',
        exports: [
          { pattern: '.', target: './index.js' },
          { pattern: './internal', target: './internal.js' },
          { pattern: './*', target: './*.js' },
        ],
      },
      {
        name: '@navi/contracts',
        dir: 'packages/contracts',
        exports: [
          { pattern: '.', target: './src/index.ts' },
          { pattern: './validation', target: './src/validation.ts' },
        ],
      },
      { name: 'legacy-lib', dir: 'libs/legacy', exports: [], main: 'lib/main.js' },
    ],
  }
  const paths = files(
    'packages/common/index.ts',
    'packages/common/internal.ts',
    'packages/common/utils/shared.utils.ts',
    'packages/contracts/src/index.ts',
    'packages/contracts/src/validation.ts',
    'libs/legacy/lib/main.ts',
  )

  it('follows the exports of a package to its TypeScript sources', () => {
    expect(
      resolveModule('packages/core/a.ts', '@nestjs/common', 'typescript', paths, config),
    ).toEqual({
      kind: 'files',
      paths: ['packages/common/index.ts'],
    })
    expect(
      resolveModule('packages/core/a.ts', '@nestjs/common/internal', 'typescript', paths, config),
    ).toEqual({ kind: 'files', paths: ['packages/common/internal.ts'] })
    expect(
      resolveModule(
        'packages/core/a.ts',
        '@nestjs/common/utils/shared.utils',
        'typescript',
        paths,
        config,
      ),
    ).toEqual({ kind: 'files', paths: ['packages/common/utils/shared.utils.ts'] })
    expect(
      resolveModule('apps/desktop/x.ts', '@navi/contracts/validation', 'typescript', paths, config),
    ).toEqual({ kind: 'files', paths: ['packages/contracts/src/validation.ts'] })
  })

  it('uses main when a package has no exports, and leaves other packages external', () => {
    expect(resolveModule('a.ts', 'legacy-lib', 'typescript', paths, config)).toEqual({
      kind: 'files',
      paths: ['libs/legacy/lib/main.ts'],
    })
    expect(resolveModule('a.ts', '@nestjs/commonx', 'typescript', paths, config)).toEqual({
      kind: 'external',
      module: '@nestjs/commonx',
    })
  })
})

describe('resolveModule for Python', () => {
  it('resolves relative imports one level per dot', () => {
    const paths = files('app/models.py', 'app/core/__init__.py', 'app/sub/__init__.py')
    expect(resolveModule('app/views.py', '.models', 'python', paths, NONE)).toEqual({
      kind: 'files',
      paths: ['app/models.py'],
    })
    expect(resolveModule('app/sub/v.py', '..core', 'python', paths, NONE)).toEqual({
      kind: 'files',
      paths: ['app/core/__init__.py'],
    })
    expect(resolveModule('app/sub/v.py', '.', 'python', paths, NONE)).toEqual({
      kind: 'files',
      paths: ['app/sub/__init__.py'],
    })
  })

  it('resolves absolute modules from each root and leaves libraries external', () => {
    const config: ProjectConfig = { ...NONE, pythonRoots: ['', 'src', 'services/api'] }
    const paths = files('src/app/utils.py', 'services/api/billing/__init__.py')
    expect(resolveModule('src/app/x.py', 'app.utils', 'python', paths, config)).toEqual({
      kind: 'files',
      paths: ['src/app/utils.py'],
    })
    expect(resolveModule('services/api/main.py', 'billing', 'python', paths, config)).toEqual({
      kind: 'files',
      paths: ['services/api/billing/__init__.py'],
    })
    expect(resolveModule('src/app/x.py', 'django.db', 'python', paths, config)).toEqual({
      kind: 'external',
      module: 'django.db',
    })
  })
})

describe('resolveModule for Go', () => {
  const config: ProjectConfig = {
    ...NONE,
    goModules: [
      { dir: '', module: 'github.com/spf13/cobra' },
      { dir: 'tools', module: 'github.com/spf13/cobra/tools' },
    ],
  }
  const paths = files('doc/md.go', 'doc/man.go', 'doc/sub/x.go', 'doc/README.md', 'tools/gen/g.go')

  it('resolves an import of the module to every Go file of the package folder', () => {
    expect(resolveModule('cmd.go', 'github.com/spf13/cobra/doc', 'go', paths, config)).toEqual({
      kind: 'files',
      paths: ['doc/man.go', 'doc/md.go'],
    })
  })

  it('prefers the longest module and leaves the standard library external', () => {
    expect(resolveModule('x.go', 'github.com/spf13/cobra/tools/gen', 'go', paths, config)).toEqual({
      kind: 'files',
      paths: ['tools/gen/g.go'],
    })
    expect(resolveModule('x.go', 'fmt', 'go', paths, config)).toEqual({
      kind: 'external',
      module: 'fmt',
    })
  })
})

describe('resolvePackage', () => {
  it('resolves a package of the repository from outside, through main, exports and dist', () => {
    const config: ProjectConfig = {
      ...NONE,
      tsconfigs: new Map([['', { paths: [{ pattern: '@/*', targets: ['src/*'] }] }]]),
      workspacePackages: [
        {
          name: '@acme/core',
          dir: 'packages/core',
          exports: [{ pattern: './utils', target: './dist/utils.js' }],
          main: 'dist/index.js',
        },
      ],
    }
    const paths = files('packages/core/src/index.ts', 'packages/core/dist/utils.ts', 'src/a.ts')

    expect(resolvePackage('@acme/core', 'typescript', paths, config)).toEqual([
      'packages/core/src/index.ts',
    ])
    expect(resolvePackage('@acme/core/utils', 'typescript', paths, config)).toEqual([
      'packages/core/dist/utils.ts',
    ])
    expect(resolvePackage('@/a', 'typescript', paths, config)).toBeUndefined()
    expect(resolvePackage('./src/a', 'typescript', paths, config)).toBeUndefined()
  })

  it('resolves a Go package by its module path and a Python module from its roots', () => {
    const config: ProjectConfig = {
      ...NONE,
      goModules: [{ dir: '', module: 'github.com/acme/lib' }],
    }
    const paths = files('pkg/users/users.go', 'pkg/users/users_test.go', 'src/acme_lib/users.py')

    expect(resolvePackage('github.com/acme/lib/pkg/users', 'go', paths, config)).toEqual([
      'pkg/users/users.go',
    ])
    expect(resolvePackage('acme_lib.users', 'python', paths, config)).toEqual([
      'src/acme_lib/users.py',
    ])
    expect(resolvePackage('.users', 'python', paths, config)).toBeUndefined()
  })
})
