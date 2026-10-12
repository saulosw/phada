import type { Toolbox } from './toolbox.js'
import type { Checkout } from '../repository/checkout.js'
import type { OpenCheckoutOptions } from '../repository/checkout.js'
import { repositoryTools } from './tools/repository-tools.js'
import { ToolLog } from './tools/tool-log.js'
import type { ReviewPass } from './tools/tool-log.js'
import { createToolbox } from './tools/tool-registry.js'

export interface Investigation {
  readonly log: ToolLog
  tools(pass: ReviewPass): Toolbox
  close(): Promise<void>
}

export type InvestigationCheckoutOptions = Omit<OpenCheckoutOptions, 'dir'>

export async function openInvestigation(
  options: InvestigationCheckoutOptions,
  openCheckout: (options: InvestigationCheckoutOptions) => Promise<Checkout>,
): Promise<Investigation> {
  const checkout = await openCheckout(options)
  const log = new ToolLog()
  const tools = repositoryTools(checkout)
  return {
    log,
    tools: (pass) => createToolbox(tools, log, pass),
    close: () => checkout.close(),
  }
}
