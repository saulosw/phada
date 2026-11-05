import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { DEFAULT_CI } from '../config/merge-config.js'
import type { LoadedContext } from '../context/types.js'
import { SkillError } from '../skills/errors.js'
import { defaultPromptView, inspectPrompt } from './inspect-prompt.js'
import type { SkillCatalog } from './review-passes.js'

const pullRequest = pullRequestFixture()

function loaded(overrides: Partial<LoadedContext> = {}): LoadedContext {
  return {
    diff: pullRequest.diff,
    options: { ci: DEFAULT_CI },
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
    return {
      name,
      origin: '/s/sec/SKILL.md',
      text: 'Auth.',
      omitted: [],
      native: { kind: 'file', fileKind: 'skill', path: '/s/sec/SKILL.md', dir: '/s/sec', name },
    }
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
          ci: DEFAULT_CI,
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

describe('inspectPrompt with a large diff', () => {
  const created = (path: string): string =>
    [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1,160 @@',
      ...Array.from({ length: 160 }, () => `+${'x'.repeat(99)}`),
      '',
    ].join('\n')
  const diff = created('api/a.ts') + created('api/b.ts') + created('web/c.ts')
  const large = (options: Partial<LoadedContext['options']> = {}) =>
    inspect({ loaded: loaded({ diff, options: { ci: DEFAULT_CI, ...options } }) })

  it('lists the groups and shows the group part and block of each text pass', async () => {
    const view = await large({ groups: true })

    expect(view.groups?.map(({ label, files, link }) => ({ label, files, link }))).toEqual([
      { label: 'api (part 1)', files: ['api/a.ts'], link: 'directory' },
      { label: 'api (part 2)', files: ['api/b.ts'], link: 'directory' },
      { label: 'web', files: ['web/c.ts'], link: 'directory' },
    ])
    const text = view.passes[0]?.parts.map((part) => part.text).join('\n') ?? ''
    expect(text).toContain('Phada reviews it in groups of files')
    expect(view.passes[0]?.data.map(({ name }) => name)).toEqual([
      'PHADA_PR',
      'PHADA_GROUP',
      'PHADA_DIFF',
    ])
  })

  it('reviews it whole by default and when the config turns groups off', async () => {
    expect((await large()).groups).toBeUndefined()
    const view = await large({ groups: false })

    expect(view.groups).toBeUndefined()
    const text = view.passes[0]?.parts.map((part) => part.text).join('\n') ?? ''
    expect(text).not.toContain('Phada reviews it in groups of files')
    expect(view.passes[0]?.data.map(({ name }) => name)).toEqual(['PHADA_PR', 'PHADA_DIFF'])
  })

  it('never groups a native skill', async () => {
    const view = await inspect({
      native: true,
      cliSkills: ['sec'],
      loaded: loaded({ diff, options: { ci: DEFAULT_CI, groups: true } }),
    })

    expect(view.groups).toBeUndefined()
    expect(view.passes[0]?.data.map(({ name }) => name)).toEqual(['PHADA_PR', 'PHADA_DIFF'])
  })
})

describe('inspectPrompt with a native skill', () => {
  const withSkill = (review: LoadedContext['options']['review']) =>
    inspect({
      native: true,
      cliSkills: ['sec'],
      loaded: loaded({ options: { ci: DEFAULT_CI, review } }),
    })

  it('shows the message, the context, the command policy and the conversion', async () => {
    const view = await withSkill({
      commands: { policy: ['npm test'], origin: 'user:config.yml' },
      readDirs: { dirs: ['/rules'], origin: 'user:config.yml' },
    })

    const pass = view.passes[0]
    expect(pass?.mode).toBe('native')
    expect(pass?.native).toEqual({
      message: `/sec ${pullRequest.url}`,
      commands: ['npm test'],
      readDirs: ['/rules'],
    })
    expect(pass?.parts.map(({ section }) => section)).toEqual(['context', 'contract'])
    expect(pass?.parts[0]?.text).toContain('You are running inside Phada')
    expect(pass?.parts[1]?.text).toContain('code review guide sec')
    expect(pass?.data.map(({ name }) => name)).toEqual(['PHADA_PR', 'PHADA_DIFF'])
  })

  it('shows read-only for an outside author of a public repository', async () => {
    const view = await inspect({
      native: true,
      cliSkills: ['sec'],
      pullRequest: { ...pullRequest, association: 'NONE', private: false },
      loaded: loaded({
        options: { ci: DEFAULT_CI, review: { commands: { policy: 'all', origin: 'u' } } },
      }),
    })

    expect(view.passes[0]?.native?.commands).toBe('read-only')
  })

  it('keeps text passes as before', async () => {
    const view = await inspect({ cliSkills: ['sec'] })

    expect(view.passes[0]?.mode).toBe('text')
    expect(view.passes[0]?.native).toBeUndefined()
  })
})
