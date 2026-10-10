import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import type { Toolbox } from '../toolbox.js'
import { handleMcpMessage, MCP_SERVER_NAME, serveMcp } from './mcp-server.js'
import type { McpServer } from './mcp-server.js'

const fakeToolbox: Toolbox = {
  definitions: [
    {
      name: 'read_file',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
  call: async (name, args) =>
    name === 'read_file'
      ? { text: `read ${JSON.stringify(args)}`, isError: false }
      : { text: 'unknown', isError: true },
  touchedPaths: () => [],
}

async function answer(message: unknown): Promise<unknown> {
  const line = await handleMcpMessage(
    fakeToolbox,
    typeof message === 'string' ? message : JSON.stringify(message),
  )
  return line === undefined ? undefined : JSON.parse(line)
}

describe('handleMcpMessage', () => {
  it('is the phada server', () => {
    expect(MCP_SERVER_NAME).toBe('phada')
  })

  it('answers initialize with the client protocol version and the tools capability', async () => {
    expect(
      await answer({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'phada', version: '1' },
      },
    })
  })

  it('ignores notifications', async () => {
    expect(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
  })

  it('answers ping', async () => {
    expect(await answer({ jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    })
  })

  it('lists the tools as read-only', async () => {
    expect(await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            annotations: { readOnlyHint: true, openWorldHint: false },
          },
        ],
      },
    })
  })

  it('calls a tool', async () => {
    expect(
      await answer({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'a.ts' } },
      }),
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'read {"path":"a.ts"}' }], isError: false },
    })
  })

  it('passes empty arguments when none are given', async () => {
    expect(
      await answer({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'other' } }),
    ).toMatchObject({ result: { isError: true } })
  })

  it('refuses an unknown method', async () => {
    expect(await answer({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).toEqual({
      jsonrpc: '2.0',
      id: 4,
      error: { code: -32601, message: 'Method not found: resources/list' },
    })
  })

  it('refuses a line that is not JSON', async () => {
    expect(await answer('{')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    })
  })
})

describe('serveMcp', () => {
  const servers: McpServer[] = []
  const roots: string[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function exchange(server: McpServer, requests: unknown[]): Promise<unknown[]> {
    const child = spawn(server.launch.command, server.launch.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const lines = createInterface({ input: child.stdout })
    const answers: unknown[] = []
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
    for await (const line of lines) {
      answers.push(JSON.parse(line))
      if (answers.length === requests.length) break
    }
    child.kill()
    return answers
  }

  it('serves the toolbox to a process that runs the bridge', async () => {
    const server = await serveMcp(fakeToolbox, { execArgv: ['--import', 'tsx'] })
    servers.push(server)

    const answers = await exchange(server, [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 'x' } },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'a.ts' } },
      },
    ])

    expect(answers).toEqual([
      expect.objectContaining({ id: 0, result: expect.objectContaining({ protocolVersion: 'x' }) }),
      expect.objectContaining({ id: 1, result: expect.objectContaining({ isError: false }) }),
    ])
    expect(server.launch.args.at(-2)).toMatch(/mcp-bridge\.js$/)
  })

  it('keeps serving after a client goes away, and removes its folder on close', async () => {
    const server = await serveMcp(fakeToolbox, { execArgv: ['--import', 'tsx'] })
    servers.push(server)
    const socket = server.launch.args.at(-1) ?? ''

    await exchange(server, [{ jsonrpc: '2.0', id: 0, method: 'ping' }])
    expect(await exchange(server, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
    ])

    await server.close()
    expect(existsSync(dirname(socket))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'moves the socket to /tmp when the temporary folder path is too long',
    async () => {
      const root = mkdtempSync(join(tmpdir(), `phada-long-${'x'.repeat(110)}-`))
      roots.push(root)
      const server = await serveMcp(fakeToolbox, { tempRoot: root, execArgv: ['--import', 'tsx'] })
      servers.push(server)

      expect(server.launch.args.at(-1)).toMatch(/^\/tmp\/phada-mcp-/)
      expect(await exchange(server, [{ jsonrpc: '2.0', id: 0, method: 'ping' }])).toHaveLength(1)
    },
  )
})
