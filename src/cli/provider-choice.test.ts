import { describe, expect, it } from 'vitest'
import { UsageError } from './errors.js'
import { assertProviderChoice } from './provider-choice.js'

describe('assertProviderChoice', () => {
  it('accepts a known provider', () => {
    expect(() => assertProviderChoice('codex', {})).not.toThrow()
    expect(() => assertProviderChoice('claude', { userMcpServers: ['linear'] })).not.toThrow()
  })

  it.each([
    ['an unknown provider', 'gemini', {}, 'Unknown provider "gemini"'],
    ['ollama without a model', 'ollama', {}, '--provider ollama needs --model'],
    [
      'MCP servers with another provider',
      'codex',
      { userMcpServers: ['linear'] },
      'mcp in your config works only with --provider claude',
    ],
  ])('refuses %s', (_case, name, options, message) => {
    expect(() => assertProviderChoice(name, options)).toThrow(UsageError)
    expect(() => assertProviderChoice(name, options)).toThrow(message)
  })
})
