import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { HookSettings } from '../config/watch-settings.js'
import type { ReviewEvent } from './review-event.js'
import { runHook } from './run-hook.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-hooks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const EVENT: ReviewEvent = {
  schemaVersion: 1,
  event: 'review.finished',
  job: { id: 1, repo: 'acme/shop', number: 12, headSha: 'a', url: 'https://x' },
  requests: [],
  verdict: 'clean',
  ci: null,
  publication: null,
}
const settings = (commands: HookSettings['commands'], timeoutMs = 5_000): HookSettings => ({
  commands,
  timeoutMs,
  cwd: dir,
})
const ENV = { PATH: process.env.PATH, PHADA_TEST_VALUE: 'from-env' }

describe('runHook', () => {
  it('runs the command of the event in the config folder with the event JSON on stdin', async () => {
    writeFileSync(join(dir, 'notify.sh'), 'cat > event.json\necho "$PHADA_TEST_VALUE" > env.txt\n')

    expect(
      await runHook(EVENT, settings({ 'review.finished': 'sh ./notify.sh' }), ENV),
    ).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8'))).toEqual(EVENT)
    expect(readFileSync(join(dir, 'env.txt'), 'utf8')).toBe('from-env\n')
  })

  it('does nothing for an event without a command', async () => {
    expect(await runHook(EVENT, settings({ 'review.failed': 'exit 1' }), ENV)).toBeUndefined()
  })

  it('reports a command that exits with another code, with the first line it wrote', async () => {
    expect(
      await runHook(
        EVENT,
        settings({ 'review.finished': 'echo "no webhook url" >&2; echo more >&2; exit 3' }),
        ENV,
      ),
    ).toBe('The review.finished hook exited with 3: no webhook url')
  })

  it('reports and stops a command that takes too long', async () => {
    const started = Date.now()
    expect(await runHook(EVENT, settings({ 'review.finished': 'sleep 5' }, 300), ENV)).toBe(
      'The review.finished hook did not finish within 0.3s and was stopped',
    )
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
