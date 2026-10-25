import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { mergeConfig } from '../config/merge-config.js'
import { parseConfigText } from '../config/parse-config.js'
import { UsageError } from './errors.js'
import { runInit } from './init.js'
import { REPOSITORY_CONFIG_TEMPLATE, USER_CONFIG_TEMPLATE } from './init-templates.js'

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
    expect(files.files.get('/w/proj/.phada/config.yml')).toContain('#   repos:')
    expect(files.files.get('/w/proj/.phada/config.yml')).not.toContain('privateOnPublic')
    expect(files.files.get('/cfg/config.yml')).toContain('#   privateOnPublic: true')
    const rules = files.files.get('/w/proj/.phada/rules.md') ?? 'missing'
    const layer = { kind: 'repo-root', dir: '', configLabel: 'c', config: {} } as const
    expect(mergeConfig([{ ...layer, rulesMarkdown: { label: 'r', text: rules } }]).rules).toEqual(
      [],
    )
  })
})

describe('config templates with review focus and skills', () => {
  it.each([
    ['the repository', REPOSITORY_CONFIG_TEMPLATE],
    ['the user', USER_CONFIG_TEMPLATE],
  ])('comment the review block in %s config', (_case, template) => {
    expect(template).toContain('# review:')
    expect(template).toContain('#   prompt:')
    expect(template).toContain('#   skills: [phada, security-review]')
  })
})

describe('config templates with native skills', () => {
  it('comments the command policy, folders and timeout only in your own config', () => {
    expect(USER_CONFIG_TEMPLATE).toContain('#   commands: read-only')
    expect(USER_CONFIG_TEMPLATE).toContain('#   readDirs: ["~/review-rules"]')
    expect(USER_CONFIG_TEMPLATE).toContain('#   timeout: 30m')
    expect(REPOSITORY_CONFIG_TEMPLATE).not.toContain('commands:')
  })

  it('parses once the review block is uncommented', () => {
    const lines = USER_CONFIG_TEMPLATE.split('\n')
    const block = lines
      .slice(
        lines.findIndex((line) => line.startsWith('# review:')),
        lines.findIndex((line) => line.startsWith('#   timeout:')) + 1,
      )
      .filter((line) => line.startsWith('# review:') || line.startsWith('#   '))
      .map((line) => line.replace(/^# ?/, '').replace(/\s+#.*$/, ''))
      .join('\n')
    expect(parseConfigText(block)).toMatchObject({ ok: true })
  })
})

describe('config templates with the conversation and CI', () => {
  it.each([
    ['the repository', REPOSITORY_CONFIG_TEMPLATE],
    ['the user', USER_CONFIG_TEMPLATE],
  ])(
    'comment the conversation and ci options in %s config, parsing once uncommented',
    (_case, template) => {
      const lines = template.split('\n')
      const start = lines.findIndex((line) => line.startsWith('# conversation:'))
      const block = lines
        .slice(start, start + 6)
        .map((line) => line.replace(/^# ?/, '').replace(/\s+#.*$/, ''))
        .join('\n')
      expect(block).toBe(
        'conversation: true\nci:\n  read: true\n  wait: 15m\n  onFailure: review\n  checks: [test, "lint/*"]',
      )
      expect(parseConfigText(block)).toMatchObject({ ok: true })
    },
  )
})
