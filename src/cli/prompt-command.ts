import { defaultPromptView, inspectPrompt } from '../app/inspect-prompt.js'
import type { PromptView } from '../app/inspect-prompt.js'
import { readCi } from '../app/read-ci.js'
import { readConversation } from '../app/read-conversation.js'
import { loadReplay, replayCut, replayWarning } from '../app/replay.js'
import type { Replay } from '../app/replay.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { resolveProvider } from '../config/merge-config.js'
import type { ConfigLayer } from '../config/types.js'
import { loadUserLayers } from '../config/user-config.js'
import { loadContext } from '../context/load-context.js'
import type { ContextSources } from '../context/types.js'
import type {
  FetchReviewStateOptions,
  PullComment,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequest } from '../github/pull-request.js'
import type { CliCommand } from './args.js'
import { contextSourcesAt } from './context-sources.js'
import type { ContextReaders } from './context-sources.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { formatPromptJson, formatPromptText } from './format-prompt.js'
import type { TextOutput } from './progress.js'
import { providerRunsSkills } from './provider-choice.js'
import { ciReaders, replayReaders } from './review-wiring.js'
import type { CiReaderDeps, PublishTarget, ReplayReaderDeps } from './review-wiring.js'
import { diskSkillCatalog } from './skill-catalog.js'

export type PromptCommand = Extract<CliCommand, { kind: 'prompt' }>

export interface PromptReaderDeps extends ContextReaders, CiReaderDeps, GitHubTokenDeps {
  files: LocalFileSystem
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  fetchPullComments: (options: FetchReviewStateOptions) => Promise<PullComment[]>
}

export interface PromptCommandDeps extends PromptReaderDeps, ReplayReaderDeps {
  stdout: TextOutput
}

export async function runPrompt(command: PromptCommand, deps: PromptCommandDeps): Promise<void> {
  const format = command.format === 'json' ? formatPromptJson : formatPromptText
  if (command.target.kind === 'default') {
    deps.stdout.write(format(defaultPromptView()))
    return
  }
  const token = await requireGitHubToken(deps, 'read the pull request and the repository contents')
  const { ref, head } = command.target
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner: ref.owner,
    repo: ref.repo,
    files: deps.files,
  })
  const replay =
    head === undefined ? undefined : await loadReplay(ref, head, replayReaders(deps, token))
  const pullRequest = replay?.pullRequest ?? (await deps.fetchPullRequest({ ...ref, token }))
  const view = await pullRequestPrompt(deps, {
    target: { ...ref, token },
    userLayers,
    pullRequest,
    ...(command.skills === undefined ? {} : { skills: command.skills }),
    ...(replay === undefined ? {} : { replay }),
  })
  deps.stdout.write(format(view))
}

export async function pullRequestPrompt(
  deps: PromptReaderDeps,
  input: {
    target: PublishTarget
    userLayers: readonly ConfigLayer[]
    pullRequest: PullRequest
    skills?: readonly string[]
    sources?: ContextSources
    replay?: Replay
  },
): Promise<PromptView> {
  const { target, userLayers, pullRequest, replay } = input
  const sources =
    input.sources ??
    contextSourcesAt(
      deps,
      { owner: target.owner, repo: target.repo, token: target.token },
      pullRequest.baseSha,
    )
  const loaded = await loadContext({
    diff: pullRequest.diff,
    baseSha: pullRequest.baseSha,
    userLayers,
    sources,
  })
  const cutWarning = replay === undefined ? undefined : replayWarning(replay)
  const warnings: string[] = cutWarning === undefined ? [] : [cutWarning]
  const warn = (message: string) => warnings.push(message)
  const cut = replayCut(replay)
  const conversation =
    (loaded.options.conversation ?? true)
      ? await readConversation(
          cut.state(await deps.fetchReviewState(target)),
          pullRequest.author,
          async () => cut.comments(await deps.fetchPullComments(target)),
          warn,
        )
      : undefined
  const readers = cut.ci(ciReaders(deps, target))
  const ci = loaded.options.ci.read
    ? await readCi(readers, pullRequest.headSha, loaded.options.ci.checks, warn)
    : undefined
  return inspectPrompt({
    pullRequest,
    loaded,
    ...(conversation === undefined ? {} : { conversation }),
    ...(ci === undefined ? {} : { ci }),
    warnings,
    ...(input.skills === undefined ? {} : { cliSkills: input.skills }),
    investigate: loaded.options.investigate ?? true,
    native: providerRunsSkills(resolveProvider({}, userLayers).provider),
    skills: diskSkillCatalog(deps.files, deps.env, deps.home),
    readRepoFile: (path) => sources.readRepoFile(path),
    readLocalFile: (path) => sources.readLocalFile(path),
  })
}
