import { describe, expect, it } from 'vitest'
import { ConfigError } from '../config/errors.js'
import type { ReviewSettings } from '../config/merge-config.js'
import { SkillError } from '../skills/errors.js'
import { buildPasses } from './review-passes.js'
import type { SkillCatalog } from './review-passes.js'

const catalog = (known: Record<string, string>, omitted: string[] = []): SkillCatalog => ({
  find: async (name) => {
    const builtIn = name.startsWith('claude:')
    const text = known[name] ?? (builtIn ? `Skill built into Claude Code: ${name}.` : undefined)
    if (text === undefined && !name.startsWith('claude:'))
      throw new SkillError(`Skill "${name}" is not installed.`)
    return {
      name,
      origin: `/skills/${name}/SKILL.md`,
      text: text as string,
      omitted,
      native: name.startsWith('claude:')
        ? { kind: 'builtin', invoke: name.slice('claude:'.length) }
        : {
            kind: 'file',
            fileKind: 'skill',
            path: `/skills/${name}/SKILL.md`,
            dir: `/skills/${name}`,
            name,
          },
    }
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
    native?: boolean
  } = {},
) {
  return buildPasses({
    ...(review === undefined ? {} : { review }),
    ...(options.cliSkills === undefined ? {} : { cliSkills: options.cliSkills }),
    changedFiles: options.changedFiles ?? ['src/shop.ts'],
    readRepoFile: async (path) => options.repoFiles?.[path] ?? null,
    readLocalFile: async (path) => options.localFiles?.[path] ?? null,
    skills: options.skills ?? catalog({ 'code-review': 'Find bugs.', sec: 'Auth.' }),
    native: options.native ?? false,
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
    expect(await build(undefined)).toEqual({ plan: [], warnings: [], nativeSkills: new Map() })
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
      {
        skill: 'phada',
        origin: '.phada/config.yml → .phada/review.md',
        status: 'planned',
        mode: 'text',
      },
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
    expect(await build(repoSkills())).toEqual({ plan: [], warnings: [], nativeSkills: new Map() })
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

describe('buildPasses native mode', () => {
  const userSkills = (
    ...entries: { name: string; mode?: 'native' | 'text' }[]
  ): ReviewSettings => ({
    skills: { entries, origin: 'user:config.yml', source: 'local' },
  })

  it('runs skills other than phada natively when the provider runs skills', async () => {
    const planned = await build(userSkills({ name: 'phada' }, { name: 'code-review' }), {
      native: true,
    })

    expect(planned.passes?.map(({ skill, mode }) => [skill, mode])).toEqual([
      ['phada', undefined],
      ['code-review', 'native'],
    ])
    expect(planned.plan.map(({ mode }) => mode)).toEqual(['text', 'native'])
    expect([...planned.nativeSkills.keys()]).toEqual(['code-review'])
    expect(planned.nativeSkills.get('code-review')).toMatchObject({ kind: 'file' })
  })

  it('keeps a skill in text mode when its entry asks for it', async () => {
    const planned = await build(userSkills({ name: 'code-review', mode: 'text' }), { native: true })

    expect(planned.passes?.[0]?.mode).toBeUndefined()
    expect(planned.nativeSkills.size).toBe(0)
  })

  it('runs skills in text mode when the provider does not run skills', async () => {
    const planned = await build(userSkills({ name: 'code-review' }), { native: false })

    expect(planned.passes?.[0]?.mode).toBeUndefined()
  })

  it.each([
    ['a provider that does not run skills', false, undefined],
    ['text mode', true, 'text' as const],
  ])('fails on a built-in Claude Code skill with %s', async (_case, native, mode) => {
    await expect(
      build(
        userSkills({ name: 'claude:security-review', ...(mode === undefined ? {} : { mode }) }),
        { native },
      ),
    ).rejects.toThrow(
      new SkillError(
        'Skill claude:security-review is built into Claude Code and only runs natively with provider claude.',
      ),
    )
  })

  it('skips a built-in skill the repository asks for on another provider, with a warning', async () => {
    const planned = await build(repoSkills('claude:security-review', 'code-review'), {
      native: false,
    })

    expect(planned.passes?.map(({ skill }) => skill)).toEqual(['code-review'])
    expect(planned.warnings).toEqual([
      '.phada/config.yml: Skill claude:security-review is built into Claude Code and only runs natively with provider claude. Skipped.',
    ])
  })
})

describe('buildPasses native mode with paths', () => {
  it('leaves a skipped native pass out of the native skills', async () => {
    const planned = await build(
      {
        skills: {
          entries: [{ name: 'code-review', paths: ['docs/**'] }],
          origin: 'user:config.yml',
          source: 'local',
        },
      },
      { native: true, changedFiles: ['src/shop.ts'] },
    )

    expect(planned.passes?.[0]?.skip).toBeDefined()
    expect(planned.nativeSkills.size).toBe(0)
  })
})

describe('buildPasses native mode on a provider without skills', () => {
  it('warns that a skill asked to run natively runs as text', async () => {
    const planned = await build(
      {
        skills: {
          entries: [{ name: 'code-review', mode: 'native' }],
          origin: 'user:config.yml',
          source: 'local',
        },
      },
      { native: false },
    )

    expect(planned.passes?.[0]?.mode).toBeUndefined()
    expect(planned.warnings).toContain(
      'Skill code-review: this provider does not run skills natively; its text is sent instead.',
    )
  })
})
