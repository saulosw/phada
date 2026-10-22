import type { LoadedContext } from '../context/types.js'
import { splitDiff } from '../context/split-diff.js'
import type { PullRequest } from '../github/pull-request.js'
import { reviewDataBlocks, reviewInstructionParts } from '../review/prompt.js'
import type { PromptPart } from '../review/prompt.js'
import type { SkillPass } from '../review/types.js'
import { BUILT_IN_SKILL, buildPasses } from './review-passes.js'
import type { PassPlan, SkillCatalog } from './review-passes.js'

export interface PromptPassView {
  skill: string
  origin: string
  status: 'planned' | 'skipped'
  reason?: string
  parts: PromptPart[]
  data: { name: string; bytes: number }[]
}

export interface PromptView {
  pullRequest: { repo: string; number: number; baseSha: string; headSha: string } | null
  passes: PromptPassView[]
  notes: string[]
  warnings: string[]
}

export const REVIEW_TOOL_NAMES = [
  'read_file',
  'grep',
  'list',
  'history',
  'find_symbol',
  'callers',
  'dependencies',
  'similar',
]

const TOOLS_NOTE = 'Tool sections are as a review sends them when the repository index is ready.'
const COMPUTED_NOTE =
  'The impact of the change and related repositories are computed during a review and are not shown here.'

export async function inspectPrompt(input: {
  pullRequest: PullRequest
  loaded: LoadedContext
  cliSkills?: readonly string[]
  investigate: boolean
  native?: boolean
  skills: SkillCatalog
  readRepoFile(path: string): Promise<string | null>
  readLocalFile(path: string): Promise<string | null>
}): Promise<PromptView> {
  const { pullRequest, loaded } = input
  const planned = await buildPasses({
    ...(loaded.options.review === undefined ? {} : { review: loaded.options.review }),
    ...(input.cliSkills === undefined ? {} : { cliSkills: input.cliSkills }),
    changedFiles: splitDiff(loaded.diff).sections.map((section) => section.path),
    readRepoFile: input.readRepoFile,
    readLocalFile: input.readLocalFile,
    skills: input.skills,
    native: input.native ?? false,
  })
  const request = { pullRequest: { ...pullRequest, diff: loaded.diff }, context: loaded.context }
  const data = reviewDataBlocks(request).map(({ name, content }) => ({
    name,
    bytes: new TextEncoder().encode(content).length,
  }))
  const options = {
    context: loaded.context,
    verify: loaded.options.verify ?? true,
    ...(loaded.options.language === undefined ? {} : { language: loaded.options.language }),
    ...(input.investigate ? { toolNames: REVIEW_TOOL_NAMES } : {}),
  }
  const passes = planned.passes ?? [{ skill: BUILT_IN_SKILL, lens: { kind: 'default' } }]
  const plans: PassPlan[] =
    planned.passes === undefined
      ? [{ skill: BUILT_IN_SKILL, origin: BUILT_IN_SKILL, status: 'planned', mode: 'text' }]
      : planned.plan
  return {
    pullRequest: {
      repo: pullRequest.repo,
      number: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    },
    passes: passes.map((pass, index) =>
      passView(
        pass,
        plans[index],
        pass.skip === undefined ? reviewInstructionParts(options, pass) : [],
        pass.skip === undefined ? data : [],
      ),
    ),
    notes: [...(input.investigate ? [TOOLS_NOTE] : []), COMPUTED_NOTE],
    warnings: [...loaded.report.warnings, ...planned.warnings],
  }
}

export function defaultPromptView(): PromptView {
  return {
    pullRequest: null,
    passes: [
      {
        skill: BUILT_IN_SKILL,
        origin: BUILT_IN_SKILL,
        status: 'planned',
        parts: reviewInstructionParts({ verify: true, toolNames: REVIEW_TOOL_NAMES }),
        data: [],
      },
    ],
    notes: [TOOLS_NOTE],
    warnings: [],
  }
}

function passView(
  pass: SkillPass,
  plan: PassPlan | undefined,
  parts: PromptPart[],
  data: PromptPassView['data'],
): PromptPassView {
  return {
    skill: pass.skill,
    origin: plan?.origin ?? BUILT_IN_SKILL,
    status: plan?.status ?? 'planned',
    ...(plan?.reason === undefined ? {} : { reason: plan.reason }),
    parts,
    data,
  }
}
