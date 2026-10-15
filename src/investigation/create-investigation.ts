import type { RepositoryGraph } from '../graph/types.js'
import type { Checkout } from '../repository/checkout.js'
import type { Toolbox } from './toolbox.js'
import { graphTools } from './tools/graph-tools.js'
import { historyTool } from './tools/history-tool.js'
import { repositoryTools } from './tools/repository-tools.js'
import { ToolLog } from './tools/tool-log.js'
import type { ReviewPass } from './tools/tool-log.js'
import { createToolbox } from './tools/tool-registry.js'

export interface Investigation {
  readonly log: ToolLog
  tools(pass: ReviewPass): Toolbox
  close(): Promise<void>
}

export interface InvestigationOptions {
  graph?: RepositoryGraph
}

export function createInvestigation(
  checkout: Checkout,
  options: InvestigationOptions = {},
): Investigation {
  const log = new ToolLog()
  const tools = [
    ...repositoryTools(checkout),
    historyTool(checkout),
    ...(options.graph === undefined ? [] : graphTools(options.graph)),
  ]
  return {
    log,
    tools: (pass) => createToolbox(tools, log, pass),
    close: () => checkout.close(),
  }
}
