#!/usr/bin/env node
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_MCP_MODE ?? 'ok'
const tools = [
  {
    name: 'get_ticket',
    description: 'Read a ticket.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search',
    description: 'Search tickets.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_ticket',
    description: 'Create a ticket.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  },
]

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
let pendingList

if (mode === 'noisy') process.stdout.write('Starting tickets server v1.2…\n')
if (mode === 'leak-and-exit') {
  process.stderr.write(`auth failed for token ${process.env.SECRET_TOKEN}\n`)
  process.exit(1)
}
process.stderr.write('server log line\n')

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim() === '') continue
  const message = JSON.parse(line)
  if (mode === 'silent') continue
  if (message.method === undefined) {
    if (pendingList !== undefined && message.id === 'server-ping') {
      send({ id: pendingList, result: { tools } })
      pendingList = undefined
    }
    continue
  }
  if (message.id === undefined) continue
  switch (message.method) {
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1' },
        },
      })
      break
    case 'tools/list':
      if (mode === 'paged' && message.params?.cursor === undefined) {
        send({ id: message.id, result: { tools: tools.slice(0, 1), nextCursor: 'page-2' } })
      } else if (mode === 'paged') {
        send({ id: message.id, result: { tools: tools.slice(1) } })
      } else if (mode === 'ping') {
        pendingList = message.id
        send({ id: 'server-ping', method: 'ping' })
      } else send({ id: message.id, result: { tools } })
      break
    case 'tools/call': {
      if (mode === 'crash-on-call') process.exit(3)
      if (mode === 'silent-calls') break
      const { name, arguments: args } = message.params
      if (mode === 'echo-github-token') {
        send({
          id: message.id,
          result: {
            content: [
              {
                type: 'text',
                text: `github: ${process.env.GITHUB_TOKEN ?? 'none'}/${process.env.GH_TOKEN ?? 'none'}`,
              },
            ],
          },
        })
      } else if (mode === 'echo-secret') {
        send({
          id: message.id,
          result: { content: [{ type: 'text', text: `token is ${process.env.SECRET_TOKEN}` }] },
        })
      } else if (mode === 'error-tool') {
        send({
          id: message.id,
          result: { content: [{ type: 'text', text: 'no such ticket' }], isError: true },
        })
      } else if (name === 'get_ticket') {
        send({
          id: message.id,
          result: {
            content: [
              { type: 'text', text: `TICKET ${args.id}: ${process.env.FAKE_FACT ?? 'no fact'}` },
              { type: 'resource', resource: { uri: 'tickets://1', text: 'resource body' } },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
        })
      } else send({ id: message.id, result: { content: [{ type: 'text', text: `${name} ok` }] } })
      break
    }
    default:
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
}
