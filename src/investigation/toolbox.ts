import type { JsonSchema } from '../providers/types.js'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  server?: string
}

export interface ToolResult {
  text: string
  isError: boolean
}

export interface ToolCallOptions {
  maxBytes?: number
}

export interface McpServerInfo {
  name: string
  description?: string
  prefix?: string
}

export interface Toolbox {
  readonly definitions: readonly ToolDefinition[]
  readonly mcpServers?: readonly McpServerInfo[]
  call(name: string, args: unknown, options?: ToolCallOptions): Promise<ToolResult>
  touchedPaths(): readonly string[]
}
