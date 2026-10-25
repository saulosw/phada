import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { ConfigError } from '../config/errors.js'
import type { AppDeps, AppHost, AppResult } from '../tui/open-app.js'
import { runApp } from './app-command.js'
import type { AppCommandDeps } from './app-command.js'
import { UsageError } from './errors.js'

function terminal(isTTY: boolean) {
  return {
    stdin: Object.assign(Readable.from([]), { isTTY }),
    stdout: { write: () => true, isTTY },
  }
}

function deps(
  options: {
    stdin?: boolean
    stdout?: boolean
    config?: string
    result?: AppResult
  } = {},
) {
  const opened: { deps: AppDeps; host: AppHost }[] = []
  const app: AppCommandDeps = {
    env: { PHADA_CONFIG_HOME: '/cfg', TERM: 'xterm' },
    home: '/home/ana',
    cwd: '/home/ana/shop',
    version: '1.2.3',
    files: memoryFiles(options.config === undefined ? {} : { '/cfg/config.yml': options.config }),
    stdin: terminal(options.stdin ?? true).stdin,
    stdout: terminal(options.stdout ?? true).stdout,
    onSignal: () => {},
    loadApp: async () => ({
      openApp: async (appDeps, host) => {
        opened.push({ deps: appDeps, host })
        return options.result ?? { kind: 'quit' }
      },
    }),
  }
  return { app, opened }
}

const MISSING = new UsageError('Missing the command, e.g. phada review owner/repo#123.')

describe('runApp', () => {
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    'keeps the error of a missing command when stdin is a TTY: %s, stdout: %s',
    async (stdin, stdout) => {
      const { app, opened } = deps({ stdin, stdout })
      await expect(runApp(app)).rejects.toEqual(MISSING)
      expect(opened).toEqual([])
    },
  )

  it('opens the app in a terminal with the version, the folder and the signals', async () => {
    const { app, opened } = deps()
    expect(await runApp(app)).toBe(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.deps).toMatchObject({
      version: '1.2.3',
      cwd: '/home/ana/shop',
      home: '/home/ana',
      env: { TERM: 'xterm' },
    })
    expect(opened[0]?.deps).not.toHaveProperty('language')
    expect(opened[0]?.host.stdin).toBe(app.stdin)
    expect(opened[0]?.host.stdout).toBe(app.stdout)
    expect(opened[0]?.host.onSignal).toBe(app.onSignal)
  })

  it('passes the language of the user config', async () => {
    const { app, opened } = deps({ config: 'language: pt-BR\n' })
    await runApp(app)
    expect(opened[0]?.deps.language).toBe('pt-BR')
  })

  it('still opens with an invalid user config, keeping its error for the screens', async () => {
    const { app, opened } = deps({ config: 'language: [1\n' })
    expect(await runApp(app)).toBe(0)
    expect(opened[0]?.deps.language).toBeUndefined()
    expect(opened[0]?.deps.configError).toBeInstanceOf(ConfigError)
  })

  it.each([
    [{ kind: 'quit' }, 0],
    [{ kind: 'interrupted' }, 130],
    [{ kind: 'terminated' }, 143],
  ] as const)('turns %j into the exit code %d', async (result, code) => {
    expect(await runApp(deps({ result }).app)).toBe(code)
  })

  it('throws the error the app failed with, after it closed', async () => {
    const failure = new Error('boom')
    await expect(runApp(deps({ result: { kind: 'failed', error: failure } }).app)).rejects.toBe(
      failure,
    )
  })

  it('ticks a real scheduler until it is stopped', async () => {
    const { app, opened } = deps()
    await runApp(app)
    const ticks: number[] = []
    const stop = opened[0]?.deps.scheduler.every(1, () => ticks.push(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop?.()
    const seen = ticks.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toBeGreaterThan(0)
    expect(ticks).toHaveLength(seen)
  })
})
