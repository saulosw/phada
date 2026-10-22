import { join } from 'node:path'
import type { ReviewSettings } from '../config/merge-config.js'
import { serveGhFacade } from '../gh-facade/gh-server.js'
import type { GhFacade } from '../gh-facade/gh-server.js'
import type { ReadGitHub } from '../gh-facade/types.js'
import type { PullRequest } from '../github/pull-request.js'
import type { Toolbox } from '../investigation/toolbox.js'
import { closeWorkDir, openWorkDir, sweepOrphanWorkDirs } from '../process/work-dirs.js'
import type { CommandPolicy, NativeSkillRef, ReviewProvider } from '../providers/types.js'
import type { GitMirror } from '../repository/git-mirror.js'
import { materializeWorkTree } from '../repository/work-tree.js'
import type { WorkTree } from '../repository/work-tree.js'
import { nativeSkillContext } from '../review/native-context.js'
import type { NativeSkillRun, SkillPass } from '../review/types.js'
import { TRUSTED_ASSOCIATIONS } from '../watch/filters.js'

export const NATIVE_TIMEOUT_MS = 1_800_000
export const NATIVE_MAX_TURNS = 100

export interface NativeRunnerInput {
  pullRequest: PullRequest
  diff: string
  review: ReviewSettings
  nativeSkills: ReadonlyMap<string, NativeSkillRef>
  viewer: string
  language?: string
}

export interface NativeRunnerDeps {
  mirror: GitMirror
  provider: ReviewProvider
  env: NodeJS.ProcessEnv
  readGitHub: ReadGitHub
  resolveDir(path: string): Promise<string | undefined>
  tools?: () => Toolbox | undefined
  warning(message: string): void
  tempRoot?: string
  ghExecArgv?: readonly string[]
}

export interface NativeRunner {
  runSkill(pass: SkillPass): Promise<NativeSkillRun>
  close(): Promise<void>
}

export async function openNativeRunner(
  input: NativeRunnerInput,
  deps: NativeRunnerDeps,
): Promise<NativeRunner> {
  const { pullRequest, review } = input
  await sweepOrphanWorkDirs(deps.tempRoot)
  const dir = await openWorkDir(deps.tempRoot)
  let facade: GhFacade | undefined
  let tree: WorkTree
  try {
    tree = await materializeWorkTree(
      deps.mirror,
      {
        dir: join(dir, 'repo'),
        headSha: pullRequest.headSha,
        baseSha: pullRequest.baseSha,
        baseRef: pullRequest.baseRef,
        headRef: pullRequest.headRef,
        number: pullRequest.number,
        commits: pullRequest.stats.commits,
        diff: input.diff,
      },
      { env: deps.env },
    )
    for (const warning of tree.warnings) deps.warning(warning)
    facade = await serveGhFacade({
      data: {
        repo: pullRequest.repo,
        number: pullRequest.number,
        url: pullRequest.url,
        title: pullRequest.title,
        body: pullRequest.description,
        author: pullRequest.author,
        baseRef: pullRequest.baseRef,
        headRef: pullRequest.headRef,
        mergeBase: tree.mergeBase,
        headSha: pullRequest.headSha,
        diff: input.diff,
        viewer: input.viewer,
      },
      readGitHub: deps.readGitHub,
      tempRoot: dir,
      ...(deps.ghExecArgv === undefined ? {} : { execArgv: deps.ghExecArgv }),
    })
  } catch (error) {
    await facade?.close()
    await closeWorkDir(dir)
    throw error
  }
  const policy = await commandPolicy(input, deps)
  const gh = facade
  const workTree = tree
  let seen = 0
  return {
    runSkill: async (pass) => {
      const skill = input.nativeSkills.get(pass.skill)
      if (skill === undefined) throw new Error(`Skill ${pass.skill} has no native reference.`)
      if (deps.provider.runSkill === undefined) {
        throw new Error(`${deps.provider.id} cannot run skills natively.`)
      }
      const tools = deps.tools?.()
      const output = await deps.provider.runSkill({
        skill,
        arguments: pullRequest.url,
        context: nativeSkillContext({
          pullRequest,
          baseRef: pullRequest.baseRef,
          mergeBase: workTree.mergeBase,
          diffFile: workTree.diffFile,
          ...(input.language === undefined ? {} : { language: input.language }),
        }),
        cwd: workTree.dir,
        readDirs: policy.readDirs,
        commands: policy.commands,
        env: {
          ...gh.env,
          PATH: [gh.binDir, deps.env.PATH ?? ''].filter(Boolean).join(':'),
          GIT_TERMINAL_PROMPT: '0',
        },
        ...(tools === undefined ? {} : { tools }),
        timeoutMs: review.timeoutMs ?? NATIVE_TIMEOUT_MS,
        maxTurns: NATIVE_MAX_TURNS,
      })
      const captured = gh.captured().slice(seen)
      seen += captured.length
      return { ...output, captured }
    },
    close: async () => {
      await gh.close()
      await closeWorkDir(dir)
    },
  }
}

export interface SkillPolicy {
  commands: CommandPolicy
  readDirs: string[]
  narrowed: boolean
}

export function skillPolicy(
  pullRequest: Pick<PullRequest, 'private' | 'association'>,
  review: ReviewSettings,
): SkillPolicy {
  const asked = review.commands?.policy ?? 'read-only'
  const dirs = review.readDirs?.dirs ?? []
  const outside = !pullRequest.private && !TRUSTED_ASSOCIATIONS.has(pullRequest.association)
  if (!outside) return { commands: asked, readDirs: [...dirs], narrowed: false }
  return {
    commands: 'read-only',
    readDirs: [],
    narrowed: asked !== 'read-only' || dirs.length > 0,
  }
}

async function commandPolicy(
  input: NativeRunnerInput,
  deps: NativeRunnerDeps,
): Promise<{ commands: CommandPolicy; readDirs: string[] }> {
  const { pullRequest, review } = input
  const policy = skillPolicy(pullRequest, review)
  if (policy.narrowed) {
    deps.warning(
      `${pullRequest.repo}#${pullRequest.number} is from an outside author: the skill runs read-only.`,
    )
  }
  const readDirs: string[] = []
  for (const dir of policy.readDirs) {
    const resolved = await deps.resolveDir(dir)
    if (resolved === undefined) deps.warning(`review.readDirs: ${dir} does not exist; ignored.`)
    else readDirs.push(resolved)
  }
  return { commands: policy.commands, readDirs }
}
