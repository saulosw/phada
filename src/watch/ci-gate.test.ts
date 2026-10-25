import { describe, expect, it } from 'vitest'
import type { CiState } from '../publish/types.js'
import { ciGate } from './ci-gate.js'

const SEEN = '2026-10-18T12:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(SEEN) + minutes * 60_000).toISOString()
const ci = (state: CiState, pending: string[] = [], failing: string[] = []) => ({
  state,
  pending,
  failing,
})
const base = { waitMs: 15 * 60_000, onFailure: 'review' as const, seenAt: SEEN }

describe('ciGate', () => {
  it.each([
    {
      name: 'waits for checks to appear in the first 2 minutes',
      input: { ci: ci('none'), now: at(1) },
      gate: { action: 'wait', until: at(2), deadline: at(2), pending: [] },
    },
    {
      name: 'reviews a commit without checks 2 minutes after seeing it',
      input: { ci: ci('none'), now: at(2) },
      gate: { action: 'review' },
    },
    {
      name: 'waits for checks to appear no longer than ci.wait',
      input: { ci: ci('none'), now: at(0.5), waitMs: 60_000 },
      gate: { action: 'wait', until: at(1), deadline: at(1), pending: [] },
    },
    {
      name: 'reads pending checks again in a minute',
      input: { ci: ci('pending', ['test', 'build']), now: at(3) },
      gate: { action: 'wait', until: at(4), deadline: at(15), pending: ['test', 'build'] },
    },
    {
      name: 'reads pending checks again at the deadline when it comes sooner',
      input: { ci: ci('pending', ['test']), now: at(14.5) },
      gate: { action: 'wait', until: at(15), deadline: at(15), pending: ['test'] },
    },
    {
      name: 'reviews with the pending checks once the deadline passed',
      input: { ci: ci('pending', ['e2e']), now: at(15) },
      gate: { action: 'review', pending: ['e2e'] },
    },
    {
      name: 'reviews a commit whose checks passed',
      input: { ci: ci('passing'), now: at(1) },
      gate: { action: 'review' },
    },
    {
      name: 'reviews a failing commit with onFailure review',
      input: { ci: ci('failing', ['e2e'], ['test']), now: at(3) },
      gate: { action: 'review', pending: ['e2e'] },
    },
    {
      name: 'skips a failing commit with onFailure skip',
      input: { ci: ci('failing', [], ['test', 'lint']), now: at(3), onFailure: 'skip' as const },
      gate: { action: 'skip', failing: ['test', 'lint'] },
    },
    {
      name: 'reviews a passing commit with onFailure skip',
      input: { ci: ci('passing'), now: at(3), onFailure: 'skip' as const },
      gate: { action: 'review' },
    },
  ])('$name', ({ input, gate }) => {
    expect(ciGate({ ...base, ...input })).toEqual(gate)
  })
})
