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

  it('keeps a long value on one line', () => {
    const rule = `  - rule: ${'Use the ORM for every query; never build SQL by hand. '.repeat(3).trim()}\n`
    const current = `provider: claude\nrules:\n${rule}`

    expect(planned(current, [{ kind: 'unset', key: 'provider' }]).text).toBe(`rules:\n${rule}`)
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

  describe('watched repositories', () => {
    const WATCHING = `watch:
  interval: 5m # often
  repos:
    - acme/api # the main one
    - repo: acme/web
      labels: [phada]
`

    it('adds a repository at the end of watch.repos', () => {
      const result = planned(WATCHING, [{ kind: 'watch', repo: 'acme/sdk' }])

      expect(result.text).toBe(`${WATCHING}    - acme/sdk\n`)
      expect(result.changes).toEqual([{ key: 'watch.repos', added: ['acme/sdk'], removed: [] }])
    })

    it('starts the watch block when there is none', () => {
      const result = planned('provider: claude\n', [{ kind: 'watch', repo: 'acme/api' }])

      expect(result.text).toBe('provider: claude\nwatch:\n  repos:\n    - acme/api\n')
    })

    it('matches a repository by name, ignoring case', () => {
      expect(planned(WATCHING, [{ kind: 'watch', repo: 'Acme/Web' }]).changes).toEqual([])
      expect(planned(WATCHING, [{ kind: 'unwatch', repo: 'acme/nope' }]).changes).toEqual([])

      const result = planned(WATCHING, [{ kind: 'unwatch', repo: 'ACME/web' }])

      expect(result.text).toBe(
        'watch:\n  interval: 5m # often\n  repos:\n    - acme/api # the main one\n',
      )
      expect(result.changes).toEqual([{ key: 'watch.repos', added: [], removed: ['acme/web'] }])
    })

    it('refuses a repository name that is not owner/repo', () => {
      expect(plan(WATCHING, [{ kind: 'watch', repo: 'acme' }])).toMatchObject({
        ok: false,
        reason: 'invalid-result',
      })
    })

    it('removes the watch block with its last repository when it holds nothing else', () => {
      const current = 'provider: claude\nwatch:\n  repos: [acme/api]\nlanguage: es\n'

      const result = planned(current, [{ kind: 'unwatch', repo: 'acme/api' }])

      expect(result.text).toBe('provider: claude\nlanguage: es\n')
      expect(result.changes).toEqual([{ key: 'watch.repos', added: [], removed: ['acme/api'] }])
    })

    it('keeps the other watch settings, refusing to take out the last repository', () => {
      const current = 'watch:\n  interval: 5m\n  settle: 1m\n  repos: [acme/api]\n'

      expect(plan(current, [{ kind: 'unwatch', repo: 'acme/api' }])).toEqual({
        ok: false,
        reason: 'last-watched-repo',
        repo: 'acme/api',
        settings: ['interval', 'settle'],
      })
    })

    it('turns publishing off, writing an entry as an object only when it has to', () => {
      const result = planned(WATCHING, [
        { kind: 'publish', repo: 'acme/api', publish: false },
        { kind: 'publish', repo: 'acme/web', publish: false },
      ])

      expect(result.text).toBe(`watch:
  interval: 5m # often
  repos:
    - repo: acme/api # the main one
      publish: false
    - repo: acme/web
      labels: [phada]
      publish: false
`)
      expect(result.changes).toEqual([
        { key: 'publish', repo: 'acme/api', before: true, after: false },
        { key: 'publish', repo: 'acme/web', before: true, after: false },
      ])
    })

    it('turns publishing back on, back to a plain name when nothing else is set', () => {
      const current = `watch:
  repos:
    - repo: acme/api # the main one
      publish: false
    - repo: acme/web
      publish: false
      labels: [phada]
`

      const result = planned(current, [
        { kind: 'publish', repo: 'acme/api', publish: true },
        { kind: 'publish', repo: 'acme/web', publish: true },
        { kind: 'publish', repo: 'acme/web', publish: true },
      ])

      expect(result.text).toBe(`watch:
  repos:
    - acme/api # the main one
    - repo: acme/web
      labels: [phada]
`)
      expect(result.changes).toEqual([
        { key: 'publish', repo: 'acme/api', before: false, after: true },
        { key: 'publish', repo: 'acme/web', before: false, after: true },
      ])
    })

    it('refuses to set publishing on a repository it does not watch', () => {
      expect(plan(WATCHING, [{ kind: 'publish', repo: 'acme/sdk', publish: false }])).toEqual({
        ok: false,
        reason: 'not-watched',
        repo: 'acme/sdk',
      })
    })
  })
})
