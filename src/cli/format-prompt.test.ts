import { describe, expect, it } from 'vitest'
import type { PromptView } from '../app/inspect-prompt.js'
import { formatPromptJson, formatPromptText } from './format-prompt.js'

const VIEW: PromptView = {
  pullRequest: {
    repo: 'acme/shop',
    number: 12,
    baseSha: '1234567890abcdef1234567890abcdef12345678',
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  },
  passes: [
    {
      skill: 'phada',
      origin: 'phada',
      status: 'planned',
      parts: [
        { section: 'lens', origin: 'phada', text: 'You are a senior engineer.' },
        { section: 'contract', origin: 'phada', text: 'Answer in JSON.' },
      ],
      data: [
        { name: 'PHADA_PR', bytes: 300 },
        { name: 'PHADA_DIFF', bytes: 12_595 },
      ],
    },
    {
      skill: 'sec',
      origin: '/s/sec/SKILL.md',
      status: 'skipped',
      reason: 'no changed file matches src/auth/**',
      parts: [],
      data: [],
    },
  ],
  notes: ['A note.'],
  warnings: ['A warning.'],
}

describe('formatPromptText', () => {
  it('prints each pass with the origin of each part and the data blocks', () => {
    expect(formatPromptText(VIEW)).toBe(
      [
        'Prompt for acme/shop#12 at a1b2c3d (base 1234567)',
        'A note.',
        'Warning: A warning.',
        '',
        '## Pass 1: phada (built-in)',
        '',
        '### lens — phada',
        '',
        'You are a senior engineer.',
        '',
        '### contract — phada',
        '',
        'Answer in JSON.',
        '',
        'Data blocks:',
        '  PHADA_PR    300 B',
        '  PHADA_DIFF  12.3 KB',
        '',
        '## Pass 2: sec (/s/sec/SKILL.md) — skipped: no changed file matches src/auth/**',
        '',
      ].join('\n'),
    )
  })

  it('names the built-in prompt without a pull request', () => {
    expect(formatPromptText({ ...VIEW, pullRequest: null }).split('\n')[0]).toBe(
      'Built-in prompt, without a pull request',
    )
  })
})

describe('formatPromptJson', () => {
  it('prints the view with a schema version', () => {
    const parsed = JSON.parse(formatPromptJson(VIEW)) as Record<string, unknown>

    expect(parsed).toEqual({ schemaVersion: 1, ...JSON.parse(JSON.stringify(VIEW)) })
  })
})
