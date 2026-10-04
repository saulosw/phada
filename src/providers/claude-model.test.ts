import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_MODEL, resolveClaudeModel } from './claude-model.js'

let homeDir: string

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'phada-claude-model-test-'))
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
})

function writeSettings(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), content)
}

describe('resolveClaudeModel', () => {
  it('prefers the model passed by the caller over everything else', async () => {
    writeSettings(join(homeDir, '.claude'), '{"model":"opus"}')

    const model = await resolveClaudeModel({
      model: 'claude-flag',
      env: { ANTHROPIC_MODEL: 'claude-env' },
      homeDir,
    })

    expect(model).toBe('claude-flag')
  })

  it('uses ANTHROPIC_MODEL when no model is passed', async () => {
    writeSettings(join(homeDir, '.claude'), '{"model":"opus"}')

    expect(await resolveClaudeModel({ env: { ANTHROPIC_MODEL: 'claude-env' }, homeDir })).toBe(
      'claude-env',
    )
  })

  it('uses the model from the Claude settings in the home directory', async () => {
    writeSettings(
      join(homeDir, '.claude'),
      '{"model":"claude-settings-model","effortLevel":"high"}',
    )

    expect(await resolveClaudeModel({ env: {}, homeDir })).toBe('claude-settings-model')
  })

  it('reads the settings from CLAUDE_CONFIG_DIR when it is set', async () => {
    const configDir = join(homeDir, 'custom-config')
    writeSettings(configDir, '{"model":"haiku"}')
    writeSettings(join(homeDir, '.claude'), '{"model":"opus"}')

    expect(await resolveClaudeModel({ env: { CLAUDE_CONFIG_DIR: configDir }, homeDir })).toBe(
      'haiku',
    )
  })

  it('falls back to opus when there is no settings file', async () => {
    expect(await resolveClaudeModel({ env: {}, homeDir })).toBe(DEFAULT_CLAUDE_MODEL)
    expect(DEFAULT_CLAUDE_MODEL).toBe('opus')
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON array', '["opus"]'],
    ['no model field', '{"effortLevel":"high"}'],
    ['an empty model', '{"model":"  "}'],
    ['a model that is not a string', '{"model":42}'],
  ])('falls back to opus when the settings have %s', async (_case, content) => {
    writeSettings(join(homeDir, '.claude'), content)

    expect(await resolveClaudeModel({ env: {}, homeDir })).toBe(DEFAULT_CLAUDE_MODEL)
  })

  it('falls back to opus when the settings file cannot be read', async () => {
    const readFile = () => Promise.reject(new Error('EACCES'))

    expect(await resolveClaudeModel({ env: {}, homeDir, readFile })).toBe(DEFAULT_CLAUDE_MODEL)
  })

  it('trims values and treats blank ones as missing', async () => {
    writeSettings(join(homeDir, '.claude'), '{"model":" claude-settings-model "}')

    const model = await resolveClaudeModel({
      model: '   ',
      env: { ANTHROPIC_MODEL: '\t' },
      homeDir,
    })

    expect(model).toBe('claude-settings-model')
  })

  it('reads settings.json inside the resolved config directory', async () => {
    const paths: string[] = []
    const readFile = (path: string) => {
      paths.push(path)
      return Promise.resolve('{"model":"opus"}')
    }

    await resolveClaudeModel({ env: {}, homeDir: '/home/someone', readFile })

    expect(paths).toEqual(['/home/someone/.claude/settings.json'])
  })
})
