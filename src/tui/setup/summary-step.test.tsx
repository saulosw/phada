import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { IndexingResult } from '../../app/index-repository.js'
import type { UserConfigChange, UserConfigPlan } from '../../config/user-config-edit.js'
import type { AppDeps } from '../app-context.js'
import {
  emptyRepositories,
  frameLines,
  KEYS,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'

const CONFIG = '/home/ana/.config/phada/config.yml'

function openSetup(language?: string, deps: Partial<AppDeps> = {}) {
  let current = language
  const app = renderApp({
    deps: {
      ...deps,
      start: 'setup',
      ...(language === undefined ? {} : { language }),
      readLanguage: async () => current,
      planConfig: async (changes: readonly UserConfigChange[]) => {
        const [change] = changes
        const value = change?.kind === 'set' ? change.value : ''
        const plan: UserConfigPlan = {
          path: CONFIG,
          exists: true,
          before: `language: ${current}\n`,
          text: `language: ${value}\n`,
          changes: [{ key: 'language', before: current ?? null, after: value }],
        }
        return { ok: true, plan }
      },
      applyConfig: async (plan) => {
        const [change] = plan.changes
        if (change?.key === 'language') current = change.after ?? undefined
        return { ok: true, written: true }
      },
    },
    size: { columns: 80, rows: 24 },
  })
  const seeing = async (...expected: (string | RegExp)[]) => {
    await app.showing(...expected)
    for (const text of expected) expect(app.frame()).toMatch(text)
  }
  return { ...app, seeing }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the summary', () => {
  it('says what was written and where, what was skipped and what to do now, without the watch when nothing is watched', async () => {
    const { footer, frame, press, seeing } = openSetup('pt')
    await seeing(/ 1 de 7 · GitHub/)
    await press('s', 's', KEYS.up, KEYS.enter)
    await seeing('Gravar em ~/.config/phada/config.yml?')
    await press(KEYS.enter)
    await seeing('Step 4 of 7')
    await press('s', 's', 's')
    await seeing('Step 7 of 7 · Summary', 'Written to ~/.config/phada/config.yml')
    expect(frame()).toMatch(/language +pt → en/)
    expect(frame()).toContain('Skipped: GitHub, AI, Repositories, Graph, This repository')
    expect(frame()).toContain('phada review owner/repo#N')
    expect(frame()).not.toContain('phada watch')
    expect(footer()).toContain('Enter go to Home')
    expect(footer()).not.toContain('s skip')
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Last reviews')
    expect(frame()).not.toContain('Summary')
  })

  it('says what was indexed, what was left for later and what phada init created', async () => {
    const results: IndexingResult[] = [
      { kind: 'indexed', files: 12 },
      { kind: 'failed', message: 'Could not fetch HEAD from acme/gone' },
      { kind: 'cancelled', extracted: 3, total: 90 },
    ]
    const { frame, press, seeing } = openSetup(undefined, {
      readRepositories: async () => ({
        ...emptyRepositories(),
        repositories: ['acme/shop', 'acme/gone', 'ana/ink', 'ana/web'].map((repo) => ({
          repo,
          origins: ['watched' as const],
          publish: 'pr' as const,
          index: { file: null, indexedSha: null, checkedAt: null },
          lastReview: null,
        })),
      }),
      indexRepository: (_repo, { signal }) => {
        const result = results.shift() ?? { kind: 'indexed', files: 0 }
        if (result.kind !== 'cancelled') return Promise.resolve(result)
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(result)))
      },
      readRepositoryFolder: async () => ({ kind: 'unconfigured', root: '/home/ana/code/shop' }),
      initRepository: async () => ({
        root: '/home/ana/code/shop',
        files: [
          { path: '.phada/config.yml', created: true },
          { path: '.phada/rules.md', created: false },
        ],
      }),
    })
    await seeing('Step 1 of 7')
    await press('s', 's', 's', 's')
    await seeing('Step 5 of 7 · Graph', 'ana/web')
    await press(KEYS.enter)
    await seeing(/ana\/ink · fetching/)
    await press(KEYS.escape)
    await seeing(/ana\/web · not started/)
    await press(KEYS.enter)
    await seeing('Step 6 of 7', 'has no .phada/ folder')
    await press(KEYS.enter)
    await seeing('Created .phada/config.yml')
    await press(KEYS.enter)
    await seeing('Step 7 of 7 · Summary', 'Indexed: acme/shop')
    expect(frame()).toContain('Not indexed: acme/gone')
    expect(frame()).toContain('Left for later: ana/ink, ana/web')
    expect(frame()).toContain('phada watch indexes them when it is idle')
    expect(frame()).toContain('Created in ~/code/shop: .phada/config.yml')
    expect(frame()).not.toContain('rules.md')
    expect(frame()).toContain('Skipped: GitHub, AI, Language, Repositories')
    expect(frame()).toContain('reviews the new pull requests of the watched repositories')
    expectFits(frame())
  })

  it('says nothing was written when every step was skipped', async () => {
    const { frame, press, seeing } = openSetup()
    await seeing('Step 1 of 7')
    await press('s', 's', 's', 's', 's', 's')
    await seeing('Step 7 of 7 · Summary', 'Nothing was written to your config.')
    expect(frame()).toContain('Skipped: GitHub, AI, Language, Repositories, Graph, This repository')
    await press('s')
    await seeing('Step 7 of 7 · Summary')
  })

  it.each([
    ['pt', 'Nada foi gravado na sua config.', 'O que fazer agora'],
    ['es', 'No se guardó nada en tu configuración.', 'Qué hacer ahora'],
  ])('speaks %s', async (language, nothing, now) => {
    const { frame, press, seeing } = openSetup(language)
    await seeing(/ 1 de 7 · GitHub/)
    await press('s', 's', 's', 's', 's', 's')
    await seeing(nothing, now)
    expectFits(frame())
  })
})
