import { Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { QueueView } from '../app/read-queue.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import type { ReviewProgress } from '../app/review-progress.js'
import type { WatchEnd, WatchEvent, WatchObserver } from '../app/watch-event.js'
import {
  emptyQueue,
  flatFrame,
  frameLines,
  KEYS,
  minutesFrom,
  NOW,
  renderApp,
  visibleWidth,
} from '../../test/support/tui.js'
import type { AppDeps } from './app-context.js'
import { QueueScreen } from './screens/queue.js'
import type { ScreenDefinition } from './screens.js'

afterEach(() => cleanup())

type Job = Parameters<WatchObserver['progress']>[0]

const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'
const JOB: Job = {
  id: 12,
  repo: 'acme/shop',
  number: 12,
  headSha: SHA,
  status: 'running',
  attempts: 0,
  notBefore: minutesFrom(NOW, 1),
  createdAt: minutesFrom(NOW, -1),
  startedAt: minutesFrom(NOW, 0),
}

const SCREENS: readonly ScreenDefinition[] = [
  { id: 'queue', title: (m) => m.screens.queue, Screen: QueueScreen },
  { id: 'reviews', title: (m) => m.screens.reviews, Screen: () => <Text>another screen</Text> },
]

function fakeWatch(options: { fail?: unknown; elsewhere?: number } = {}) {
  const calls: string[] = []
  let observer: WatchObserver | undefined
  let end: (value: WatchEnd) => void = () => undefined
  const startWatch: AppDeps['startWatch'] = async (given) => {
    calls.push('start')
    if (options.fail !== undefined) throw options.fail
    if (options.elsewhere !== undefined) return { status: 'elsewhere', pid: options.elsewhere }
    observer = given
    const done = new Promise<WatchEnd>((resolve) => {
      end = resolve
    })
    return {
      status: 'started',
      control: {
        done,
        stop: () => calls.push('stop'),
        abort: () => {
          calls.push('abort')
          end({ reason: 'aborted' })
        },
      },
    }
  }
  return {
    startWatch,
    calls,
    emit: (event: WatchEvent) => observer?.event(event),
    progress: (job: Job, event: ReviewProgress) => observer?.progress(job, event),
    end: (value: WatchEnd) => end(value),
  }
}

function openWatch(
  options: {
    watch?: ReturnType<typeof fakeWatch>
    queue?: () => QueueView
    language?: string
  } = {},
) {
  const watch = options.watch ?? fakeWatch()
  const app = renderApp({
    deps: {
      startWatch: watch.startWatch,
      readQueue: async () => (options.queue ?? (() => ({ ...emptyQueue(), recorded: true })))(),
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: { columns: 80, rows: 24 },
    screens: SCREENS,
  })
  return { ...app, watch }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

function published(url: string): ReviewRun {
  return {
    status: 'reviewed',
    publication: { status: 'published', url, resolved: { resolved: [], failed: [] } },
  } as unknown as ReviewRun
}

describe('the watch of the app', () => {
  it('starts the watch with w and logs its events with the time, in 80×24', async () => {
    const watch = fakeWatch()
    let running = false
    const { frame, press, showing, clock } = openWatch({
      watch,
      queue: () => ({
        ...emptyQueue(),
        recorded: true,
        holder: running ? { pid: 1000 } : null,
        running: running ? [{ job: JOB, requests: [] }] : [],
      }),
    })
    await showing('Watch not running · w starts it', 'w start the watch')
    expect(frame()).toContain('w start the watch')

    await press('w')
    await showing('Watch running in this app', 'Watch started in this app.')
    expect(watch.calls).toEqual(['start'])
    expect(frame()).toMatch(/\d{2}:\d{2}:\d{2} Watch started in this app\./)

    watch.emit({ kind: 'queued', job: { ...JOB, status: 'queued' } })
    watch.emit({ kind: 'started', job: JOB })
    running = true
    clock.advance(2000)
    watch.progress(JOB, { kind: 'aiStarted', provider: 'claude', run: 'review' })
    await showing('Reviewing acme/shop#12 at a1b2c3d…', 'claude: review')
    expect(frame()).toMatch(/\d{2}:\d{2}:\d{2} Queued acme\/shop#12 at a1b2c3d; review after/)
    const row = frameLines(frame()).find((line) => /running\s+acme\/shop#12/.test(line)) ?? ''
    expect(row).toContain('claude: review · 0s')

    watch.emit({
      kind: 'finished',
      job: JOB,
      run: published('https://github.com/acme/shop/pull/12#review-1'),
    })
    watch.emit({ kind: 'warning', message: 'hook\u0007 \u202efailed' })
    await showing('Published acme/shop#12', 'Warning: hook')
    expect(frame()).toContain('Warning: hook failed')
    expectFits(frame())
  })

  it('keeps the log while another tab is open', async () => {
    const { frame, press, showing, watch } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('Watch started in this app.')
    await press('2')
    await showing('another screen')
    expect(frame()).toContain('another screen')
    watch.emit({ kind: 'indexPartial', repo: 'acme/shop' })
    await press('1')
    await showing('acme/shop: indexing the default branch')
    expect(frame()).toContain('Watch started in this app.')
    expect(frame()).toContain('acme/shop: indexing the default branch')
  })

  it('keeps the last 200 lines of the log and scrolls them on l', async () => {
    const { frame, press, showing, watch } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('Watch started in this app.')
    for (let line = 1; line <= 250; line += 1) {
      watch.emit({ kind: 'warning', message: `note ${String(line).padStart(3, '0')}` })
    }
    await showing('note 250', 'l log')
    await press('l')
    await showing(/\d+–200 of 200/, 'Esc back')
    expect(frame()).toContain('note 250')
    expectFits(frame())
    await press(KEYS.home)
    await showing(/1–\d+ of 200/)
    expect(frame()).toContain('note 051')
    expect(frame()).not.toContain('note 050')
    expect(frame()).not.toContain('Watch started in this app.')
    await press(KEYS.escape)
    await showing('w stop the watch')
    expect(frame()).toContain('Watch running in this app')
  })

  it('says a watch of another terminal runs there and leaves it alone on w', async () => {
    const { footer, frame, press, showing, watch } = openWatch({
      queue: () => ({ ...emptyQueue(), recorded: true, holder: { pid: 4242 } }),
    })
    await showing('Watch running in another terminal · PID 4242')
    expect(footer()).not.toContain('start the watch')
    await press('w')
    await showing('The watch is running in another terminal (PID 4242).')
    expect(frame()).toContain('The watch is running in another terminal (PID 4242).')
    expect(watch.calls).toEqual([])
  })

  it('says it when the lock was taken while it started', async () => {
    const { frame, press, showing } = openWatch({ watch: fakeWatch({ elsewhere: 777 }) })
    await showing('w start the watch')
    await press('w')
    await showing('(PID 777)')
    expect(frame()).toContain('The watch is running in another terminal (PID 777).')
    expect(frame()).toContain('Watch not running')
  })

  it('shows what kept the watch from starting, wrapped so the key and the reason show', async () => {
    const { frame, press, showing } = openWatch({
      watch: fakeWatch({
        fail: new Error(
          'Invalid config /home/ana/.config/phada/config.yml: watch.repos.0.repo: \u001B[2Jexpected owner/repo, got "acme"',
        ),
      }),
    })
    await showing('w start the watch')
    await press('w')
    await showing('The watch did not start')
    expect(flatFrame(frame())).toContain(
      'The watch did not start: Invalid config /home/ana/.config/phada/config.yml: watch.repos.0.repo: [2Jexpected owner/repo, got "acme"',
    )
    expect(frame()).not.toContain('\u001B[2J')
    expect(frame()).toContain('Watch not running')
    expectFits(frame())
  })

  it('wraps a long line of the log in full on l', async () => {
    const { frame, press, showing, watch } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('Watch started in this app.')
    watch.emit({
      kind: 'failed',
      job: JOB,
      error: new Error(
        'The AI CLI ended with exit code 1 after printing a long explanation of what went wrong with the review of this pull request',
      ),
    })
    await showing('l log')
    await press('l')
    await showing('Esc back')
    expect(flatFrame(frame())).toContain('what went wrong with the review of this pull request')
    expectFits(frame())
  })

  it('asks before stopping it: Esc keeps it running, Enter stops it after the current review', async () => {
    const { frame, press, showing, watch } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('w stop the watch')
    await press('w')
    await showing('Stop the watch after the current review?', 'Enter stop after the review')
    expect(frame()).toContain('Esc keep it running')
    await press(KEYS.escape)
    await showing('w stop the watch')
    expect(frame()).not.toContain('Stop the watch after the current review?')
    expect(watch.calls).toEqual(['start'])

    await press('w')
    await showing('Stop the watch after the current review?')
    await press(KEYS.enter)
    await showing('Stopping after the current review…')
    expect(watch.calls).toEqual(['start', 'stop'])
    watch.end({ reason: 'stopped' })
    await showing('Watch stopped.', 'Watch not running')
    expect(frame()).toContain('Watch not running')
    expect(frame()).toContain('w start the watch')
  })

  it('shows the watch ending on an error in its log', async () => {
    const { frame, press, showing, watch } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('Watch started in this app.')
    watch.end({ reason: 'fatal', error: new Error('history.sqlite is locked') })
    await showing('The watch stopped: history.sqlite is locked')
    expect(frame()).toContain('Watch not running')
  })

  it('asks before quitting while it runs, and quits once the current review ended', async () => {
    const { frame, press, showing, until, watch, exits } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('Watch running in this app')
    await press('q')
    await showing('The watch is running: stop it after the current review and quit?')
    expectFits(frame())
    await press(KEYS.escape)
    await showing('Watch running in this app')
    expect(exits).toEqual([])
    await press('q')
    await showing('stop it after the current review and quit?')
    await press(KEYS.enter)
    await showing('Stopping…')
    expect(watch.calls).toEqual(['start', 'stop'])
    expect(exits).toEqual([])
    watch.end({ reason: 'stopped' })
    await until(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('aborts it and quits at once on a second Ctrl-C', async () => {
    const { press, showing, until, watch, exits } = openWatch()
    await showing('w start the watch')
    await press('w')
    await showing('Watch running in this app')
    await press(KEYS.ctrlC)
    await showing('stop it after the current review and quit?')
    await press(KEYS.ctrlC)
    await until(() => exits.length > 0)
    expect(watch.calls).toEqual(['start', 'abort'])
    expect(exits).toEqual([{ kind: 'interrupted' }])
  })

  it('starts and stops it from /watch in the palette, on the Queue', async () => {
    const { frame, press, type, showing, watch } = openWatch()
    await showing('w start the watch')
    await press('2')
    await showing('another screen')
    await press('/')
    await type('watch')
    await showing('Start or stop the watch')
    await press(KEYS.enter)
    await showing('Watch running in this app')
    expect(watch.calls).toEqual(['start'])
    await press('2')
    await showing('another screen')
    await press('/')
    await type('watch')
    await showing('Start or stop the watch')
    await press(KEYS.enter)
    await showing('Stop the watch after the current review?')
    expect(frame()).toContain('Stop the watch after the current review?')
  })

  it('follows the lock as it changes owner', async () => {
    let holder: { pid: number } | null = null
    const { frame, clock, showing } = openWatch({
      queue: () => ({ ...emptyQueue(), recorded: true, holder }),
    })
    await showing('Watch not running')
    holder = { pid: 4242 }
    clock.advance(2000)
    await showing('Watch running in another terminal · PID 4242')
    expect(frame()).toContain('Watch running in another terminal · PID 4242')
    holder = null
    clock.advance(2000)
    await showing('Watch not running')
    expect(frame()).toContain('Watch not running · w starts it')
  })

  it.each([
    [
      'pt',
      'Watch rodando neste app',
      'Na fila: acme/shop#12 em a1b2c3d',
      'Parar o watch depois do review atual?',
    ],
    [
      'es',
      'Watch en marcha en esta app',
      'En la cola: acme/shop#12 en a1b2c3d',
      '¿Detener el watch después de la revisión actual?',
    ],
  ])('is translated to %s', async (language, header, logLine, question) => {
    const { frame, press, showing, watch } = openWatch({ language })
    await showing('w ')
    await press('w')
    await showing(header)
    watch.emit({ kind: 'queued', job: { ...JOB, status: 'queued' } })
    await showing(logLine)
    expect(frame()).toContain(logLine)
    await press('w')
    await showing(question)
    expect(frame()).toContain(question)
    expectFits(frame())
  })
})
