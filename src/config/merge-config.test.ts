import { describe, expect, it } from 'vitest'
import { mergeConfig, resolveProvider } from './merge-config.js'
import type { ConfigLayer } from './types.js'

type Config = ConfigLayer['config']

function withRules(layer: ConfigLayer, label: string, rules?: string): ConfigLayer {
  return rules === undefined ? layer : { ...layer, rulesMarkdown: { label, text: rules } }
}

const user = (config: Config, rules?: string): ConfigLayer =>
  withRules(
    { kind: 'user', dir: '', configLabel: 'user:config.yml', config },
    'user:rules.md',
    rules,
  )

const userRepo = (config: Config): ConfigLayer => ({
  kind: 'user-repo',
  dir: '',
  configLabel: 'user:repos/acme/shop/config.yml',
  config,
})

const root = (config: Config, rules?: string): ConfigLayer =>
  withRules(
    { kind: 'repo-root', dir: '', configLabel: '.phada/config.yml', config },
    '.phada/rules.md',
    rules,
  )

const sub = (dir: string, config: Config, rules?: string): ConfigLayer =>
  withRules(
    { kind: 'repo-dir', dir, configLabel: `${dir}/.phada/config.yml`, config },
    `${dir}/.phada/rules.md`,
    rules,
  )

describe('mergeConfig options', () => {
  it('takes each option from the most specific layer that sets it', () => {
    const merged = mergeConfig([
      user({ language: 'en', minConfidence: 80, verify: false }),
      root({ language: 'pt-BR', verify: true }),
      userRepo({ minConfidence: 55 }),
    ])

    expect(merged).toMatchObject({
      language: 'pt-BR',
      minConfidence: 55,
      verify: true,
      contextDefaults: true,
    })
  })

  it('lets the user turn the default docs off for one repository', () => {
    const merged = mergeConfig([
      root({ context: { defaults: true } }),
      userRepo({ context: { defaults: false } }),
    ])

    expect(merged.contextDefaults).toBe(false)
  })

  it('ignores options and user-only keys in a subfolder with a warning', () => {
    const merged = mergeConfig([
      sub('src/api', { language: 'pt', provider: 'codex', context: { defaults: false } }),
    ])

    expect(merged.language).toBeUndefined()
    expect(merged.contextDefaults).toBe(true)
    expect(merged.warnings).toEqual([
      'src/api/.phada/config.yml: language is only read from the root .phada/config.yml or your own config; ignored.',
      'src/api/.phada/config.yml: context.defaults is only read from the root .phada/config.yml or your own config; ignored.',
      'src/api/.phada/config.yml: provider is only read from your own config; ignored.',
    ])
  })

  it('ignores provider, model and localFiles in the repository root', () => {
    const merged = mergeConfig([root({ provider: 'ollama', model: 'x', localFiles: ['/etc'] })])

    expect(merged.localFiles).toEqual([])
    expect(merged.warnings).toEqual([
      '.phada/config.yml: provider is only read from your own config; ignored.',
      '.phada/config.yml: model is only read from your own config; ignored.',
      '.phada/config.yml: localFiles is only read from your own config; ignored.',
    ])
  })
})

