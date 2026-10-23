import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeclaredMcpServer } from '../../config/mcp-servers.js'
import { connectMcp, McpConnectError } from './mcp-client.js'
import type { McpConnection } from './mcp-client.js'

const FIXTURE = fileURLToPath(
  new URL('../../../test/fixtures/mcp/fake-mcp-server.mjs', import.meta.url),
)

const opened: McpConnection[] = []

afterEach(async () => {
  for (const connection of opened.splice(0)) await connection.close()
})

function stdioServer(
  env: Record<string, string> = {},
  command = process.execPath,
): DeclaredMcpServer {
  return {
    name: 'tickets',
    transport: { kind: 'stdio', command, args: command === process.execPath ? [FIXTURE] : [], env },
  }
}

async function connect(
  server: DeclaredMcpServer,
  options: Partial<Parameters<typeof connectMcp>[1]> = {},
): Promise<McpConnection> {
  const connection = await connectMcp(server, { env: { PATH: process.env.PATH ?? '' }, ...options })
  opened.push(connection)
  return connection
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('connectMcp over stdio', () => {
  it('lists the tools with their read-only hint', async () => {
    const connection = await connect(stdioServer())

    expect(connection.name).toBe('tickets')
    expect(connection.tools.map(({ name, readOnly }) => [name, readOnly])).toEqual([
      ['get_ticket', true],
      ['search', true],
      ['create_ticket', false],
    ])
    expect(connection.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    })
  })

  it('calls a tool, passes env to the server and joins the content', async () => {
    const connection = await connect(stdioServer({ FAKE_FACT: 'amounts must be positive' }))

    expect(await connection.call('get_ticket', { id: 'ABC-1' })).toEqual({
      text: 'TICKET ABC-1: amounts must be positive\nresource body\n[image omitted]',
      isError: false,
    })
  })

  it('ignores stdout lines that are not JSON-RPC', async () => {
    const connection = await connect(stdioServer({ FAKE_MCP_MODE: 'noisy' }))

    expect(connection.tools).toHaveLength(3)
  })

  it('gives up on a server that never answers initialize', async () => {
    const started = performance.now()
    const error = await connect(stdioServer({ FAKE_MCP_MODE: 'silent' }), {
      connectTimeoutMs: 200,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(McpConnectError)
    expect(String(error)).toContain('did not answer within 0.2s')
    expect(performance.now() - started).toBeLessThan(3000)
  })

  it('fails to connect when the command does not exist', async () => {
    const error = await connect(stdioServer({}, 'phada-no-such-mcp-command')).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(McpConnectError)
    expect(String(error)).toContain('phada-no-such-mcp-command was not found')
  })

  it('answers every later call with an error once the server stops', async () => {
    const connection = await connect(stdioServer({ FAKE_MCP_MODE: 'crash-on-call' }))

    expect(await connection.call('get_ticket', { id: '1' })).toEqual({
      text: 'MCP server tickets stopped.',
      isError: true,
    })
    expect(await connection.call('search', {})).toEqual({
      text: 'MCP server tickets stopped.',
      isError: true,
    })
  })

  it('joins the pages of tools/list', async () => {
    const connection = await connect(stdioServer({ FAKE_MCP_MODE: 'paged' }))

    expect(connection.tools.map(({ name }) => name)).toEqual([
      'get_ticket',
      'search',
      'create_ticket',
    ])
  })

  it('answers a ping the server sends', async () => {
    const connection = await connect(stdioServer({ FAKE_MCP_MODE: 'ping' }))

    expect(connection.tools).toHaveLength(3)
  })

  it('passes a tool error on', async () => {
    const connection = await connect(stdioServer({ FAKE_MCP_MODE: 'error-tool' }))

    expect(await connection.call('get_ticket', { id: '1' })).toEqual({
      text: 'no such ticket',
      isError: true,
    })
  })

  it('times a slow call out', async () => {
    const connection = await connect(stdioServer({ FAKE_MCP_MODE: 'silent-calls' }), {
      callTimeoutMs: 100,
    })

    expect(await connection.call('get_ticket', { id: '1' })).toEqual({
      text: 'MCP server tickets did not answer within 0.1s.',
      isError: true,
    })
  })

  it('stops the server process on close', async () => {
    const connection = await connectMcp(stdioServer(), { env: {} })
    const pid = connection.pid ?? 0

    expect(isRunning(pid)).toBe(true)
    await connection.close()
    expect(isRunning(pid)).toBe(false)
  })
})

interface HttpRequest {
  method: string
  headers: Record<string, string>
  body: { id?: string | number; method?: string; params?: unknown } | undefined
}

function httpFetch(answer: (request: HttpRequest) => Response | Promise<Response>) {
  const requests: HttpRequest[] = []
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request: HttpRequest = {
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    requests.push(request)
    return answer(request)
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

const TOOLS = [
  {
    name: 'lookup',
    description: 'Look up a doc.',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
]

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function rpcResult(request: HttpRequest, sessionId = 'session-1'): Response {
  const id = request.body?.id
  if (request.body?.id === undefined) return new Response(null, { status: 202 })
  switch (request.body.method) {
    case 'initialize':
      return json(
        {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: {} },
        },
        { 'mcp-session-id': sessionId },
      )
    case 'tools/list':
      return json({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    default:
      return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'doc text' }] } })
  }
}

const httpServer: DeclaredMcpServer = {
  name: 'docs',
  transport: {
    kind: 'http',
    url: 'https://mcp.acme.dev/mcp',
    headers: { Authorization: 'Bearer test-token' },
  },
}

describe('connectMcp over streamable HTTP', () => {
  it('sends the configured headers, then the session and protocol headers', async () => {
    const { fetch, requests } = httpFetch((request) => rpcResult(request))
    const connection = await connect(httpServer, { fetch })

    expect(await connection.call('lookup', { q: 'x' })).toEqual({
      text: 'doc text',
      isError: false,
    })
    const [initialize, initialized, list, call] = requests
    expect(initialize?.method).toBe('POST')
    expect(initialize?.headers['authorization']).toBe('Bearer test-token')
    expect(initialize?.headers['accept']).toBe('application/json, text/event-stream')
    expect(initialize?.headers['mcp-session-id']).toBeUndefined()
    expect(initialized?.body?.method).toBe('notifications/initialized')
    expect(list?.headers['mcp-session-id']).toBe('session-1')
    expect(call?.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(call?.headers['authorization']).toBe('Bearer test-token')
  })

  it('reads the answer from an event stream after a notification', async () => {
    const { fetch } = httpFetch((request) => {
      if (request.body?.method !== 'tools/list') return rpcResult(request)
      const events = [
        { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'hi' } },
        { jsonrpc: '2.0', id: request.body.id, result: { tools: TOOLS } },
      ]
      return new Response(
        events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    })
    const connection = await connect(httpServer, { fetch })

    expect(connection.tools.map(({ name }) => name)).toEqual(['lookup'])
  })

  it('reports refused credentials', async () => {
    const { fetch } = httpFetch(() => new Response('nope', { status: 401 }))
    const error = await connect(httpServer, { fetch }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(McpConnectError)
    expect(String(error)).toContain('MCP server docs refused the credentials (HTTP 401)')
  })

  it('starts a new session once when the server forgot the old one', async () => {
    let sessions = 0
    let expired = false
    const { fetch, requests } = httpFetch((request) => {
      if (request.body?.method === 'initialize') sessions += 1
      if (request.body?.method === 'tools/call' && !expired) {
        expired = true
        return new Response('', { status: 404 })
      }
      return rpcResult(request, `session-${sessions}`)
    })
    const connection = await connect(httpServer, { fetch })

    expect(await connection.call('lookup', {})).toEqual({ text: 'doc text', isError: false })
    expect(sessions).toBe(2)
    expect(requests.at(-1)?.headers['mcp-session-id']).toBe('session-2')
  })

  it('ends the session on close', async () => {
    const { fetch, requests } = httpFetch((request) =>
      request.method === 'DELETE' ? new Response(null, { status: 200 }) : rpcResult(request),
    )
    const connection = await connectMcp(httpServer, { env: {}, fetch })
    await connection.close()

    expect(requests.at(-1)).toMatchObject({
      method: 'DELETE',
      headers: { 'mcp-session-id': 'session-1' },
    })
  })
})
