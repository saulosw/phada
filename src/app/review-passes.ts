import { ConfigError } from '../config/errors.js'
import type { ReviewPromptRef, ReviewSettings, SkillEntry } from '../config/merge-config.js'
import { matcher } from '../context/ignore.js'
import type { ReviewerLens, SkillPass } from '../review/types.js'
import { SkillError } from '../skills/errors.js'

export interface CatalogSkill {
  name: string
  origin: string
  text: string
  omitted: string[]
}

export interface SkillCatalog {
  find(name: string): Promise<CatalogSkill>
}

export interface PassPlan {
  skill: string
  origin: string
  status: 'planned' | 'skipped'
  reason?: string
  omitted?: string[]
}

export interface PlannedPasses {
  passes?: SkillPass[]
  plan: PassPlan[]
  warnings: string[]
}

export const BUILT_IN_SKILL = 'phada'

export async function buildPasses(input: {
  review?: ReviewSettings
  cliSkills?: readonly string[]
  changedFiles: readonly string[]
  readRepoFile(path: string): Promise<string | null>
  readLocalFile(path: string): Promise<string | null>
  skills: SkillCatalog
}): Promise<PlannedPasses> {
  const { review = {}, cliSkills } = input
  const listed =
    cliSkills !== undefined && cliSkills.length > 0
      ? {
          entries: cliSkills.map((name) => ({ name })),
          origin: '--skill',
          source: 'local' as const,
        }
      : review.skills !== undefined && review.skills.entries.length > 0
        ? review.skills
        : undefined
  if (listed === undefined && review.prompt === undefined) return { plan: [], warnings: [] }

  const warnings: string[] = []
  const entries = listed?.entries ?? [{ name: BUILT_IN_SKILL }]
  const phadaLens =
    review.prompt === undefined || !entries.some(({ name }) => name === BUILT_IN_SKILL)
      ? undefined
      : await promptLens(review.prompt, input)
  const planned: { pass: SkillPass; plan: PassPlan }[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      warnings.push(`${listed?.origin}: skill ${entry.name} is listed twice; ignored.`)
      continue
    }
    seen.add(entry.name)
    if (entry.name === BUILT_IN_SKILL) {
      const lens = phadaLens ?? { kind: 'default' }
      planned.push(
        withPaths(
          entry,
          lens,
          lens.kind === 'default' ? BUILT_IN_SKILL : lens.origin,
          input.changedFiles,
        ),
      )
      continue
    }
    let skill: CatalogSkill
    try {
      skill = await input.skills.find(entry.name)
    } catch (error) {
      if (!(error instanceof SkillError) || listed?.source === 'local') throw error
      warnings.push(`${listed?.origin}: ${error.message} Skipped.`)
      continue
    }
    if (skill.omitted.length > 0) {
      warnings.push(
        `Skill ${entry.name}: ${skill.omitted.join(', ')} did not fit in 32 KB and was left out.`,
      )
    }
    const next = withPaths(
      entry,
      { kind: 'skill', name: entry.name, text: skill.text, origin: skill.origin },
      skill.origin,
      input.changedFiles,
    )
    planned.push(
      skill.omitted.length === 0
        ? next
        : { ...next, plan: { ...next.plan, omitted: skill.omitted } },
    )
  }
  if (planned.length === 0) {
    const lens = phadaLens ??
      (review.prompt === undefined ? undefined : await promptLens(review.prompt, input)) ?? {
        kind: 'default',
      }
    planned.push(
      withPaths(
        { name: BUILT_IN_SKILL },
        lens,
        lens.kind === 'default' ? BUILT_IN_SKILL : lens.origin,
        [],
      ),
    )
  }
  return {
    passes: planned.map(({ pass }) => pass),
    plan: planned.map(({ plan }) => plan),
    warnings,
  }
}

async function promptLens(
  prompt: ReviewPromptRef,
  input: Pick<Parameters<typeof buildPasses>[0], 'readRepoFile' | 'readLocalFile'>,
): Promise<ReviewerLens> {
  const label = `${prompt.origin}: review.prompt.file ${prompt.file}`
  let text: string | null
  try {
    text =
      prompt.source === 'repository'
        ? await input.readRepoFile(prompt.file)
        : await input.readLocalFile(prompt.file)
  } catch (error) {
    throw new ConfigError(`${label} could not be read: ${messageOf(error)}`)
  }
  if (text === null) throw new ConfigError(`${label} does not exist.`)
  if (text.trim() === '') throw new ConfigError(`${label} is empty.`)
  return { kind: prompt.mode, text: text.trim(), origin: `${prompt.origin} → ${prompt.file}` }
}

function withPaths(
  entry: SkillEntry,
  lens: ReviewerLens,
  origin: string,
  changedFiles: readonly string[],
): { pass: SkillPass; plan: PassPlan } {
  const paths = entry.paths
  const skip =
    paths === undefined || paths.length === 0 || changedFiles.some(matcher(paths))
      ? undefined
      : `no changed file matches ${paths.join(', ')}`
  return {
    pass: {
      skill: entry.name,
      lens,
      ...(paths === undefined ? {} : { paths }),
      ...(skip === undefined ? {} : { skip }),
    },
    plan: {
      skill: entry.name,
      origin,
      status: skip === undefined ? 'planned' : 'skipped',
      ...(skip === undefined ? {} : { reason: skip }),
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