describe('mergeConfig rules', () => {
  it('adds rules from every layer with keys, scopes and origins', () => {
    const merged = mergeConfig([
      user({ rules: [{ rule: 'Prefer early returns.' }] }, 'Write tests.'),
      root({
        rules: [{ id: 'orm-only', rule: 'Use the ORM.', scope: ['**/*.py'], severity: 'P1' }],
      }),
      sub('src/api', { rules: [{ rule: 'Validate params with zod.' }] }, 'Log with request.log.'),
    ])

    expect(merged.rules).toEqual([
      {
        key: 'user:config.yml#1',
        text: 'Prefer early returns.',
        scope: ['**'],
        origin: 'user:config.yml',
      },
      { key: 'user:rules.md', text: 'Write tests.', scope: ['**'], origin: 'user:rules.md' },
      {
        key: 'orm-only',
        text: 'Use the ORM.',
        scope: ['**/*.py'],
        severity: 'P1',
        origin: '.phada/config.yml',
      },
      {
        key: 'src/api/.phada/config.yml#1',
        text: 'Validate params with zod.',
        scope: ['src/api/**'],
        origin: 'src/api/.phada/config.yml',
      },
      {
        key: 'src/api/.phada/rules.md',
        text: 'Log with request.log.',
        scope: ['src/api/**'],
        origin: 'src/api/.phada/rules.md',
      },
    ])
  })

  it('makes subfolder scopes, files and ignore relative to the subfolder', () => {
    const merged = mergeConfig([
      sub('src/api', {
        rules: [{ rule: 'x', scope: ['**/*.ts', '/routes/*.ts'] }],
        context: { files: [{ path: 'README.md' }] },
        ignore: ['generated/**'],
      }),
    ])

    expect(merged.rules[0]?.scope).toEqual(['src/api/**/*.ts', 'src/api/routes/*.ts'])
    expect(merged.files).toEqual([
      { pattern: 'src/api/README.md', origin: 'src/api/.phada/config.yml' },
    ])
    expect(merged.ignore).toEqual(['src/api/generated/**'])
  })

  it('escapes glob characters in the name of the subfolder', () => {
    const merged = mergeConfig([
      sub(
        'app/(marketing)',
        {
          rules: [{ rule: 'x', scope: ['**/*.tsx'] }],
          ignore: ['gen/**'],
          context: { files: [{ path: 'README.md' }, { path: 'docs/*.md' }] },
        },
        'y',
      ),
    ])

    expect(merged.rules.map((rule) => rule.scope)).toEqual([
      ['app/\\(marketing\\)/**/*.tsx'],
      ['app/\\(marketing\\)/**'],
    ])
    expect(merged.ignore).toEqual(['app/\\(marketing\\)/gen/**'])
    expect(merged.files.map((file) => file.pattern)).toEqual([
      'app/(marketing)/README.md',
      'app/\\(marketing\\)/docs/*.md',
    ])
  })

  it('drops paths that leave the repository or the subfolder', () => {
    const merged = mergeConfig([
      sub('src/api', { context: { files: [{ path: '../../secrets.md' }] }, ignore: ['../x'] }),
      root({ context: { files: [{ path: '../outside.md' }] }, ignore: ['a/../../b'] }),
    ])

    expect(merged.files).toEqual([])
    expect(merged.ignore).toEqual([])
    expect(merged.warnings).toEqual([
      'src/api/.phada/config.yml: ../../secrets.md is outside src/api; ignored.',
      'src/api/.phada/config.yml: ../x is outside src/api; ignored.',
      '.phada/config.yml: ../outside.md is outside the repository; ignored.',
      '.phada/config.yml: a/../../b is outside the repository; ignored.',
    ])
  })

  it('disables rules everywhere from the root and the user, and only inside a subfolder from it', () => {
    const merged = mergeConfig([
      user({ disabledRules: ['u'] }),
      root({ disabledRules: ['a'] }),
      sub('src/(web)', { disabledRules: ['b', 'a'] }),
      sub('src/api', { disabledRules: ['b'] }),
    ])

    expect([...merged.disabledRules]).toEqual(['u', 'a'])
    expect(Object.fromEntries(merged.disabledIn)).toEqual({
      b: ['src/\\(web\\)/**', 'src/api/**'],
      a: ['src/\\(web\\)/**'],
    })
  })

  it('skips an empty rules.md', () => {
    expect(mergeConfig([root({}, '  \n')]).rules).toEqual([])
  })

  it('leaves HTML comments of a rules.md out of the rule', () => {
    const merged = mergeConfig([
      root({}, '<!-- Write one rule per line. -->\n\n- Use the ORM.\n<!--\nnote\n-->'),
      sub('src', {}, '<!-- only a comment -->\n'),
    ])

    expect(merged.rules.map((rule) => rule.text)).toEqual(['- Use the ORM.'])
  })

  it('keeps local files from the user layers', () => {
    const merged = mergeConfig([
      user({ localFiles: ['~/notes'] }),
      userRepo({ localFiles: ['/srv/docs/a.md'] }),
    ])

    expect(merged.localFiles).toEqual([
      { path: '~/notes', origin: 'user:config.yml' },
      { path: '/srv/docs/a.md', origin: 'user:repos/acme/shop/config.yml' },
    ])
  })
})

describe('resolveProvider', () => {
  const layers = [user({ provider: 'codex', model: 'gpt-5' }), userRepo({ model: 'o4' })]

  it('uses the provider and model of the most specific source that sets a provider', () => {
    expect(resolveProvider({}, layers)).toEqual({ provider: 'codex', model: 'gpt-5' })
  })

  it('never takes a configured model for a provider given as a flag', () => {
    expect(resolveProvider({ provider: 'ollama' }, layers)).toEqual({ provider: 'ollama' })
  })

  it('applies --model alone to the configured provider', () => {
    expect(resolveProvider({ model: 'gpt-4.1' }, layers)).toEqual({
      provider: 'codex',
      model: 'gpt-4.1',
    })
  })

  it('prefers the per-repository provider and its model', () => {
    const perRepo = [user({ provider: 'codex', model: 'gpt-5' }), userRepo({ provider: 'claude' })]

    expect(resolveProvider({}, perRepo)).toEqual({ provider: 'claude' })
  })

  it('takes the most specific model when no source sets a provider', () => {
    expect(resolveProvider({}, [user({ model: 'opus' }), userRepo({ model: 'sonnet' })])).toEqual({
      provider: 'claude',
      model: 'sonnet',
    })
  })

  it('defaults to claude with the provider default model', () => {
    expect(resolveProvider({}, [])).toEqual({ provider: 'claude' })
  })
})
