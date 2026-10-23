import { describe, expect, it } from 'vitest'
import type { DeclaredMcpServer } from '../../config/mcp-servers.js'
import type { McpConnection, McpTool } from '../mcp/mcp-client.js'
import { BUDGET_EXHAUSTED } from './budget.js'
import { mcpTools } from './mcp-tools.js'
import { ToolLog } from './tool-log.js'
import { createToolbox } from './tool-registry.js'

const tool = (name: string, readOnly: boolean): McpTool => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: 'object' },
  readOnly,
})

function connection(name: string, tools: McpTool[], calls: unknown[] = []): McpConnection {
  return {
    name,
    tools,
    call: async (toolName, args) => {
      calls.push([toolName, args])
      if (toolName === 'broken') return { text: 'no such ticket', isError: true }
      if (toolName === 'huge') return { text: 'x'.repeat(40_000), isError: false }
      return { text: `${toolName} ${JSON.stringify(args)}`, isError: false }
    },
    close: async () => {},
  }
}

const server = (name: string, tools?: string[]): DeclaredMcpServer => ({
  name,
  transport: { kind: 'stdio', command: 'x', args: [], env: {} },
  ...(tools === undefined ? {} : { tools }),
})

const TICKETS = [tool('get_ticket', true), tool('search', true), tool('create_ticket', false)]

describe('mcpTools', () => {
  it('offers only read-only tools, named after their server, and hides the rest', () => {
    const { tools, reports, warnings } = mcpTools([
      { server: server('tickets'), connection: connection('tickets', TICKETS) },
    ])

    expect(tools.map(({ definition }) => [definition.name, definition.server])).toEqual([
      ['tickets__get_ticket', 'tickets'],
      ['tickets__search', 'tickets'],
    ])
    expect(tools[0]?.definition.description).toBe('get_ticket tool')
    expect(reports).toEqual([
      {
        server: 'tickets',
        via: 'phada',
        status: 'connected',
        tools: ['get_ticket', 'search'],
        hidden: ['create_ticket'],
      },
    ])
    expect(warnings).toEqual([])
  })

  it('offers exactly the tools listed in tools, write tools included', () => {
    const { tools, reports } = mcpTools([
      { server: server('tickets', ['create_ticket']), connection: connection('tickets', TICKETS) },
    ])

    expect(tools.map(({ definition }) => definition.name)).toEqual(['tickets__create_ticket'])
    expect(reports[0]?.hidden).toEqual(['get_ticket', 'search'])
  })

  it('warns about a listed tool the server does not have', () => {
    const { warnings } = mcpTools([
      {
        server: server('tickets', ['get_ticket', 'nope']),
        connection: connection('tickets', TICKETS),
      },
    ])

    expect(warnings).toEqual(['MCP server tickets has no tool nope.'])
  })

  it('warns when a server has no read-only tool and no tools list', () => {
    const { tools, warnings } = mcpTools([
      {
        server: server('writer'),
        connection: connection('writer', [tool('create_ticket', false)]),
      },
    ])

    expect(tools).toEqual([])
    expect(warnings).toEqual([
      'MCP server writer exposes no read-only tools; list the ones to allow in tools.',
    ])
  })

  it('skips a tool whose exposed name would be longer than 64 characters or not a plain name', () => {
    const { tools, reports } = mcpTools([
      {
        server: server('tickets'),
        connection: connection('tickets', [tool('a'.repeat(60), true), tool('with.dot', true)]),
      },
    ])

    expect(tools).toEqual([])
    expect(reports[0]?.hidden).toEqual(['a'.repeat(60), 'with.dot'])
  })

  it('calls the server through the toolbox, in the shared budget and log', async () => {
    const calls: unknown[] = []
    const { tools } = mcpTools([
      {
        server: server('tickets', ['get_ticket', 'broken', 'huge']),
        connection: connection(
          'tickets',
          [tool('get_ticket', true), tool('broken', true), tool('huge', true)],
          calls,
        ),
      },
    ])
    const log = new ToolLog()
    const toolbox = createToolbox(tools, log, 'review', { budget: { calls: 3, bytes: 512_000 } })

    expect(await toolbox.call('tickets__get_ticket', { id: 'ABC-1' })).toEqual({
      text: 'get_ticket {"id":"ABC-1"}',
      isError: false,
    })
    expect(await toolbox.call('tickets__broken', {})).toEqual({
      text: 'no such ticket',
      isError: true,
    })
    const huge = await toolbox.call('tickets__huge', {})
    expect(Buffer.byteLength(huge.text)).toBeLessThan(32_200)
    expect(await toolbox.call('tickets__get_ticket', { id: 'X' })).toEqual({
      text: BUDGET_EXHAUSTED,
      isError: true,
    })
    expect(calls).toEqual([
      ['get_ticket', { id: 'ABC-1' }],
      ['broken', {}],
      ['huge', {}],
    ])
    expect(log.records.map(({ tool: name, server: from, error }) => [name, from, error])).toEqual([
      ['tickets__get_ticket', 'tickets', undefined],
      ['tickets__broken', 'tickets', 'mcp-error'],
      ['tickets__huge', 'tickets', undefined],
      ['tickets__get_ticket', 'tickets', 'budget'],
    ])
  })
})
