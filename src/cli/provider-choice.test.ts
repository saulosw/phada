import { describe, expect, it } from 'vitest'
import { UsageError } from './errors.js'
import { assertProviderChoice } from './provider-choice.js'

const declared = {
  names: [],
  declared: [
    { name: 'tickets', transport: { kind: 'stdio' as const, command: 'x', args: [], env: {} } },
  ],
}

describe('assertProviderChoice', () => {
  it('accepts a known provider', () => {
    expect(() => assertProviderChoice('codex', {})).not.toThrow()
    expect(() =>
      assertProviderChoice('claude', { mcp: { names: [{ name: 'linear' }], declared: [] } }),
    ).not.toThrow()
  })

  it('accepts declared MCP servers with every provider and names with Codex', () => {
    expect(() => assertProviderChoice('codex', { mcp: declared })).not.toThrow()
    expect(() => assertProviderChoice('ollama', { model: 'qwen', mcp: declared })).not.toThrow()
    expect(() =>
      assertProviderChoice('codex', { mcp: { names: [{ name: 'linear' }], declared: [] } }),
    ).not.toThrow()
  })

  it.each([
    ['an unknown provider', 'gemini', {}, 'Unknown provider "gemini"'],
    ['ollama without a model', 'ollama', {}, '--provider ollama needs --model'],
    [
      'a named MCP server with Ollama',
      'ollama',
      { model: 'qwen', mcp: { names: [{ name: 'linear' }], declared: [] } },
      'MCP server linear: Ollama has no MCP servers of its own; declare it with command or url in your config.',
    ],
  ])('refuses %s', (_case, name, options, message) => {
    expect(() => assertProviderChoice(name, options)).toThrow(UsageError)
    expect(() => assertProviderChoice(name, options)).toThrow(message)
  })
})
