import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepositoryFolder, RepositoryInit } from '../../app/repository-folder.js'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../../test/support/tui.js'

const ROOT = '/home/ana/code/shop'

function openRepositoryStep(
  options: {
    folder?: RepositoryFolder
    init?: () => Promise<RepositoryInit>
    language?: string
  } = {},
) {
  let inits = 0
  const app = renderApp({
    deps: {
      start: 'setup',
      ...(options.language === undefined ? {} : { language: options.language }),
      readRepositoryFolder: async () => options.folder ?? { kind: 'unconfigured', root: ROOT },
      initRepository: async () => {
        inits += 1
        return (
          options.init?.() ?? {
            root: ROOT,
            files: [
              { path: '.phada/config.yml', created: true },
              { path: '.phada/rules.md', created: false },
            ],
          }
        )
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
    await app.press('s', 's', 's', 's', 's')
    await seeing('Step 6 of 7 · This repository')
  }
  return { ...app, seeing, reach, inits: () => inits }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the repository step', () => {
  it('offers phada init in a git repository without .phada/ and shows the files it created', async () => {
    const { footer, frame, inits, press, reach, seeing } = openRepositoryStep()
    await reach()
    await seeing('~/code/shop has no .phada/ folder')
    expect(footer()).toContain('Enter create .phada/')
    expect(footer()).toContain('s skip')
    expect(inits()).toBe(0)
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Created .phada/config.yml', '.phada/rules.md exists, left unchanged')
    expect(inits()).toBe(1)
    expect(footer()).toContain('Enter continue')
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Step 7 of 7 · Summary')
    expect(inits()).toBe(1)
  })

  it('says the repository already has .phada/ and goes on', async () => {
    const { footer, inits, press, reach, seeing } = openRepositoryStep({
      folder: { kind: 'configured', root: ROOT },
    })
    await reach()
    await seeing('~/code/shop already has a .phada/ folder')
    expect(footer()).toContain('Enter continue')
    await press(KEYS.enter)
    await seeing('Step 7 of 7 · Summary')
    expect(inits()).toBe(0)
  })

  it('says the folder is outside a git repository and goes on', async () => {
    const { inits, press, reach, seeing } = openRepositoryStep({ folder: { kind: 'outside' } })
    await reach()
    await seeing('~/code/shop is not inside a git repository')
    await press(KEYS.enter)
    await seeing('Step 7 of 7 · Summary')
    expect(inits()).toBe(0)
  })

  it('shows a failed init in one line and lets the setup go on', async () => {
    const { footer, press, reach, seeing } = openRepositoryStep({
      init: async () => {
        throw new Error('EACCES: permission denied, mkdir .phada')
      },
    })
    await reach()
    await seeing('has no .phada/ folder')
    await press(KEYS.enter)
    await seeing('EACCES: permission denied')
    expect(footer()).toContain('Enter continue')
    await press(KEYS.enter)
    await seeing('Step 7 of 7 · Summary')
  })

  it('speaks pt', async () => {
    const { press, seeing } = openRepositoryStep({ language: 'pt' })
    await seeing(/ 1 de 7 · GitHub/)
    await press('s', 's', 's', 's', 's')
    await seeing('Passo 6 de 7 · Este repositório', '~/code/shop não tem uma pasta .phada/')
    await press(KEYS.enter)
    await seeing('Criado .phada/config.yml', '.phada/rules.md já existe, mantido')
  })
})
