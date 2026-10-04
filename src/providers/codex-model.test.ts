import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexModel } from './codex-model.js'

const HOME = '/home/tester'

function configFiles(files: Record<string, string>) {
  const reads: string[] = []
  const readFile = (path: string) => {
    reads.push(path)
    const content = files[path]
    return content === undefined
      ? Promise.reject(new Error(`ENOENT: ${path}`))
      : Promise.resolve(content)
  }
  return { readFile, reads }
}

const DEFAULT_CONFIG = join(HOME, '.codex', 'config.toml')

describe('resolveCodexModel', () => {
  it('prefers the --model flag, trimmed, without reading the config', async () => {
    const { readFile, reads } = configFiles({ [DEFAULT_CONFIG]: 'model = "gpt-config"' })

    const model = await resolveCodexModel({ model: ' gpt-flag ', env: {}, homeDir: HOME, readFile })

    expect(model).toBe('gpt-flag')
    expect(reads).toEqual([])
  })

  it('reads the top-level model from ~/.codex/config.toml', async () => {
    const { readFile } = configFiles({
      [DEFAULT_CONFIG]: 'model = "gpt-config"\nmodel_reasoning_effort = "medium"\n',
    })

    expect(await resolveCodexModel({ env: {}, homeDir: HOME, readFile })).toBe('gpt-config')
  })

  it('reads the config from CODEX_HOME when it is set', async () => {
    const { readFile } = configFiles({ '/custom/codex/config.toml': "model = 'gpt-custom'" })

    const model = await resolveCodexModel({
      env: { CODEX_HOME: '/custom/codex' },
      homeDir: HOME,
      readFile,
    })

    expect(model).toBe('gpt-custom')
  })

  it('accepts spaces and a trailing comment around the model', async () => {
    const { readFile } = configFiles({ [DEFAULT_CONFIG]: '  model =  "gpt-x"  # mine\n' })

    expect(await resolveCodexModel({ env: {}, homeDir: HOME, readFile })).toBe('gpt-x')
  })

  it('ignores a model that only appears inside a table', async () => {
    const { readFile } = configFiles({
      [DEFAULT_CONFIG]: 'approval_policy = "never"\n[profiles.fast]\nmodel = "gpt-profile"\n',
    })

    expect(await resolveCodexModel({ env: {}, homeDir: HOME, readFile })).toBeUndefined()
  })

  it('ignores keys that only start with "model"', async () => {
    const { readFile } = configFiles({ [DEFAULT_CONFIG]: 'model_provider = "openai"\n' })

    expect(await resolveCodexModel({ env: {}, homeDir: HOME, readFile })).toBeUndefined()
  })

  it.each(['', 'model = ""', 'model = "  "', 'not toml at all {'])(
    'returns undefined for the config %j',
    async (content) => {
      const { readFile } = configFiles({ [DEFAULT_CONFIG]: content })

      expect(await resolveCodexModel({ env: {}, homeDir: HOME, readFile })).toBeUndefined()
    },
  )

  it('returns undefined when the config file is missing', async () => {
    const { readFile } = configFiles({})

    expect(await resolveCodexModel({ env: {}, homeDir: HOME, readFile })).toBeUndefined()
  })
})
