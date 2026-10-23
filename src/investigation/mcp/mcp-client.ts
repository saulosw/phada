import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { DeclaredMcpServer } from '../../config/mcp-servers.js'
import type { JsonSchema } from '../../providers/types.js'
import { redactSecrets } from '../../providers/redact-secrets.js'
import type { ToolResult } from '../toolbox.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const CLOSE_GRACE_MS = 2_000
const STDERR_KEPT_BYTES = 2_048
const MAX_TOOL_PAGES = 20
const METHOD_NOT_FOUND = -32601

export interface McpTool {
  name: string
  description: string
  inputSchema: JsonSchema
  readOnly: boolean
}

export interface McpConnection {
  readonly name: string
  readonly tools: readonly McpTool[]
  readonly pid?: number
  call(tool: string, args: unknown): Promise<ToolResult>
  close(): Promise<void>
}

export interface ConnectMcpOptions {
  env: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  connectTimeoutMs?: number
  callTimeoutMs?: number
  clientVersion?: string
}

export class McpConnectError extends Error {
  override readonly name = 'McpConnectError'
  readonly server: string

  constructor(server: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.server = server
  }
}

class StoppedError extends Error {}
class TimeoutError extends Error {}
class RpcError extends Error {}
class HttpStatusError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}
class SessionExpiredError extends Error {}

interface Transport {
  readonly pid?: number
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
}

const ToolList = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
      annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional(),
    }),
  ),
  nextCursor: z.string().optional(),
})

const CallResult = z.object({
  content: z.array(z.record(z.string(), z.unknown())).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
})

const JsonRpcMessage = z.object({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
})
type JsonRpcMessage = z.infer<typeof JsonRpcMessage>

export async function connectMcp(
  server: DeclaredMcpServer,
  options: ConnectMcpOptions,
): Promise<McpConnection> {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const initialize = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'phada', version: options.clientVersion ?? '1' },
  }
  const transport =
    server.transport.kind === 'stdio'
      ? openStdio(server.transport, options.env)
      : openHttp(server.transport, options.fetch ?? globalThis.fetch, initialize)
  const deadline = performance.now() + connectTimeoutMs
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()))
  let tools: McpTool[]
  try {
    await transport.request('initialize', initialize, remaining())
    await transport.notify('notifications/initialized')
    tools = await listTools(transport, remaining)
  } catch (error) {
    await transport.close()
    throw new McpConnectError(server.name, connectFailure(server, error, connectTimeoutMs), {
      cause: error,
    })
  }
  return {
    name: server.name,
    tools,
    ...(transport.pid === undefined ? {} : { pid: transport.pid }),
    call: async (tool, args) => {
      try {
        const result = CallResult.parse(
          await transport.request('tools/call', { name: tool, arguments: args }, callTimeoutMs),
        )
        return { text: resultText(result), isError: result.isError === true }
      } catch (error) {
        return { text: callFailure(server.name, error, callTimeoutMs), isError: true }
      }
    },
    close: () => transport.close(),
  }
}

async function listTools(transport: Transport, remaining: () => number): Promise<McpTool[]> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const list = ToolList.parse(
      await transport.request('tools/list', cursor === undefined ? {} : { cursor }, remaining()),
    )
    for (const tool of list.tools) {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object' },
        readOnly: tool.annotations?.readOnlyHint === true,
      })
    }
    cursor = list.nextCursor
    if (cursor === undefined) break
  }
  return tools
}

function resultText(result: z.infer<typeof CallResult>): string {
  if (result.content === undefined || result.content.length === 0) {
    return result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent)
  }
  return result.content.map(contentText).join('\n')
}

function contentText(item: Record<string, unknown>): string {
  const type = typeof item.type === 'string' ? item.type : 'content'
  if (type === 'text' && typeof item.text === 'string') return item.text
  if (type === 'resource' && typeof item.resource === 'object' && item.resource !== null) {
    const resource = item.resource as Record<string, unknown>
    if (typeof resource.text === 'string') return resource.text
    return `[resource ${String(resource.uri ?? '')} omitted]`
  }
  if (type === 'resource_link') return `[link ${String(item.uri ?? '')}]`
  return `[${type} omitted]`
}

function seconds(ms: number): string {
  return `${ms / 1000}s`
}

function connectFailure(server: DeclaredMcpServer, error: unknown, timeoutMs: number): string {
  const name = server.name
  if (error instanceof TimeoutError)
    return `MCP server ${name} did not answer within ${seconds(timeoutMs)}.`
  if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
    return `MCP server ${name} refused the credentials (HTTP ${error.status}).`
  }
  if (error instanceof StoppedError) return `MCP server ${name} could not start: ${error.message}`
  if (error instanceof z.ZodError) return `MCP server ${name} sent an unexpected answer.`
  const detail = error instanceof Error ? error.message : String(error)
  return `MCP server ${name} is not reachable: ${redactSecrets(detail)}`
}

function callFailure(name: string, error: unknown, timeoutMs: number): string {
  if (error instanceof TimeoutError)
    return `MCP server ${name} did not answer within ${seconds(timeoutMs)}.`
  if (error instanceof StoppedError) return `MCP server ${name} stopped.`
  if (error instanceof RpcError) return `MCP server ${name}: ${redactSecrets(error.message)}`
  if (error instanceof HttpStatusError) return `MCP server ${name} answered ${error.message}.`
  if (error instanceof z.ZodError) return `MCP server ${name} sent an unexpected answer.`
  return `MCP server ${name} failed.`
}

