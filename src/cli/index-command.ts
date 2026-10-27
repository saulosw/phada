import { indexRepository } from '../app/index-repository.js'
import { repositoryCache } from '../config/cache-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadUserLayers } from '../config/user-config.js'
import type { Extractor } from '../repo-map/extract.js'
import type { GitMirror, GitMirrorOptions } from '../repository/git-mirror.js'
import type { IndexStore } from '../store/index-store.js'
import type { IndexFormat, RepositoryName } from './args.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { formatIndexJson, formatIndexText } from './format-index.js'
import { indexProgress } from './progress.js'
import type { TextOutput } from './progress.js'
import { toTerminalText } from '../app/terminal-text.js'

export interface IndexCommand {
  repo: RepositoryName
  ref?: string
  format: IndexFormat
}

export interface IndexCommandDeps extends GitHubTokenDeps {
  version: string
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  openMirror: (options: GitMirrorOptions) => Promise<GitMirror>
  openIndexStore: (path: string, version: string) => Promise<IndexStore>
  createExtractor: () => Extractor
  pathSize: (path: string) => Promise<number>
  now?: () => number
}

export async function runIndex(command: IndexCommand, deps: IndexCommandDeps): Promise<void> {
  const token = await requireGitHubToken(deps, 'read the repository contents')
  const { owner, repo } = command.repo
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner,
    repo,
    files: deps.files,
  })
  const paths = repositoryCache(deps.env, deps.home, owner, repo)
  const mirrorPath = paths.mirror
  deps.stderr.write(`Fetching ${owner}/${repo} (${command.ref ?? 'default branch'})…\n`)
  const mirror = await deps.openMirror({ dir: mirrorPath, owner, repo, token, env: deps.env })
  const report = await indexRepository(
    { owner, repo, ...(command.ref === undefined ? {} : { ref: command.ref }), userLayers },
    {
      mirror,
      openStore: () => deps.openIndexStore(paths.index, deps.version),
      extractor: deps.createExtractor(),
      now: deps.now ?? (() => performance.now()),
      events: indexProgress(deps.stderr),
    },
  )
  for (const warning of report.warnings) {
    deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
  }
  const [index, mirrorBytes] = await Promise.all([
    deps.pathSize(report.indexPath),
    deps.pathSize(mirrorPath),
  ])
  const sizes = { index, mirror: mirrorBytes, mirrorPath }
  deps.stdout.write(
    command.format === 'json'
      ? formatIndexJson(report, sizes)
      : formatIndexText(report, sizes, deps.home),
  )
}
