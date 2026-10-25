import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { PromptView } from '../../app/inspect-prompt.js'
import type { RepositoryList } from '../../app/read-repositories.js'
import type { BranchRules, LocalRules, PullRequestRules, ReadRules } from '../../app/read-rules.js'
import {
  CONFIG_FILE,
  frameLines,
  KEYS,
  renderApp,
  visibleWidth,
  waitFor,
} from '../../../test/support/tui.js'
import type { AppDeps } from '../app-context.js'
import { SCREENS } from '../screens.js'
import type { TerminalSize } from '../terminal-size.js'
import { RulesScreen } from './rules.js'

afterEach(() => cleanup())

const SMALL = { columns: 80, rows: 24 }
const WIDE = { columns: 160, rows: 40 }

function repositories(): RepositoryList {
  const index = { file: null, indexedSha: null, checkedAt: null }
  return {
    configFile: CONFIG_FILE,
    configured: true,
    configError: null,
    watching: true,
    repositories: [
      { repo: 'acme/api', origins: ['history'], index, lastReview: null },
      { repo: 'acme/shop', origins: ['watched', 'own-config'], index, lastReview: null },
    ],
  }
}

function local(changes: Partial<LocalRules> = {}): LocalRules {
  return {
    lens: { kind: 'built-in' },
    rules: [
      { key: 'utc', name: 'utc', text: 'Store every time in UTC.', origin: 'global' },
      {
        key: 'user:repos/acme/shop/rules.md',
        name: 'rules.md',
        text: 'Money is kept in cents.',
        origin: 'repository',
      },
    ],
    warnings: [],
    ...changes,
  }
}

const REPORT: ReadRules['report'] = {
  configFiles: [
    { path: 'user:config.yml', origin: 'user', status: 'loaded' },
    { path: '.phada/config.yml', origin: 'repository', status: 'loaded' },
  ],
  rules: [
    { key: 'cents', origin: '.phada/config.yml', scope: ['**'], severity: 'P1', status: 'listed' },
    {
      key: 'api-errors',
      origin: 'src/api/.phada/config.yml',
      scope: ['src/api/**'],
      status: 'listed',
    },
  ],
  docs: [
    { path: 'AGENTS.md', origin: 'repository', category: 'agents', bytes: 2048, status: 'listed' },
  ],
  ignored: [],
  budget: { limit: 61_440, used: 0 },
  warnings: [],
}

function branch(changes: Partial<ReadRules> = {}): BranchRules {
  return {
    status: 'read',
    target: { kind: 'default-branch', ref: 'main' },
    report: REPORT,
    ignore: ['**/package-lock.json', 'dist/**'],
    lens: { kind: 'built-in' },
    ...changes,
  }
}

const INSTRUCTIONS = Array.from(
  { length: 60 },
  (_, index) => `Instruction line ${index + 1}: look for real defects only.`,
).join('\n')

function prompt(): PromptView {
  return {
    pullRequest: {
      repo: 'acme/shop',
      number: 15,
      baseSha: 'b1b2c3d4e5f6',
      headSha: 'a1b2c3d4e5f6',
    },
    passes: [
      {
        skill: 'phada',
        origin: 'phada',
        status: 'planned',
        mode: 'text',
        parts: [
          { section: 'lens', origin: 'phada', text: INSTRUCTIONS },
          { section: 'contract', origin: 'phada', text: 'Answer with JSON only.' },
        ],
        data: [
          { name: 'PHADA_PR', bytes: 512 },
          { name: 'PHADA_DIFF', bytes: 30_720 },
        ],
      },
    ],
    notes: [],
    warnings: ['CI annotations not read: the token lacks checks: read'],
  }
}

