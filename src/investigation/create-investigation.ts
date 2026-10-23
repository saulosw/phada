import type { RepositoryGraph } from '../graph/types.js'
import type { Checkout } from '../repository/checkout.js'
import type { McpServerInfo, Toolbox } from './toolbox.js'
import { graphTools } from './tools/graph-tools.js'
import { historyTool } from './tools/history-tool.js'
import type { RelatedCheckout } from './tools/related-repo.js'
import { repositoryTools } from './tools/repository-tools.js'
import { ToolLog } from './tools/tool-log.js'
import type { ReviewPass } from './tools/tool-log.js'
import { createToolbox } from './tools/tool-registry.js'
import type { RegisteredTool } from './tools/tool-registry.js'

export interface Investigation {
  readonly log: ToolLog
  tools(pass: ReviewPass): Toolbox
  close(): Promise<void>
}

export type { RelatedCheckout } from './tools/related-repo.js'

export interface InvestigationOptions {
  graph?: RepositoryGraph
  related?: readonly RelatedCheckout[]
  mcp?: InvestigationMcp
}

export interface InvestigationMcp {
  tools: RegisteredTool<unknown>[]
  servers: McpServerInfo[]
  close(): Promise<void>
}

export function createInvestigation(
  checkout: Checkout,
  options: InvestigationOptions = {},
): Investigation {
  const log = new ToolLog()
  const related = options.related ?? []
  const tools = [
    ...repositoryTools(checkout, related),
    historyTool(checkout),
    ...(options.graph === undefined ? [] : graphTools(options.graph, { related })),
    ...(options.mcp?.tools ?? []),
  ]
  return {
    log,
    tools: (pass) => createToolbox(tools, log, pass, undefined, options.mcp?.servers),
    close: async () => {
      try {
        await options.mcp?.close()
      } finally {
        await checkout.close()
      }
    },
  }
}
