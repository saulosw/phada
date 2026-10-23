import { z } from 'zod'
import type { DeclaredMcpServer } from '../../config/mcp-servers.js'
import type { McpConnection } from '../mcp/mcp-client.js'
import type { McpServerReport } from './report.js'
import { ToolFailure } from './tool-registry.js'
import type { RegisteredTool } from './tool-registry.js'

const EXPOSED_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface ConnectedMcp {
  server: DeclaredMcpServer
  connection: McpConnection
}

export interface McpTools {
  tools: RegisteredTool<unknown>[]
  reports: McpServerReport[]
  warnings: string[]
}

export function mcpTools(connected: readonly ConnectedMcp[]): McpTools {
  const result: McpTools = { tools: [], reports: [], warnings: [] }
  for (const { server, connection } of connected) {
    const available = new Set(connection.tools.map(({ name }) => name))
    for (const missing of (server.tools ?? []).filter((name) => !available.has(name))) {
      result.warnings.push(`MCP server ${server.name} has no tool ${missing}.`)
    }
    const offered = connection.tools.filter(
      (tool) =>
        (server.tools === undefined ? tool.readOnly : server.tools.includes(tool.name)) &&
        EXPOSED_NAME.test(`${server.name}__${tool.name}`),
    )
    if (server.tools === undefined && !connection.tools.some((tool) => tool.readOnly)) {
      result.warnings.push(
        `MCP server ${server.name} exposes no read-only tools; list the ones to allow in tools.`,
      )
    }
    for (const tool of offered) {
      result.tools.push({
        definition: {
          name: `${server.name}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
          server: server.name,
        },
        args: z.unknown(),
        run: async (args) => {
          const answer = await connection.call(tool.name, args ?? {})
          if (answer.isError) throw new ToolFailure('mcp-error', answer.text)
          return { text: answer.text, paths: [], touched: [] }
        },
      })
    }
    const names = new Set(offered.map(({ name }) => name))
    result.reports.push({
      server: server.name,
      via: 'phada',
      status: 'connected',
      tools: [...names],
      hidden: connection.tools.map(({ name }) => name).filter((name) => !names.has(name)),
    })
  }
  return result
}
