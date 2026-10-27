import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppliedUserConfig, UserConfigPlanResult } from '../../app/edit-user-config.js'
import type { PickableRepository, UserRepositories } from '../../app/read-user-repositories.js'
import type { UserConfigChange, UserConfigPlan } from '../../config/user-config-edit.js'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../../test/support/tui.js'

const CONFIG = '/home/ana/.config/phada/config.yml'

const SHOP: PickableRepository = {
  name: 'acme/shop',
  private: true,
  fork: false,
  pushedAt: '2026-10-24T12:00:00.000Z',
  watched: true,
  listed: true,
}
const INK: PickableRepository = {
  name: 'ana/ink',
  private: false,
  fork: true,
  pushedAt: '2026-10-20T12:00:00.000Z',
  watched: false,
  listed: true,
}
const BLOG: PickableRepository = {
  name: 'ana/blog',
  private: false,
  fork: false,
  pushedAt: null,
  watched: false,
  listed: true,
}

function planOf(changes: readonly UserConfigChange[]): UserConfigPlan {
  const names = (kind: 'watch' | 'unwatch') =>
    changes.flatMap((change) => (change.kind === kind ? [change.repo] : []))
  return {
    path: CONFIG,
    exists: true,
    before: 'watch:\n  repos: [acme/shop]\n',
    text: 'watch: …\n',
    changes: [{ key: 'watch.repos', added: names('watch'), removed: names('unwatch') }],
  }
}

