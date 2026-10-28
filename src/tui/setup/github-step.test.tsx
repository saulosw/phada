import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubAccess } from '../../app/read-home.js'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../../test/support/tui.js'
import type { AppDeps, HandOffResult, HandOffTarget } from '../app-context.js'

const FOUND: GitHubAccess = { source: 'gh', account: { state: 'found', login: 'ana' } }

function openGitHubStep(
  options: {
    access?: GitHubAccess[]
    handOff?: HandOffResult
    language?: string
  } = {},
) {
  const accesses = [...(options.access ?? [FOUND])]
  const handOffs: HandOffTarget[] = []
  const deps: Partial<AppDeps> = {
    start: 'setup',
    readGitHub: async () => (accesses.length > 1 ? accesses.shift() : accesses[0]) ?? FOUND,
    handOff: async (target) => {
      handOffs.push(target)
      return options.handOff ?? { kind: 'exited', exitCode: 0 }
    },
    ...(options.language === undefined ? {} : { language: options.language }),
  }
  const app = renderApp({ deps, size: { columns: 80, rows: 24 } })
  const seeing = async (...expected: string[]) => {
    await app.showing(...expected)
    for (const text of expected) expect(app.frame()).toContain(text)
  }
  return { ...app, seeing, handOffs }
}

function expectFits(frame: string) {
  for (const line of frameLines(frame)) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the GitHub step', () => {
  it('shows where the token comes from and its owner, and continues on Enter', async () => {
    const { footer, press, seeing } = openGitHubStep()
    await seeing('Token from gh login · @ana')
    expect(footer()).toContain('Enter continue')
    await press(KEYS.enter)
    await seeing('Step 2 of 7')
  })

  it('explains a missing token and logs in with gh, checking again on return', async () => {
    const { footer, frame, press, seeing, handOffs } = openGitHubStep({
      access: [{ source: null }, FOUND],
    })
    await seeing('No GitHub token')
    expect(frame()).toContain('GITHUB_TOKEN')
    expect(footer()).toContain('Enter log in with gh')
    await press(KEYS.enter)
    await seeing('Token from gh login · @ana')
    expect(handOffs).toEqual([{ kind: 'command', command: 'gh', args: ['auth', 'login'] }])
    expect(frame()).toContain('Step 1 of 7')
  })

  it('says how to install gh or export GITHUB_TOKEN when gh is missing', async () => {
    const { frame, press, seeing } = openGitHubStep({
      access: [{ source: null }],
      handOff: { kind: 'not-found', command: 'gh' },
    })
    await seeing('No GitHub token')
    await press(KEYS.enter)
    await seeing('gh is not installed')
    expect(frame()).toContain('https://cli.github.com')
    expect(frame()).toMatch(/export\s+GITHUB_TOKEN/)
    expectFits(frame())
  })

  it('says the login did not complete when gh exits with an error', async () => {
    const { press, seeing } = openGitHubStep({
      access: [{ source: null }],
      handOff: { kind: 'exited', exitCode: 130 },
    })
    await seeing('No GitHub token')
    await press(KEYS.enter)
    await seeing('gh login not completed.')
  })

  it('offers to log in again when GitHub refuses the token of gh', async () => {
    const { footer, press, seeing, handOffs } = openGitHubStep({
      access: [{ source: 'gh', account: { state: 'refused' } }, FOUND],
    })
    await seeing('GitHub refused the token from gh login.')
    expect(footer()).toContain('Enter log in with gh')
    await press(KEYS.enter)
    await seeing('Token from gh login · @ana')
    expect(handOffs).toHaveLength(1)
  })

  it('asks to replace a refused token of a variable, which a gh login would not change', async () => {
    const { footer, frame, press, seeing, handOffs } = openGitHubStep({
      access: [{ source: 'GITHUB_TOKEN', account: { state: 'refused' } }],
    })
    await seeing('GitHub refused the token from GITHUB_TOKEN.')
    expect(frame()).toContain('unset it')
    expect(footer()).toContain('Enter continue')
    await press(KEYS.enter)
    await seeing('Step 2 of 7')
    expect(handOffs).toEqual([])
  })

  it('shows a failure to reach GitHub and reads again on r', async () => {
    const { footer, press, seeing } = openGitHubStep({
      access: [
        { source: 'GH_TOKEN', account: { state: 'failed', error: 'getaddrinfo ENOTFOUND' } },
        FOUND,
      ],
    })
    await seeing('Could not reach GitHub: getaddrinfo ENOTFOUND')
    expect(footer()).toContain('r refresh')
    await press('r')
    await seeing('Token from gh login · @ana')
  })

  it.each([
    ['pt', 'Nenhum token do GitHub', 'Enter entrar com o gh'],
    ['es', 'Ningún token de GitHub', 'Enter iniciar sesión con gh'],
  ])('speaks %s', async (language, title, key) => {
    const { footer, frame, seeing } = openGitHubStep({ access: [{ source: null }], language })
    await seeing(title)
    expect(footer()).toContain(key)
    expectFits(frame())
  })
})
