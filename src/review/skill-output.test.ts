import { describe, expect, it } from 'vitest'
import { SKILL_OUTPUT_LIMIT_BYTES, skillBodyText, skillOutputText } from './skill-output.js'
import type { NativeSkillRun } from './types.js'

const run = (overrides: Partial<NativeSkillRun> = {}): NativeSkillRun => ({
  text: 'Found 1 issue.',
  captured: [],
  durationMs: 10,
  blocked: [],
  ...overrides,
})

describe('skillOutputText', () => {
  it('puts the captured writes before the final answer', () => {
    const text = skillOutputText(
      run({
        captured: [
          {
            command: 'gh pr comment',
            body: '### Code review\n1. spend ignores the balance',
            comments: [{ path: 'src/shop.ts', line: 3, body: 'Check the balance.' }],
          },
        ],
      }),
    )

    expect(text).toBe(
      [
        '--- gh pr comment ---',
        '### Code review\n1. spend ignores the balance',
        'src/shop.ts:3: Check the balance.',
        '--- final answer ---',
        'Found 1 issue.',
      ].join('\n'),
    )
  })

  it('shows a line range of a captured comment', () => {
    const text = skillOutputText(
      run({
        captured: [
          {
            command: 'gh api',
            body: '',
            comments: [{ path: 'a.ts', startLine: 2, line: 4, body: 'x' }],
          },
        ],
      }),
    )

    expect(text).toContain('a.ts:2-4: x')
  })

  it('cuts an output over 64 KB without splitting a character', () => {
    const text = skillOutputText(run({ text: 'é'.repeat(SKILL_OUTPUT_LIMIT_BYTES) }))

    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(SKILL_OUTPUT_LIMIT_BYTES + 40)
    expect(text.endsWith('\n[cut by Phada at 64 KB]')).toBe(true)
    expect(text).not.toContain('�')
  })
})

describe('skillBodyText', () => {
  it('is what the skill tried to publish, or its final answer', () => {
    expect(skillBodyText(run())).toBe('Found 1 issue.')
    expect(
      skillBodyText(
        run({ captured: [{ command: 'gh pr comment', body: 'Posted body.', comments: [] }] }),
      ),
    ).toBe('Posted body.')
  })
})
