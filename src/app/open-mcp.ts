import type { DeclaredMcpServer, ResolvedMcp } from '../config/mcp-servers.js'
import type { PullRequest } from '../github/pull-request.js'
import type { InvestigationMcp } from '../investigation/create-investigation.js'
import { McpConnectError } from '../investigation/mcp/mcp-client.js'
import type { McpConnection } from '../investigation/mcp/mcp-client.js'
import type { McpServerInfo } from '../investigation/toolbox.js'
import { mcpTools } from '../investigation/tools/mcp-tools.js'
import type { ConnectedMcp } from '../investigation/tools/mcp-tools.js'
import type { McpServerReport } from '../investigation/tools/report.js'
import { TRUSTED_ASSOCIATIONS } from '../watch/filters.js'
import { errorMessage } from './error-message.js'

export type ConnectMcp = (server: DeclaredMcpServer) => Promise<McpConnection>

export interface OpenedMcp {
  investigation?: InvestigationMcp
  reports: McpServerReport[]
  readFrom: string[]
}

export function hasMcp(mcp: ResolvedMcp): boolean {
  return mcp.names.length > 0 || mcp.declared.length > 0
}

export function fromOutsideAuthor(
  pullRequest: Pick<PullRequest, 'private' | 'association'>,
): boolean {
  return !pullRequest.private && !TRUSTED_ASSOCIATIONS.has(pullRequest.association)
}

export function mcpOff(mcp: ResolvedMcp): McpServerReport[] {
  return [
    ...mcp.names.map(({ name }) => report(name, 'cli', 'off')),
    ...mcp.declared.map(({ name }) => report(name, 'phada', 'off')),
  ]
}

export async function openMcp(
  mcp: ResolvedMcp,
  connect: ConnectMcp,
  warning: (message: string) => void,
): Promise<OpenedMcp> {
  const settled = await Promise.allSettled(mcp.declared.map((server) => connect(server)))
  const connected: ConnectedMcp[] = []
  const failed = new Map<string, string>()
  settled.forEach((outcome, index) => {
    const server = mcp.declared[index]
    if (server === undefined) return
    if (outcome.status === 'fulfilled') {
      connected.push({ server, connection: outcome.value })
      return
    }
    const reason =
      outcome.reason instanceof McpConnectError
        ? outcome.reason.message
        : `MCP server ${server.name} is not available: ${errorMessage(outcome.reason)}.`
    failed.set(server.name, reason)
    warning(`${reason} Reviewing without it.`)
  })
  const offered = mcpTools(connected)
  for (const message of offered.warnings) warning(message)
  const reports = [
    ...mcp.names.map(({ name, tools }) => ({
      ...report(name, 'cli', 'connected'),
      tools: tools ?? [],
    })),
    ...mcp.declared.map(
      ({ name }) =>
        offered.reports.find((connectedReport) => connectedReport.server === name) ?? {
          ...report(name, 'phada', 'failed'),
          reason: failed.get(name) ?? '',
        },
    ),
  ]
  const servers: McpServerInfo[] = [
    ...mcp.names.map(({ name, description }) => info(name, description)),
    ...connected.map(({ server }) => ({
      ...info(server.name, server.description),
      prefix: `${server.name}__`,
    })),
  ]
  return {
    reports,
    readFrom: servers.map(({ name }) => name),
    ...(servers.length === 0
      ? {}
      : {
          investigation: {
            tools: offered.tools,
            servers,
            close: async () => {
              await Promise.allSettled(connected.map(({ connection }) => connection.close()))
            },
          },
        }),
  }
}

function info(name: string, description: string | undefined): McpServerInfo {
  return description === undefined ? { name } : { name, description }
}

function report(
  server: string,
  via: McpServerReport['via'],
  status: McpServerReport['status'],
): McpServerReport {
  return { server, via, status, tools: [], hidden: [] }
}
