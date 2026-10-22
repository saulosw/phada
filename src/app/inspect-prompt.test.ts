import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { LoadedContext } from '../context/types.js'
import { SkillError } from '../skills/errors.js'
import { defaultPromptView, inspectPrompt } from './inspect-prompt.js'
import type { SkillCatalog } from './review-passes.js'

const pullRequest = pullRequestFixture()

function loaded(overrides: Partial<LoadedContext> = {}): LoadedContext {
  return {
    diff: pullRequest.diff,
    options: {},
    context: { rules: [], docs: [], ignored: [] },
    ignore: [],
    repos: [],
    privateOnPublic: false,
    report: {
      configFiles: [],
      rules: [],
      docs: [],
      ignored: [],
      budget: { limit: 0, used: 0 },
      warnings: [],
    },
    ...overrides,
  }
}

const skills: SkillCatalog = {
  find: async (name) => {
    if (name !== 'sec') throw new SkillError(`Skill "${name}" is not installed.`)
    return { name, origin: '/s/sec/SKILL.md', text: 'Auth.', omitted: [] }
  },
}

const inspect = (overrides: Partial<Parameters<typeof inspectPrompt>[0]> = {}) =>
  inspectPrompt({
    pullRequest,
    loaded: loaded(),
    investigate: false,
    skills,
    readRepoFile: async () => null,
    readLocalFile: async () => null,
    ...overrides,
  })

describe('inspectPrompt', () => {
  it('shows the built-in pass with its parts and the size of each data block', async () => {
    const view = await inspect()

    expect(view.pullRequest).toEqual({
      repo: 'acme/shop',
      number: 12,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    })
    expect(view.passes).toHaveLength(1)
    expect(view.passes[0]).toMatchObject({ skill: 'phada', origin: 'phada', status: 'planned' })
    expect(view.passes[0]?.parts[0]?.text).toContain('You are a senior engineer')
    expect(view.passes[0]?.data.map(({ name }) => name)).toEqual(['PHADA_PR', 'PHADA_DIFF'])
    expect(view.passes[0]?.data[1]?.bytes).toBeGreaterThan(0)
  })

  it('describes the tools as a review would when investigation is on', async () => {
    const view = await inspect({ investigate: true })

    const text = view.passes[0]?.parts.map((part) => part.text).join('\n') ?? ''
    expect(text).toContain('read_file, grep, list tools.')
    expect(text).toContain('callers')
    expect(view.notes).toContain(
      'Tool sections are as a review sends them when the repository index is ready.',
    )
  })

  it('lists the docs block and the impact note', async () => {
    const view = await inspect({
      loaded: loaded({
        context: { rules: [], docs: [{ path: 'README.md', content: 'Hi' }], ignored: [] },
      }),
    })

    expect(view.passes[0]?.data.map(({ name }) => name)).toEqual([
      'PHADA_PR',
      'PHADA_DOCS',
      'PHADA_DIFF',
    ])
    expect(view.notes).toContain(
      'The impact of the change and related repositories are computed during a review and are not shown here.',
    )
  })

  it('shows one pass per skill and the warning of a repository skill that is missing', async () => {
    const view = await inspect({
      loaded: loaded({
        options: {
          review: {
            skills: {
              entries: [{ name: 'phada' }, { name: 'sec' }, { name: 'nope' }],
              origin: '.phada/config.yml',
              source: 'repository',
            },
          },
        },
      }),
    })

    expect(view.passes.map(({ skill, origin }) => [skill, origin])).toEqual([
      ['phada', 'phada'],
      ['sec', '/s/sec/SKILL.md'],
    ])
    expect(view.passes[1]?.parts[1]?.text).toBe('Review guide (skill sec):\nAuth.')
    expect(view.warnings).toEqual(['.phada/config.yml: Skill "nope" is not installed. Skipped.'])
  })

  it('takes --skill over the config', async () => {
    const view = await inspect({ cliSkills: ['sec'] })

    expect(view.passes.map(({ skill }) => skill)).toEqual(['sec'])
  })
})

describe('defaultPromptView', () => {
  it('shows the built-in prompt without a pull request', () => {
    const view = defaultPromptView()

    expect(view.pullRequest).toBeNull()
    expect(view.passes).toHaveLength(1)
    expect(view.passes[0]?.data).toEqual([])
    expect(view.passes[0]?.parts.some((part) => part.section === 'contract')).toBe(true)
  })
})

describe('defaultPromptView of a default review', () => {
  it('shows the verified floor and the tools a default review sends', () => {
    const view = defaultPromptView()
    const text = view.passes[0]?.parts.map((part) => part.text).join('\n') ?? ''

    expect(text).toContain('Report every candidate rated 25 or higher.')
    expect(text).toContain('read_file, grep, list tools.')
    expect(view.notes).toContain(
      'Tool sections are as a review sends them when the repository index is ready.',
    )
  })
})
