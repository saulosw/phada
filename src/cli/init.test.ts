import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { mergeConfig } from '../config/merge-config.js'
import { parseConfigText } from '../config/parse-config.js'
import { UsageError } from './errors.js'
import { runInit } from './init.js'

const ENV = { PHADA_CONFIG_HOME: '/cfg' }

describe('runInit', () => {
  it('creates the repository config at the root of the git repository', async () => {
    const files = memoryFiles({}, ['/w/proj/.git', '/w/proj/src'])

    const lines = await runInit(
      { global: false },
      { cwd: '/w/proj/src', env: ENV, home: '/home/u', files },
    )

    expect(lines).toEqual(['Created .phada/config.yml', 'Created .phada/rules.md'])
    expect([...files.files.keys()]).toEqual([
      '/w/proj/.phada/config.yml',
      '/w/proj/.phada/rules.md',
    ])
  })

  it('leaves existing files unchanged', async () => {
    const files = memoryFiles({ '/w/proj/.phada/config.yml': 'verify: true' }, ['/w/proj/.git'])

    const lines = await runInit(
      { global: false },
      { cwd: '/w/proj', env: ENV, home: '/home/u', files },
    )

    expect(lines).toEqual(['.phada/config.yml exists, left unchanged', 'Created .phada/rules.md'])
    expect(files.files.get('/w/proj/.phada/config.yml')).toBe('verify: true')
  })

  it('refuses to run outside a git repository', async () => {
    const files = memoryFiles({}, ['/tmp/x'])

    await expect(
      runInit({ global: false }, { cwd: '/tmp/x', env: ENV, home: '/home/u', files }),
    ).rejects.toThrow(
      new UsageError(
        'Not inside a git repository. Run it in your repository, or use phada init --global.',
      ),
    )
  })

  it('creates your own config for every repository', async () => {
    const files = memoryFiles()

    const lines = await runInit({ global: true }, { cwd: '/tmp', env: ENV, home: '/home/u', files })

    expect(lines).toEqual(['Created /cfg/config.yml', 'Created /cfg/rules.md'])
  })

  it('creates your own config for one repository in lowercase', async () => {
    const files = memoryFiles()

    const lines = await runInit(
      { global: true, repo: { owner: 'Acme', repo: 'Shop' } },
      { cwd: '/tmp', env: ENV, home: '/home/u', files },
    )

    expect(lines).toEqual([
      'Created /cfg/repos/acme/shop/config.yml',
      'Created /cfg/repos/acme/shop/rules.md',
    ])
  })

  it('writes templates that load as an empty config', async () => {
    const files = memoryFiles({}, ['/w/proj/.git'])
    await runInit({ global: false }, { cwd: '/w/proj', env: ENV, home: '/home/u', files })
    await runInit({ global: true }, { cwd: '/w/proj', env: ENV, home: '/home/u', files })

    for (const path of ['/w/proj/.phada/config.yml', '/cfg/config.yml']) {
      expect(parseConfigText(files.files.get(path) ?? 'missing')).toEqual({ ok: true, config: {} })
    }
    expect(files.files.get('/w/proj/.phada/config.yml')).toContain('# rules:')
    expect(files.files.get('/cfg/config.yml')).toContain('# provider: claude')
    expect(files.files.get('/w/proj/.phada/config.yml')).not.toContain('provider')
    const rules = files.files.get('/w/proj/.phada/rules.md') ?? 'missing'
    const layer = { kind: 'repo-root', dir: '', configLabel: 'c', config: {} } as const
    expect(mergeConfig([{ ...layer, rulesMarkdown: { label: 'r', text: rules } }]).rules).toEqual(
      [],
    )
  })
})
