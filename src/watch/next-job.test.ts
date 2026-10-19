import { describe, expect, it } from 'vitest'
import type { JobRecord } from '../store/history-store.js'
import { pickNext } from './next-job.js'

const NOW = '2026-10-18T12:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString()
const job = (id: number, notBefore: string): JobRecord => ({
  id,
  repo: 'acme/shop',
  number: id,
  headSha: 'a'.repeat(40),
  status: 'queued',
  attempts: 0,
  notBefore,
  createdAt: at(-10),
})
const base = { now: NOW, watchRunsLastHour: [], maxPerHour: 6 }

describe('pickNext', () => {
  it('takes the job that became ready first', () => {
    const queued = [job(1, at(-1)), job(2, at(-3)), job(3, at(5))]

    expect(pickNext({ ...base, queued })).toEqual({ job: queued[1] })
  })

  it('waits for the first job that is not ready yet', () => {
    expect(pickNext({ ...base, queued: [job(1, at(5)), job(2, at(2))] })).toEqual({
      waitUntil: at(2),
    })
  })

  it('waits for the end of a pause', () => {
    const pause = { until: at(15), reason: 'usage-limit', streak: 1 }

    expect(pickNext({ ...base, queued: [job(1, at(-1))], pause })).toEqual({ waitUntil: at(15) })
  })

  it('ignores a pause that is over', () => {
    const pause = { until: at(-1), reason: 'usage-limit', streak: 1 }
    const queued = [job(1, at(-1))]

    expect(pickNext({ ...base, queued, pause })).toEqual({ job: queued[0] })
  })

  it('waits until the oldest review of the last hour leaves the window', () => {
    const watchRunsLastHour = [at(-50), at(-40)]

    expect(
      pickNext({ ...base, queued: [job(1, at(-1))], watchRunsLastHour, maxPerHour: 2 }),
    ).toEqual({ waitUntil: at(10) })
  })

  it('has nothing to wait for with an empty queue', () => {
    expect(pickNext({ ...base, queued: [] })).toEqual({})
  })
})