function openRepositoriesStep(
  options: {
    read?: UserRepositories
    planned?: UserConfigPlanResult[]
    applied?: AppliedUserConfig[]
  } = {},
) {
  const plans: (readonly UserConfigChange[])[] = []
  const writes: UserConfigPlan[] = []
  const planned = [...(options.planned ?? [])]
  const applied = [...(options.applied ?? [])]
  const app = renderApp({
    deps: {
      start: 'setup',
      readUserRepositories: async () =>
        options.read ?? { status: 'listed', repositories: [SHOP, INK, BLOG] },
      planConfig: async (changes) => {
        plans.push(changes)
        return planned.shift() ?? { ok: true, plan: planOf(changes) }
      },
      applyConfig: async (plan) => {
        writes.push(plan)
        return applied.shift() ?? { ok: true, written: true }
      },
    },
    size: { columns: 80, rows: 24 },
  })
  const seeing = async (...expected: (string | RegExp)[]) => {
    await app.showing(...expected)
    for (const text of expected) {
      if (typeof text === 'string') expect(app.frame()).toContain(text)
      else expect(app.frame()).toMatch(text)
    }
  }
  const reach = async () => {
    await app.showing('Step 1 of 7 · GitHub')
    await app.press('s', 's', 's')
    await seeing('Step 4 of 7 · Repositories')
  }
  return { ...app, seeing, reach, plans, writes }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the repositories step', () => {
  it('lists the repositories with the watched ones marked', async () => {
    const { footer, frame, reach, seeing } = openRepositoriesStep()
    await reach()
    await seeing('3 repositories · 1 marked')
    expect(frame()).toMatch(/\[x\] acme\/shop +private · 1d ago/)
    expect(frame()).toMatch(/\[ \] ana\/ink +fork · 5d ago/)
    expect(frame()).toMatch(/\[ \] ana\/blog/)
    expect(footer()).toContain('Space mark')
    expect(footer()).toContain('f filter')
    expectFits(frame())
  })

  it('marks and unmarks with Space, then writes watch.repos after its before and after', async () => {
    const { footer, frame, press, reach, seeing, plans, writes } = openRepositoriesStep()
    await reach()
    await seeing('[x] acme/shop')
    await press(' ', KEYS.down, ' ')
    await seeing('[ ] acme/shop', '[x] ana/ink', '3 repositories · 1 marked')
    await press(KEYS.enter)
    await seeing('Save to ~/.config/phada/config.yml?')
    expect(frame()).toMatch(/watch\.repos +\+ ana\/ink {2}− acme\/shop/)
    expect(footer()).toContain('Enter save')
    expect(plans).toEqual([
      [
        { kind: 'watch', repo: 'ana/ink' },
        { kind: 'unwatch', repo: 'acme/shop' },
      ],
    ])
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Step 5 of 7 · Graph')
    expect(writes).toHaveLength(1)
  })

  it('goes on without planning when nothing changed', async () => {
    const { press, reach, seeing, plans } = openRepositoriesStep()
    await reach()
    await seeing('[x] acme/shop')
    await press(' ', ' ', KEYS.enter)
    await seeing('Step 5 of 7 · Graph')
    expect(plans).toEqual([])
  })

  it('cancels the change on Esc and keeps the marks', async () => {
    const { frame, press, reach, seeing, writes } = openRepositoriesStep()
    await reach()
    await seeing('[x] acme/shop')
    await press(KEYS.down, ' ', KEYS.enter)
    await seeing('Save to ~/.config/phada/config.yml?')
    await press(KEYS.escape)
    await seeing('[x] ana/ink')
    expect(frame()).not.toContain('Save to')
    expect(frame()).not.toContain('Leave the setup?')
    expect(writes).toEqual([])
  })

  it('filters the list by what is typed and marks what the filter left', async () => {
    const { footer, frame, press, reach, seeing, type, plans } = openRepositoriesStep()
    await reach()
    await seeing('[x] acme/shop')
    await press('f')
    await seeing('Filter:')
    expect(footer()).toContain('Enter apply · Esc cancel')
    expect(footer()).not.toContain('Esc leave')
    expect(footer()).not.toContain('s skip')
    await type('BLO')
    await seeing('Filter: BLO')
    await seeing('1 of 3 repositories · 1 marked')
    expect(frame()).not.toContain('acme/shop')
    await press(KEYS.enter)
    await press(' ')
    await seeing('[x] ana/blog')
    await press('f')
    await type('zzz')
    await seeing('No repository matches BLOzzz.')
    await press(KEYS.escape)
    await seeing('[x] ana/blog')
    await press(KEYS.enter)
    await seeing('Save to ~/.config/phada/config.yml?')
    expect(plans).toEqual([[{ kind: 'watch', repo: 'ana/blog' }]])
  })

  it('adds a repository typed as owner/repo, refusing another shape', async () => {
    const { footer, frame, press, reach, seeing, type, plans } = openRepositoriesStep()
    await reach()
    await seeing('[x] acme/shop')
    await press('a')
    await seeing('owner/repo:')
    expect(footer()).not.toContain('s skip')
    await type('just-a-name')
    await press(KEYS.enter)
    await seeing('just-a-name is not owner/repo.')
    expect(frame()).not.toMatch(/\] just-a-name/)
    await press('a')
    await type('other/lib')
    await press(KEYS.enter)
    await seeing('[x] other/lib', '4 repositories · 2 marked')
    expect(frame()).not.toContain('is not owner/repo')
    await press('a')
    await type('ACME/Shop')
    await press(KEYS.enter)
    await seeing('4 repositories · 2 marked')
    await press(KEYS.enter)
    await seeing('Save to ~/.config/phada/config.yml?')
    expect(plans).toEqual([[{ kind: 'watch', repo: 'other/lib' }]])
  })

  it('shows why the listing failed in one line and still adds a typed repository', async () => {
    const { frame, press, reach, seeing, type, plans } = openRepositoriesStep({
      read: {
        status: 'failed',
        error: 'GitHub denied reading the repositories of the token owner (HTTP 403)',
        repositories: [{ name: 'acme/shop', watched: true, listed: false }],
      },
    })
    await reach()
    await seeing('Could not list your repositories: GitHub denied')
    expect(frame()).toMatch(/\[x\] acme\/shop +not in your list/)
    await press('a')
    await type('other/lib')
    await press(KEYS.enter)
    await seeing('[x] other/lib')
    await press(KEYS.enter)
    await seeing('Save to ~/.config/phada/config.yml?')
    expect(plans).toEqual([[{ kind: 'watch', repo: 'other/lib' }]])
    expectFits(frame())
  })

  it('says it needs GitHub without a token, and Enter goes on', async () => {
    const { footer, press, reach, seeing, plans } = openRepositoriesStep({
      read: { status: 'no-token', repositories: [] },
    })
    await reach()
    await seeing('needs a GitHub token')
    expect(footer()).toContain('Enter continue')
    expect(footer()).not.toContain('Space')
    await press(KEYS.enter)
    await seeing('Step 5 of 7 · Graph')
    expect(plans).toEqual([])
  })

  it('shows why the last watched repository cannot be removed', async () => {
    const { press, reach, seeing, writes } = openRepositoriesStep({
      planned: [
        { ok: false, reason: 'last-watched-repo', repo: 'acme/shop', settings: ['interval'] },
      ],
    })
    await reach()
    await seeing('[x] acme/shop')
    await press(' ', KEYS.enter)
    await seeing('acme/shop is the last watched repository')
    await press(KEYS.enter)
    expect(writes).toEqual([])
  })

  it('scrolls a long list within 80×24', async () => {
    const repositories = Array.from({ length: 60 }, (_, n): PickableRepository => ({
      name: `acme/repository-with-a-rather-long-name-${String(n + 1).padStart(2, '0')}`,
      private: n % 2 === 0,
      fork: n % 3 === 0,
      pushedAt: '2026-10-24T12:00:00.000Z',
      watched: false,
      listed: true,
    }))
    const { frame, press, reach, seeing } = openRepositoriesStep({
      read: { status: 'listed', repositories },
    })
    await reach()
    await seeing('60 repositories · 0 marked', /1–\d+ of 60/)
    expectFits(frame())
    await press(KEYS.end, ' ')
    await seeing('[x] acme/repository-with-a-rather-long-name-60', /\d+–60 of 60/)
    expectFits(frame())
  })

  it('speaks the language of the app', async () => {
    const app = renderApp({
      deps: {
        start: 'setup',
        language: 'pt',
        readUserRepositories: async () => ({ status: 'listed', repositories: [SHOP, INK] }),
      },
      size: { columns: 80, rows: 24 },
    })
    await app.showing('Passo 1 de 7')
    await app.press('s', 's', 's')
    await app.showing('2 repositórios · 1 marcado')
    expect(app.footer()).toContain('Espaço marcar')
    expectFits(app.frame())
  })
})
