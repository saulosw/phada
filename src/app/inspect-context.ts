import type { ConfigLayer } from '../config/types.js'
import { listContext } from '../context/list-context.js'
import type { ListedContext } from '../context/list-context.js'
import { loadContext } from '../context/load-context.js'
import type { ContextReport, ContextSources } from '../context/types.js'

export async function inspectPullRequestContext(input: {
  diff: string
  baseSha: string
  userLayers: readonly ConfigLayer[]
  sources: ContextSources
}): Promise<ContextReport> {
  return (await loadContext(input)).report
}

export function inspectRepositoryContext(input: {
  ref: string
  userLayers: readonly ConfigLayer[]
  sources: ContextSources
}): Promise<ListedContext> {
  return listContext(input)
}
