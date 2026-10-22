import { describe, expect, it } from 'vitest'
import { ConfigError } from '../config/errors.js'
import type { ReviewSettings } from '../config/merge-config.js'
import { SkillError } from '../skills/errors.js'
import { buildPasses } from './review-passes.js'
import type { SkillCatalog } from './review-passes.js'

const catalog = (known: Record<string, string>, omitted: string[] = []): SkillCatalog => ({
  find: async (name) => {
    const text = known[name]
    if (text === undefined) throw new SkillError(`Skill "${name}" is not installed.`)
    return { name, origin: `/skills/${name}/SKILL.md`, text, omitted }
  },
})

function build(
  review: ReviewSettings | undefined,
  options: {
    cliSkills?: string[]
    changedFiles?: string[]
    repoFiles?: Record<string, string>
    localFiles?: Record<string, string>
    skills?: SkillCatalog
  } = {},
) {
  return buildPasses({
    ...(review === undefined ? {} : { review }),
    ...(options.cliSkills === undefined ? {} : { cliSkills: options.cliSkills }),
    changedFiles: options.changedFiles ?? ['src/shop.ts'],
    readRepoFile: async (path) => options.repoFiles?.[path] ?? null,
    readLocalFile: async (path) => options.localFiles?.[path] ?? null,
    skills: options.skills ?? catalog({ 'code-review': 'Find bugs.', sec: 'Auth.' }),
  })
}

const repoSkills = (...names: string[]): ReviewSettings => ({
  skills: {
    entries: names.map((name) => ({ name })),
    origin: '.phada/config.yml',
    source: 'repository',
  },
})

