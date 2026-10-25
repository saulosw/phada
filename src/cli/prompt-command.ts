import { defaultPromptView, inspectPrompt } from '../app/inspect-prompt.js'
import { readCi } from '../app/read-ci.js'
import { readConversation } from '../app/read-conversation.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { resolveProvider } from '../config/merge-config.js'
import { loadUserLayers } from '../config/user-config.js'
import { loadContext } from '../context/load-context.js'
import type {
  FetchReviewStateOptions,
  PullComment,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequest } from '../github/pull-request.js'
import type { CliCommand } from './args.js'
import { contextSourcesAt } from './context-sources.js'
import type { ContextReaders } from './context-sources.js'
import { MissingGitHubTokenError } from './errors.js'
import { formatPromptJson, formatPromptText } from './format-prompt.js'
import type { TextOutput } from './progress.js'
import { providerRunsSkills } from './provider-choice.js'
import { ciReaders } from './review-wiring.js'
import type { CiReaderDeps } from './review-wiring.js'
import { diskSkillCatalog } from './skill-catalog.js'

export type PromptCommand = Extract<CliCommand, { kind: 'prompt' }>

export interface PromptCommandDeps extends ContextReaders, CiReaderDeps {
  env: NodeJS.ProcessEnv
  files: LocalFileSystem
  stdout: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  fetchPullComments: (options: FetchReviewStateOptions) => Promise<PullComment[]>
}

export async function runPrompt(command: PromptCommand, deps: PromptCommandDeps): Promise<void> {
  const format = command.format === 'json' ? formatPromptJson : formatPromptText
  if (command.target.kind === 'default') {
    deps.stdout.write(format(defaultPromptView()))
    return
  }
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError('read the pull request and the repository contents')
  const { ref } = command.target
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner: ref.owner,
    repo: ref.repo,
    files: deps.files,
  })
  const pullRequest = await deps.fetchPullRequest({ ...ref, token })
  const sources = contextSourcesAt(
    deps,
    { owner: ref.owner, repo: ref.repo, token },
    pullRequest.baseSha,
  )
  const loaded = await loadContext({
    diff: pullRequest.diff,
    baseSha: pullRequest.baseSha,
    userLayers,
    sources,
  })
  const warnings: string[] = []
  const warn = (message: string) => warnings.push(message)
  const target = { ...ref, token }
  const conversation =
    (loaded.options.conversation ?? true)
      ? await readConversation(
          await deps.fetchReviewState(target),
          pullRequest.author,
          () => deps.fetchPullComments(target),
          warn,
        )
      : undefined
  const ci =
    (loaded.options.ci?.read ?? true)
      ? await readCi(ciReaders(deps, target), pullRequest.headSha, loaded.options.ci?.checks, warn)
      : undefined
  const view = await inspectPrompt({
    pullRequest,
    loaded,
    ...(conversation === undefined ? {} : { conversation }),
    ...(ci === undefined ? {} : { ci }),
    warnings,
    ...(command.skills === undefined ? {} : { cliSkills: command.skills }),
    investigate: loaded.options.investigate ?? true,
    native: providerRunsSkills(resolveProvider({}, userLayers).provider),
    skills: diskSkillCatalog(deps.files, deps.env, deps.home),
    readRepoFile: (path) => sources.readRepoFile(path),
    readLocalFile: (path) => sources.readLocalFile(path),
  })
  deps.stdout.write(format(view))
}