interface Pending {
  resolve(result: unknown): void
  reject(error: Error): void
}

function openStdio(
  transport: Extract<DeclaredMcpServer['transport'], { kind: 'stdio' }>,
  baseEnv: NodeJS.ProcessEnv,
): Transport {
  const child: ChildProcessWithoutNullStreams = spawn(transport.command, transport.args, {
    env: { ...baseEnv, ...transport.env },
    stdio: 'pipe',
  })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let stderr = ''
  let stopped: StoppedError | undefined
  const exited = new Promise<void>((resolve) => {
    const stop = (error: StoppedError) => {
      stopped ??= error
      for (const request of pending.values()) request.reject(stopped)
      pending.clear()
      resolve()
    }
    child.once('error', (error: NodeJS.ErrnoException) =>
      stop(
        new StoppedError(
          error.code === 'ENOENT' ? `${transport.command} was not found.` : error.message,
        ),
      ),
    )
    child.once('exit', (code) => {
      const tail = redactSecrets(stderr.trim().split('\n').slice(-3).join(' '))
      stop(
        new StoppedError(`it exited with code ${code ?? 'null'}${tail === '' ? '.' : `: ${tail}`}`),
      )
    })
  })
  child.stdin.on('error', () => undefined)
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEPT_BYTES)
  })
  const write = (message: Record<string, unknown>) => {
    if (child.stdin.writable)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  void (async () => {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const message = parseMessage(line)
      if (message === undefined) continue
      if (message.method !== undefined) {
        if (message.id === undefined || message.id === null) continue
        write(
          message.method === 'ping'
            ? { id: message.id, result: {} }
            : { id: message.id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } },
        )
        continue
      }
      if (typeof message.id !== 'number') continue
      const request = pending.get(message.id)
      if (request === undefined) continue
      pending.delete(message.id)
      if (message.error !== undefined)
        request.reject(new RpcError(message.error.message ?? 'error'))
      else request.resolve(message.result)
    }
  })()
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    request: (method, params, timeoutMs) => {
      if (stopped !== undefined) return Promise.reject(stopped)
      const id = nextId++
      return withTimeout(
        new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject })
          write({ id, method, params })
        }),
        timeoutMs,
        () => pending.delete(id),
      )
    },
    notify: async (method, params) => write(params === undefined ? { method } : { method, params }),
    close: async () => {
      if (stopped !== undefined) return
      child.stdin.end()
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_GRACE_MS)
      await exited
      clearTimeout(timer)
    },
  }
}

function openHttp(
  transport: Extract<DeclaredMcpServer['transport'], { kind: 'http' }>,
  fetch: typeof globalThis.fetch,
  initialize: unknown,
): Transport {
  let sessionId: string | undefined
  let initialized = false
  let nextId = 1
  const headers = () => ({
    ...transport.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId === undefined ? {} : { 'Mcp-Session-Id': sessionId }),
    ...(initialized ? { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION } : {}),
  })
  const post = async (message: Record<string, unknown>, timeoutMs: number): Promise<Response> => {
    let response: Response
    try {
      response = await fetch(transport.url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new TimeoutError()
      throw error
    }
    if (response.status === 404 && sessionId !== undefined) throw new SessionExpiredError()
    if (!response.ok) throw new HttpStatusError(response.status)
    return response
  }
  const send = async (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const id = nextId++
    const response = await post({ id, method, params }, timeoutMs)
    if (method === 'initialize') sessionId = response.headers.get('mcp-session-id') ?? undefined
    const message = await answerOf(response, id)
    if (message.error !== undefined) throw new RpcError(message.error.message ?? 'error')
    return message.result
  }
  const notify = async (method: string, params?: unknown) => {
    const response = await post(
      params === undefined ? { method } : { method, params },
      DEFAULT_CALL_TIMEOUT_MS,
    )
    await response.body?.cancel()
    if (method === 'notifications/initialized') initialized = true
  }
  return {
    request: async (method, params, timeoutMs) => {
      try {
        return await send(method, params, timeoutMs)
      } catch (error) {
        if (!(error instanceof SessionExpiredError)) throw error
        sessionId = undefined
        initialized = false
        await send('initialize', initialize, timeoutMs)
        await notify('notifications/initialized')
        return send(method, params, timeoutMs)
      }
    },
    notify,
    close: async () => {
      if (sessionId === undefined) return
      try {
        const response = await fetch(transport.url, {
          method: 'DELETE',
          headers: headers(),
          signal: AbortSignal.timeout(CLOSE_GRACE_MS),
        })
        await response.body?.cancel()
      } catch {
        return
      }
    },
  }
}

async function answerOf(response: Response, id: number): Promise<JsonRpcMessage> {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream')) {
    const body: unknown = JSON.parse(await response.text())
    const messages = Array.isArray(body) ? body : [body]
    const found = messages.map(parseValue).find((message) => message?.id === id)
    if (found === undefined) throw new RpcError('no answer to the request')
    return found
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new RpcError('no answer to the request')
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    buffer += done ? '\n\n' : decoder.decode(value, { stream: true })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      const message = parseMessage(data)
      if (message?.id === id && message.method === undefined) {
        await reader.cancel()
        return message
      }
    }
    if (done) throw new RpcError('no answer to the request')
  }
}

function parseMessage(line: string): JsonRpcMessage | undefined {
  try {
    return parseValue(JSON.parse(line))
  } catch {
    return undefined
  }
}

function parseValue(value: unknown): JsonRpcMessage | undefined {
  const parsed = JsonRpcMessage.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new TimeoutError())
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
