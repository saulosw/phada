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

export interface Toolbox {
  readonly definitions: readonly ToolDefinition[]
  call(name: string, args: unknown): Promise<ToolResult>
  touchedPaths(): readonly string[]
}
