import type { EffectiveConfig } from '../config/merge-config.js'
import { parseConfigText } from '../config/parse-config.js'
import type { ConfigLayer } from '../config/types.js'
import { mergeLayers } from '../context/load-context.js'
import { phadaFiles } from '../context/phada-paths.js'
import type { ContextReaders } from './context-sources.js'

export async function effectiveConfigAt(
  deps: Pick<ContextReaders, 'fetchRepositoryFile'>,
  repository: { owner: string; repo: string; token: string },
  sha: string,
  userLayers: readonly ConfigLayer[],
): Promise<EffectiveConfig> {
  const { config } = phadaFiles('')
  const text = await deps.fetchRepositoryFile({ ...repository, path: config, ref: sha })
  const parsed = text === null ? undefined : parseConfigText(text)
  const repositoryLayers: ConfigLayer[] =
    parsed?.ok === true
      ? [{ kind: 'repo-root', dir: '', configLabel: config, config: parsed.config }]
      : []
  return mergeLayers(userLayers, repositoryLayers)
}
