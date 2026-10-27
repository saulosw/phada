import { describe, expect, it } from 'vitest'
import { planUserConfigEdit } from './user-config-edit.js'
import type { UserConfigChange } from './user-config-edit.js'

const PATH = '/cfg/config.yml'
const TEMPLATE = '# Your own Phada config.\n# provider: claude\n'

function plan(current: string | null, changes: UserConfigChange[]) {
  return planUserConfigEdit({ path: PATH, current, template: TEMPLATE, changes })
}

function planned(current: string | null, changes: UserConfigChange[]) {
  const result = plan(current, changes)
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)
  return result.plan
}

describe('planUserConfigEdit', () => {
  it('replaces a value in place keeping the comments and the order', () => {
    const current = '# mine\nprovider: claude # the default\n\n# often\nlanguage: pt-BR\n'

    const result = planned(current, [{ kind: 'set', key: 'provider', value: 'codex' }])

    expect(result.text).toBe('# mine\nprovider: codex # the default\n\n# often\nlanguage: pt-BR\n')
    expect(result.changes).toEqual([{ key: 'provider', before: 'claude', after: 'codex' }])
    expect(result).toMatchObject({ path: PATH, exists: true, before: current })
  })

  it('adds a new key at the end and removes one', () => {
    const current = 'provider: claude\nmodel: opus # pinned\n# tail\n'

    const result = planned(current, [
      { kind: 'unset', key: 'model' },
      { kind: 'set', key: 'language', value: 'pt-BR' },
    ])

    expect(result.text).toBe('provider: claude\nlanguage: pt-BR\n\n# tail\n')
    expect(result.changes).toEqual([
      { key: 'model', before: 'opus', after: null },
      { key: 'language', before: null, after: 'pt-BR' },
    ])
  })

  it('changes nothing when the values are already there', () => {
    const current = 'provider: claude   # spaced\n'

    const result = planned(current, [
      { kind: 'set', key: 'provider', value: 'claude' },
      { kind: 'unset', key: 'model' },
    ])

    expect(result).toEqual({
      path: PATH,
      exists: true,
      before: current,
      text: current,
      changes: [],
    })
  })

  it('starts a new file with the chosen values on top of the commented template', () => {
    const result = planned(null, [
      { kind: 'set', key: 'provider', value: 'ollama' },
      { kind: 'set', key: 'model', value: 'qwen2.5-coder:7b' },
    ])

    expect(result.text).toBe(`provider: ollama\nmodel: qwen2.5-coder:7b\n\n${TEMPLATE}`)
    expect(result).toMatchObject({ exists: false, before: null })
  })

  it('starts below the comments of a file that has only comments', () => {
    const result = planned('# just notes\n', [{ kind: 'set', key: 'language', value: 'es' }])

    expect(result.text).toBe('# just notes\n\nlanguage: es\n')
  })

  it.each([
    ['an unknown key', 'providr: claude\n', 'providr'],
    ['broken YAML', 'provider: [claude\n', ''],
  ])('refuses to edit a config with %s, with the error', (_, current, key) => {
    const result = plan(current, [{ kind: 'set', key: 'language', value: 'es' }])

    expect(result).toEqual({
      ok: false,
      reason: 'invalid-config',
      message: expect.stringContaining(key),
    })
  })

  it('refuses a change that leaves the config invalid', () => {
    expect(plan('', [{ kind: 'set', key: 'language', value: 'português' }])).toEqual({
      ok: false,
      reason: 'invalid-result',
      message: 'language: use a tag like en or pt-BR',
    })
    expect(plan('', [{ kind: 'set', key: 'provider', value: 'gemini' }])).toMatchObject({
      ok: false,
      reason: 'invalid-result',
    })
  })

  it('switches to ollama only with a model in the same change', () => {
    const current = 'provider: claude\nmodel: opus\n'

    expect(plan(current, [{ kind: 'set', key: 'provider', value: 'ollama' }])).toEqual({
      ok: false,
      reason: 'ollama-without-model',
    })
    expect(plan('provider: ollama\nmodel: llama3\n', [{ kind: 'unset', key: 'model' }])).toEqual({
      ok: false,
      reason: 'ollama-without-model',
    })
    expect(
      planned(current, [
        { kind: 'set', key: 'provider', value: 'ollama' },
        { kind: 'set', key: 'model', value: 'qwen2.5-coder:7b' },
      ]).text,
    ).toBe('provider: ollama\nmodel: qwen2.5-coder:7b\n')
    expect(
      planned('provider: ollama\nmodel: llama3\n', [{ kind: 'set', key: 'language', value: 'es' }])
        .changes,
    ).toEqual([{ key: 'language', before: null, after: 'es' }])
  })
})
