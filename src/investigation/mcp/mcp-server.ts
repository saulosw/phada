import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Toolbox } from '../toolbox.js'

export const MCP_SERVER_NAME = 'phada'

const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const MAX_SOCKET_PATH = 100
const SHORT_TEMP_ROOT = '/tmp'
const PARSE_ERROR = -32700
const METHOD_NOT_FOUND = -32601

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  id?: JsonRpcId
  method?: unknown
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown }
}

export interface McpLaunch {
  command: string
  args: string[]
}

export interface McpServer {
  launch: McpLaunch
  close(): Promise<void>
}

export interface ServeMcpOptions {
  tempRoot?: string
  execPath?: string
  execArgv?: string[]
}

export async function handleMcpMessage(
  toolbox: Toolbox,
  line: string,
): Promise<string | undefined> {
  let request: JsonRpcRequest
  try {
    request = JSON.parse(line) as JsonRpcRequest
  } catch {
    return reply(null, { error: { code: PARSE_ERROR, message: 'Parse error' } })
  }
  if (request.id === undefined) return undefined
  const id = request.id
  switch (request.method) {
    case 'initialize': {
      const version = request.params?.protocolVersion
      return reply(id, {
        result: {
          protocolVersion: typeof version === 'string' ? version : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: '1' },
        },
      })
    }
    case 'ping':
      return reply(id, { result: {} })
    case 'tools/list':
      return reply(id, {
        result: {
          tools: toolbox.definitions.map((definition) => ({
            ...definition,
            annotations: { readOnlyHint: true, openWorldHint: false },
          })),
        },
      })
    case 'tools/call': {
      const name = request.params?.name
      const result = await toolbox.call(
        typeof name === 'string' ? name : '',
        request.params?.arguments ?? {},
      )
      return reply(id, {
        result: { content: [{ type: 'text', text: result.text }], isError: result.isError },
      })
    }
    default:
      return reply(id, {
        error: { code: METHOD_NOT_FOUND, message: `Method not found: ${String(request.method)}` },
      })
  }
}

export async function serveMcp(
  toolbox: Toolbox,
  options: ServeMcpOptions = {},
): Promise<McpServer> {
  const { dir, socketPath } = await socketLocation(options.tempRoot ?? tmpdir())
  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => socket.destroy())
    void serveConnection(toolbox, socket)
  })
  try {
    await listen(server, socketPath)
  } catch (error) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    throw error
  }
  return {
    launch: {
      command: options.execPath ?? process.execPath,
      args: [
        ...(options.execArgv ?? process.execArgv),
        fileURLToPath(new URL('./mcp-bridge.js', import.meta.url)),
        socketPath,
      ],
    },
    close: async () => {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    },
  }
}

async function serveConnection(toolbox: Toolbox, socket: Socket): Promise<void> {
  try {
    for await (const line of createInterface({ input: socket, crlfDelay: Infinity })) {
      if (line.trim() === '') continue
      const response = await handleMcpMessage(toolbox, line)
      if (response !== undefined && socket.writable) socket.write(`${response}\n`)
    }
  } catch {
    socket.destroy()
  }
}

async function socketLocation(
  tempRoot: string,
): Promise<{ dir: string | undefined; socketPath: string }> {
  if (process.platform === 'win32') {
    return {
      dir: undefined,
      socketPath: `\\\\.\\pipe\\phada-mcp-${randomBytes(8).toString('hex')}`,
    }
  }
  let dir = await mkdtemp(join(tempRoot, 'phada-mcp-'))
  if (join(dir, 's').length > MAX_SOCKET_PATH) {
    await rm(dir, { recursive: true, force: true })
    dir = await mkdtemp(join(SHORT_TEMP_ROOT, 'phada-mcp-'))
  }
  return { dir, socketPath: join(dir, 's') }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function reply(id: JsonRpcId, body: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, ...body })
}