function pullRules(): PullRequestRules {
  return {
    status: 'read',
    rules: {
      status: 'read',
      target: { kind: 'pull-request', number: 15, baseSha: 'b1b2c3d4e5f6' },
      report: {
        ...REPORT,
        rules: [
          { key: 'cents', origin: '.phada/config.yml', scope: ['**'], status: 'applied' },
          {
            key: 'api-errors',
            origin: 'src/api/.phada/config.yml',
            scope: ['src/api/**'],
            status: 'out-of-scope',
          },
        ],
        docs: [
          {
            path: 'AGENTS.md',
            origin: 'repository',
            category: 'agents',
            bytes: 2048,
            status: 'included',
          },
        ],
      },
      ignore: [],
      lens: { kind: 'built-in' },
    },
    prompt: prompt(),
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function openRules(
  options: {
    deps?: Partial<AppDeps>
    size?: TerminalSize
    language?: string
  } = {},
) {
  const calls: string[] = []
  const app = renderApp({
    deps: {
      readRepositories: async () => repositories(),
      readLocalRules: async () => local(),
      readRepositoryRules: async (repo) => {
        calls.push(`branch ${repo}`)
        return branch()
      },
      readPullRequestRules: async (repo, number) => {
        calls.push(`pull ${repo}#${number}`)
        return pullRules()
      },
      ...options.deps,
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? SMALL,
    screens: [{ id: 'rules', title: (m) => m.screens.rules, Screen: RulesScreen }],
  })
  return { ...app, calls }
}

async function openShop(rules: ReturnType<typeof openRules>) {
  await waitFor(() => rules.frame().includes('acme/shop'))
  await rules.press(KEYS.down, KEYS.enter)
  await waitFor(() => rules.frame().includes('Lens'))
}

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

describe('the Rules screen', () => {
  it('is the Rules tab of the app', () => {
    expect(SCREENS.find(({ id }) => id === 'rules')?.Screen).toBe(RulesScreen)
  })

  it('lists the repositories with their origins to pick one', async () => {
    const { frame } = openRules()
    await waitFor(() => frame().includes('acme/shop'))
    const text = frame()
    expectFits(text, SMALL)
    expect(text).toContain('Pick a repository')
    expect(text).toMatch(/❯ acme\/api\s+history/)
    expect(text).toMatch(/acme\/shop\s+watched, own config/)
  })

  it('says how to get a repository when there is none', async () => {
    const { frame } = openRules({
      deps: { readRepositories: async () => ({ ...repositories(), repositories: [] }) },
    })
    await waitFor(() => frame().includes('No repositories'))
    expect(frame()).toContain('phada review owner/repo#N')
  })

  it("shows the built-in lens, the user's rules and the .phada/ of the default branch in 80×24", async () => {
    const rules = openRules()
    await openShop(rules)
    await waitFor(() => rules.frame().includes('at main'))
    const text = rules.frame()
    expectFits(text, SMALL)
    expect(text).toMatch(/Lens\s+Phada's built-in reviewer lens/)
    expect(text).toContain('Your rules (2)')
    expect(text).toMatch(/utc\s+Store every time in UTC\.\s+global/)
    expect(text).toMatch(/ rules\.md\s+Money is kept in cents\.\s+this repo/)
    expect(text).toContain('.phada/ and docs at main')
    expect(text).toMatch(/Config files \(2\)/)
    expect(text).toMatch(/\.phada\/config\.yml\s+repository/)
    expect(text).toMatch(/cents\s+\.phada\/config\.yml · P1/)
    expect(text).toMatch(/api-errors\s+src\/api\/\.phada\/config\.yml · src\/api\/\*\*/)
    expect(text).toMatch(/r refresh · p pull request · Esc back/)
    expect(rules.calls).toEqual(['branch acme/shop'])
  })

  it('shows the own prompt of the user config with its mode and who set it', async () => {
    const rules = openRules({
      deps: {
        readLocalRules: async () =>
          local({
            lens: {
              kind: 'prompt',
              prompt: {
                file: '/home/ana/.config/phada/lens.md',
                mode: 'replace',
                origin: 'user:config.yml',
                source: 'local',
              },
              setBy: { kind: 'global', name: 'config.yml' },
            },
          }),
        readRepositoryRules: async () => ({ status: 'no-token' }),
      },
    })
    await openShop(rules)
    await waitFor(() => rules.frame().includes('No GitHub token'))
    const text = rules.frame()
    expect(text).toContain('own prompt ~/.config/phada/lens.md · replaces the built-in lens')
    expect(text).toContain('set by your global config')
    expect(text).toContain("From your config; the repository's .phada/ can change it.")
  })

  it('shows the lens the repository .phada/ sets once it is read, naming its file', async () => {
    const rules = openRules({
      deps: {
        readRepositoryRules: async () =>
          branch({
            lens: {
              kind: 'skills',
              skills: {
                entries: [{ name: 'security', mode: 'native' }, { name: 'phada' }],
                origin: '.phada/config.yml',
                source: 'repository',
              },
              prompt: {
                file: '.phada/lens.md',
                mode: 'append',
                origin: '.phada/config.yml',
                source: 'repository',
              },
              setBy: { kind: 'repository-file', name: '.phada/config.yml' },
            },
          }),
      },
    })
    await openShop(rules)
    await waitFor(() => rules.frame().includes('skills'))
    const text = rules.frame()
    expect(text).toContain('skills security (native), phada · own prompt .phada/lens.md')
    expect(text).toContain('set by .phada/config.yml in the repository')
    expect(text).not.toContain("From your config; the repository's")
  })

  it('shows only the local parts while the repository is loading', async () => {
    const pending = deferred<BranchRules>()
    const rules = openRules({ deps: { readRepositoryRules: () => pending.promise } })
    await openShop(rules)
    const text = rules.frame()
    expect(text).toContain("Phada's built-in reviewer lens")
    expect(text).toContain('Your rules (2)')
    expect(text).toMatch(/\.phada\/ of the repository\s*\n\s+Loading/)
    pending.resolve(branch())
    await waitFor(() => rules.frame().includes('at main'))
  })

  it('keeps the local parts and shows the error of the network on screen, reading again on r', async () => {
    let attempt = 0
    const rules = openRules({
      deps: {
        readRepositoryRules: async () => {
          attempt += 1
          if (attempt === 1) throw new Error('Resource not accessible by integration')
          return branch()
        },
      },
    })
    await openShop(rules)
    await waitFor(() => rules.frame().includes('not accessible'))
    const text = rules.frame()
    expect(text).toContain('Resource not accessible by integration')
    expect(text).toContain('Your rules (2)')
    await rules.press('r')
    await waitFor(() => rules.frame().includes('at main'))
    expect(attempt).toBe(2)
  })

  it('says how to get a token without one, still showing the local parts', async () => {
    const rules = openRules({ deps: { readRepositoryRules: async () => ({ status: 'no-token' }) } })
    await openShop(rules)
    await waitFor(() => rules.frame().includes('No GitHub token'))
    const text = rules.frame()
    expect(text).toContain('No GitHub token — gh auth login or set GITHUB_TOKEN')
    expect(text).toContain('Your rules (2)')
  })

  it('says how to create .phada/ when the branch has no rules, and when the repository is empty', async () => {
    const nothing = openRules({
      deps: {
        readRepositoryRules: async () =>
          branch({ report: { ...REPORT, configFiles: [], rules: [], docs: [] }, ignore: [] }),
      },
    })
    await openShop(nothing)
    await waitFor(() => nothing.frame().includes('No .phada/'))
    expect(nothing.frame()).toContain('Create .phada/ in the repository with phada init')
    cleanup()

    const empty = openRules({ deps: { readRepositoryRules: async () => ({ status: 'empty' }) } })
    await openShop(empty)
    await waitFor(() => empty.frame().includes('empty'))
    expect(empty.frame()).toContain('The repository is empty')
  })

  it('opens the loaded rules and the prompt of a pull request with p, and Esc returns', async () => {
    const rules = openRules()
    await openShop(rules)
    await rules.press('p')
    await waitFor(() => rules.frame().includes('Pull request number'))
    await rules.type('15')
    expect(rules.frame()).toContain('Pull request number: 15')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('Loaded rules'))
    const text = rules.frame()
    expectFits(text, SMALL)
    expect(text).toContain('acme/shop#15 · head a1b2c3d · base b1b2c3d')
    expect(text).toMatch(/cents\s+\.phada\/config\.yml/)
    expect(text).toMatch(/api-errors\s+.* · out of scope/)
    expect(text).toMatch(/AGENTS\.md\s+2\.0 KB · sent/)
    expect(rules.calls).toEqual(['branch acme/shop', 'pull acme/shop#15'])

    await rules.press(KEYS.escape)
    await waitFor(() => rules.frame().includes('at main'))
    expect(rules.frame()).not.toContain('Loaded rules')
    await rules.press(KEYS.escape)
    await waitFor(() => rules.frame().includes('Pick a repository'))
    expect(rules.frame()).toMatch(/❯ acme\/shop/)
  })

  it('refuses a pull request number that is not digits, saying what to type', async () => {
    const rules = openRules()
    await openShop(rules)
    await rules.press('p')
    await rules.type('abc')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('is not a pull request number'))
    expect(rules.frame()).toContain('"abc" is not a pull request number. Type its digits, e.g. 15.')
    expect(rules.calls).toEqual(['branch acme/shop'])

    await rules.press('p', KEYS.backspace, KEYS.backspace, KEYS.backspace)
    await rules.type('0')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('"0"'))
    expect(rules.calls).toEqual(['branch acme/shop'])
  })

  it('scrolls the prompt: data blocks, then every instruction line', async () => {
    const rules = openRules()
    await openShop(rules)
    await rules.press('p')
    await rules.type('15')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('Loaded rules'))
    expect(rules.frame()).not.toContain('Instruction line 60')
    await rules.press(KEYS.end)
    const end = rules.frame()
    expectFits(end, SMALL)
    expect(end).toContain('Answer with JSON only.')
    expect(end).toContain('Instruction line 60')
    await rules.press(KEYS.home)
    for (let page = 0; page < 2; page += 1) await rules.press(KEYS.pageDown)
    const middle = rules.frame()
    expect(middle).toMatch(/PHADA_DIFF\s+30\.0 KB|Instruction line/)
  })

  it('shows the data blocks, the warnings and the pass of the prompt in a wide terminal', async () => {
    const rules = openRules({ size: WIDE })
    await openShop(rules)
    await rules.press('p')
    await rules.type('15')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('Loaded rules'))
    const text = rules.frame()
    expectFits(text, WIDE)
    expect(text).toContain('Pass 1: phada (built-in)')
    expect(text).toMatch(/PHADA_PR\s+512 B/)
    expect(text).toMatch(/PHADA_DIFF\s+30\.0 KB/)
    expect(text).toContain('CI annotations not read: the token lacks checks: read')
    expect(text).toContain('── lens · phada')
  })

  it('says there is no token when opening a pull request without one', async () => {
    const rules = openRules({
      deps: {
        readRepositoryRules: async () => ({ status: 'no-token' }),
        readPullRequestRules: async () => ({ status: 'no-token' }),
      },
    })
    await openShop(rules)
    await rules.press('p')
    await rules.type('15')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('acme/shop#15'))
    expect(rules.frame()).toContain('No GitHub token — gh auth login or set GITHUB_TOKEN')
  })

  it('shows a failed pull request read on screen', async () => {
    const rules = openRules({
      deps: {
        readPullRequestRules: async () => {
          throw new Error('Pull request acme/shop#99 not found')
        },
      },
    })
    await openShop(rules)
    await rules.press('p')
    await rules.type('99')
    await rules.press(KEYS.enter)
    await waitFor(() => rules.frame().includes('not found'))
    expect(rules.frame()).toContain('Pull request acme/shop#99 not found')
  })

  it.each([
    ['pt', 'Lente', 'Suas regras (2)', 'Sem token do GitHub'],
    ['es', 'Lente', 'Tus reglas (2)', 'Sin token de GitHub'],
  ])('speaks %s', async (language, lens, userRules, noToken) => {
    const rules = openRules({
      language,
      deps: { readRepositoryRules: async () => ({ status: 'no-token' }) },
    })
    await waitFor(() => rules.frame().includes('acme/shop'))
    await rules.press(KEYS.down, KEYS.enter)
    await waitFor(() => rules.frame().includes(noToken))
    const text = rules.frame()
    expectFits(text, SMALL)
    expect(text).toContain(lens)
    expect(text).toContain(userRules)
  })
})
