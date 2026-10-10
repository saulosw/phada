import type { JsonSchema } from '../providers/types.js'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
}

export interface ToolResult {
  text: string
  isError: boolean
}

export interface ToolCallOptions {
  maxBytes?: number
}

export interface Toolbox {
  readonly definitions: readonly ToolDefinition[]
  call(name: string, args: unknown, options?: ToolCallOptions): Promise<ToolResult>
  touchedPaths(): readonly string[]
}