describe('buildPasses', () => {
  it('leaves the passes out without review settings', async () => {
    expect(await build(undefined)).toEqual({ plan: [], warnings: [] })
  })

  it('gives the phada pass the repository prompt in append mode', async () => {
    const planned = await build(
      {
        prompt: {
          file: '.phada/review.md',
          mode: 'append',
          origin: '.phada/config.yml',
          source: 'repository',
        },
      },
      { repoFiles: { '.phada/review.md': 'Flag missing tests.\n' } },
    )

    expect(planned.passes).toEqual([
      {
        skill: 'phada',
        lens: {
          kind: 'append',
          text: 'Flag missing tests.',
          origin: '.phada/config.yml → .phada/review.md',
        },
      },
    ])
    expect(planned.plan).toEqual([
      { skill: 'phada', origin: '.phada/config.yml → .phada/review.md', status: 'planned' },
    ])
  })

  it('reads a user prompt from the local disk', async () => {
    const planned = await build(
      {
        prompt: {
          file: '/cfg/review.md',
          mode: 'replace',
          origin: 'user:config.yml',
          source: 'local',
        },
      },
      { localFiles: { '/cfg/review.md': 'Only security.' } },
    )

    expect(planned.passes?.[0]?.lens).toEqual({
      kind: 'replace',
      text: 'Only security.',
      origin: 'user:config.yml → /cfg/review.md',
    })
  })

  it.each([
    ['missing', undefined, 'does not exist'],
    ['empty', '  \n', 'is empty'],
  ])('fails on a %s prompt file before the review', async (_case, text, message) => {
    const run = build(
      {
        prompt: {
          file: '.phada/review.md',
          mode: 'append',
          origin: '.phada/config.yml',
          source: 'repository',
        },
      },
      { repoFiles: text === undefined ? {} : { '.phada/review.md': text } },
    )

    await expect(run).rejects.toThrow(ConfigError)
    await expect(run).rejects.toThrow(
      `.phada/config.yml: review.prompt.file .phada/review.md ${message}.`,
    )
  })

  it('runs one pass per skill, with the skill text as the lens', async () => {
    const planned = await build(repoSkills('phada', 'code-review'))

    expect(planned.passes).toEqual([
      { skill: 'phada', lens: { kind: 'default' } },
      {
        skill: 'code-review',
        lens: {
          kind: 'skill',
          name: 'code-review',
          text: 'Find bugs.',
          origin: '/skills/code-review/SKILL.md',
        },
      },
    ])
  })

  it('lets --skill replace the configured skills', async () => {
    const planned = await build(repoSkills('phada'), { cliSkills: ['sec'] })

    expect(planned.passes?.map(({ skill }) => skill)).toEqual(['sec'])
    expect(planned.plan[0]?.origin).toBe('/skills/sec/SKILL.md')
  })

  it('fails before the review on a skill the user asked for and is not installed', async () => {
    await expect(build(undefined, { cliSkills: ['nope'] })).rejects.toThrow(SkillError)
    await expect(
      build({
        skills: { entries: [{ name: 'nope' }], origin: 'user:config.yml', source: 'local' },
      }),
    ).rejects.toThrow('Skill "nope" is not installed.')
  })

  it('skips a skill the repository asks for and is not installed, with a warning', async () => {
    const planned = await build(repoSkills('code-review', 'nope'))

    expect(planned.passes?.map(({ skill }) => skill)).toEqual(['code-review'])
    expect(planned.warnings).toEqual(['.phada/config.yml: Skill "nope" is not installed. Skipped.'])
  })

  it('falls back to phada when no skill of the repository is installed', async () => {
    const planned = await build(repoSkills('nope'))

    expect(planned.passes).toEqual([{ skill: 'phada', lens: { kind: 'default' } }])
  })

  it('treats an empty list of skills as no skills', async () => {
    expect(await build(repoSkills())).toEqual({ plan: [], warnings: [] })
  })

  it('runs a repeated skill once, with a warning', async () => {
    const planned = await build(repoSkills('code-review', 'code-review'))

    expect(planned.passes).toHaveLength(1)
    expect(planned.warnings).toEqual([
      '.phada/config.yml: skill code-review is listed twice; ignored.',
    ])
  })

  it('never looks phada up in the installed skills', async () => {
    const skills: SkillCatalog = {
      find: async () => {
        throw new Error('looked up')
      },
    }

    expect((await build(repoSkills('phada'), { skills })).passes).toHaveLength(1)
  })

  it('skips a pass whose paths match no changed file and names the paths', async () => {
    const planned = await build({
      skills: {
        entries: [{ name: 'phada' }, { name: 'sec', paths: ['src/auth/**'] }],
        origin: '.phada/config.yml',
        source: 'repository',
      },
    })

    expect(planned.passes?.[1]).toMatchObject({
      skill: 'sec',
      paths: ['src/auth/**'],
      skip: 'no changed file matches src/auth/**',
    })
    expect(planned.plan[1]).toMatchObject({
      status: 'skipped',
      reason: 'no changed file matches src/auth/**',
    })
  })

  it('keeps a pass whose paths match a changed file', async () => {
    const planned = await build({
      skills: {
        entries: [{ name: 'sec', paths: ['src/**'] }],
        origin: 'user:config.yml',
        source: 'local',
      },
    })

    expect(planned.passes?.[0]?.skip).toBeUndefined()
  })

  it('warns about the cited files that did not fit', async () => {
    const planned = await build(repoSkills('code-review'), {
      skills: catalog({ 'code-review': 'Find bugs.' }, ['big.md']),
    })

    expect(planned.warnings).toEqual([
      'Skill code-review: big.md did not fit in 32 KB and was left out.',
    ])
    expect(planned.plan[0]?.omitted).toEqual(['big.md'])
  })
})

describe('buildPasses without the phada pass', () => {
  it('never reads the review prompt when phada does not run', async () => {
    const planned = await build(
      {
        prompt: {
          file: '.phada/missing.md',
          mode: 'append',
          origin: '.phada/config.yml',
          source: 'repository',
        },
      },
      { cliSkills: ['sec'] },
    )

    expect(planned.passes?.map(({ skill }) => skill)).toEqual(['sec'])
  })
})

describe('buildPasses falling back to phada', () => {
  it('gives the fallback phada pass the review prompt', async () => {
    const planned = await build(
      {
        ...repoSkills('nope'),
        prompt: {
          file: '.phada/review.md',
          mode: 'append',
          origin: '.phada/config.yml',
          source: 'repository',
        },
      },
      { repoFiles: { '.phada/review.md': 'Flag missing tests.' } },
    )

    expect(planned.passes?.[0]?.lens).toMatchObject({ kind: 'append', text: 'Flag missing tests.' })
  })
})
