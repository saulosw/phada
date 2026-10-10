import { describe, expect, it } from 'vitest'
import { parseConfigText } from './parse-config.js'

describe('parseConfigText', () => {
  it('reads every key', () => {
    const text = [
      'provider: codex',
      'model: gpt-5',
      'language: pt-BR',
      'minConfidence: 70',
      'verify: true',
      'ignore: ["**/*.snap"]',
      'rules:',
      '  - id: orm-only',
      '    rule: Use the ORM.',
      '    scope: ["**/*.py"]',
      '    severity: P1',
      '  - rule: No console.log in request code.',
      'disabledRules: [no-console]',
      'context:',
      '  defaults: false',
      '  files:',
      '    - path: docs/architecture.md',
      '      description: Layers',
      'localFiles: ["~/notes/rules"]',
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        provider: 'codex',
        model: 'gpt-5',
        language: 'pt-BR',
        minConfidence: 70,
        verify: true,
        ignore: ['**/*.snap'],
        rules: [
          { id: 'orm-only', rule: 'Use the ORM.', scope: ['**/*.py'], severity: 'P1' },
          { rule: 'No console.log in request code.' },
        ],
        disabledRules: ['no-console'],
        context: {
          defaults: false,
          files: [{ path: 'docs/architecture.md', description: 'Layers' }],
        },
        localFiles: ['~/notes/rules'],
      },
    })
  })

  it.each([
    ['an empty file', ''],
    ['only comments', '# nothing here\n'],
  ])('treats %s as an empty config', (_case, text) => {
    expect(parseConfigText(text)).toEqual({ ok: true, config: {} })
  })

  it.each([
    ['an unknown key', 'colour: red', 'colour'],
    ['a severity outside P0-P2', 'rules:\n  - rule: x\n    severity: P3', 'rules.0.severity'],
    ['a cut outside 50-100', 'minConfidence: 40', 'minConfidence'],
    ['an invalid language tag', 'language: português', 'language'],
    ['an empty rule', 'rules:\n  - rule: "  "', 'rules.0.rule'],
    ['a rule id with spaces', 'rules:\n  - id: no console\n    rule: x', 'rules.0.id'],
    ['an unknown key inside a rule', 'rules:\n  - rule: x\n    level: high', 'rules.0.level'],
    ['an exception in ignore', 'ignore: ["dist/**", "!dist/keep.js"]', 'ignore.1'],
    [
      'an exception in a rule scope',
      'rules:\n  - rule: x\n    scope: ["!**/*.test.ts"]',
      'rules.0.scope.0',
    ],
    [
      'an exception in context files',
      'context:\n  files:\n    - path: "!docs/**"',
      'context.files.0.path',
    ],
  ])('rejects %s and names the key', (_case, text, path) => {
    const parsed = parseConfigText(text)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(new RegExp(`^${path.replaceAll('.', '\\.')}: `))
  })

  it.each([
    ['a list at the top', '- a\n- b'],
    ['a scalar at the top', 'just text'],
  ])('rejects %s', (_case, text) => {
    expect(parseConfigText(text).ok).toBe(false)
  })

  it('explains that exceptions with ! are not supported', () => {
    expect(parseConfigText('ignore: ["!src/keep.ts"]')).toEqual({
      ok: false,
      message: 'ignore.0: exceptions with ! are not supported; list only the files to match',
    })
  })

  it('reports broken YAML on one line', () => {
    const parsed = parseConfigText('rules: [unclosed')

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).not.toContain('\n')
  })
})
