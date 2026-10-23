import { ConfigError } from './errors.js'
import type { McpEntry, McpObject } from './schema.js'
import type { ConfigLayer } from './types.js'

export interface McpNameEntry {
  name: string
  tools?: string[]
  description?: string
}

export type McpTransport =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; url: string; headers: Record<string, string> }

export interface DeclaredMcpServer {
  name: string
  transport: McpTransport
  tools?: string[]
  description?: string
  secrets?: string[]
}

export interface ResolvedMcp {
  names: McpNameEntry[]
  declared: DeclaredMcpServer[]
}

export const NO_MCP: ResolvedMcp = { names: [], declared: [] }

const VARIABLE_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const MIN_SECRET_LENGTH = 4

export function userMcp(userLayers: readonly ConfigLayer[]): McpEntry[] {
  const entries = (['user-repo', 'user'] as const).flatMap((kind) =>
    userLayers.filter((layer) => layer.kind === kind).flatMap((layer) => layer.config.mcp ?? []),
  )
  const byName = new Map<string, McpEntry>()
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name
    if (!byName.has(name)) byName.set(name, entry)
  }
  return [...byName.values()]
}

export function resolveMcp(entries: readonly McpEntry[], env: NodeJS.ProcessEnv): ResolvedMcp {
  const resolved: ResolvedMcp = { names: [], declared: [] }
  for (const entry of entries) {
    if (typeof entry === 'string') resolved.names.push({ name: entry })
    else if (entry.command === undefined && entry.url === undefined) {
      resolved.names.push(optionsOf(entry, { name: entry.name }))
    } else resolved.declared.push(declaredServer(entry, env))
  }
  return resolved
}

function declaredServer(entry: McpObject, env: NodeJS.ProcessEnv): DeclaredMcpServer {
  const secrets = new Set<string>()
  const expand = (text: string) =>
    text.replace(VARIABLE_REFERENCE, (_match, name: string) => {
      const value = env[name]
      if (value === undefined || value === '') {
        throw new ConfigError(`mcp server ${entry.name}: ${name} is not set.`)
      }
      if (value.length >= MIN_SECRET_LENGTH) secrets.add(value)
      return value
    })
  const expandAll = (record: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, expand(value)]))
  const transport: McpTransport =
    entry.command !== undefined
      ? {
          kind: 'stdio',
          command: expand(entry.command),
          args: (entry.args ?? []).map(expand),
          env: expandAll(entry.env),
        }
      : { kind: 'http', url: expand(entry.url ?? ''), headers: expandAll(entry.headers) }
  return optionsOf(entry, {
    name: entry.name,
    transport,
    ...(secrets.size === 0 ? {} : { secrets: [...secrets] }),
  })
}

function optionsOf<T extends object>(entry: McpObject, base: T): T & McpNameEntry {
  return {
    ...base,
    name: entry.name,
    ...(entry.tools === undefined ? {} : { tools: entry.tools }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  }
}
