import { describe, expect, it } from 'vitest'
import { sleepUntilNewJob } from './queue-wake.js'

describe('sleepUntilNewJob', () => {
  it('sleeps the whole time in steps when nothing new is ready', async () => {
    const sleeps: number[] = []
    await sleepUntilNewJob(25_000, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      readyJobs: () => [3],
      stopped: () => false,
    })
    expect(sleeps).toEqual([10_000, 10_000, 5_000])
  })

  it('wakes up once a job that was not ready before is ready', async () => {
    const sleeps: number[] = []
    let ready = [3]
    await sleepUntilNewJob(60_000, {
      sleep: async (ms) => {
        sleeps.push(ms)
        if (sleeps.length === 2) ready = [3, 4]
      },
      readyJobs: () => ready,
      stopped: () => false,
    })
    expect(sleeps).toEqual([10_000, 10_000])
  })

  it('stops sleeping once the watch is asked to stop', async () => {
    const sleeps: number[] = []
    await sleepUntilNewJob(60_000, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      readyJobs: () => [],
      stopped: () => sleeps.length === 1,
    })
    expect(sleeps).toEqual([10_000])
  })
})
