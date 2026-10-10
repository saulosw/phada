import type { Toolbox } from './toolbox.js'
import type { Checkout } from './checkout/checkout.js'
import type { OpenGitCheckoutOptions } from './checkout/git-checkout.js'
import { repositoryTools } from './tools/repository-tools.js'
import { ToolLog } from './tools/tool-log.js'
import type { ReviewPass } from './tools/tool-log.js'
import { createToolbox } from './tools/tool-registry.js'

export interface Investigation {
  readonly log: ToolLog
  tools(pass: ReviewPass): Toolbox
  close(): Promise<void>
}

export async function openInvestigation(
  options: OpenGitCheckoutOptions,
  openCheckout: (options: OpenGitCheckoutOptions) => Promise<Checkout>,
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
