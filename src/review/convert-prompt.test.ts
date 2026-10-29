import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { buildConvertPrompt, CONVERT_ROLE } from './convert-prompt.js'
import { annotateDiff } from './diff-lines.js'
import { REVIEW_REPORT_JSON_SCHEMA } from './report-schema.js'
import type { SkillPass } from './types.js'

const PASS: SkillPass = {
  skill: 'code-review:code-review',
  mode: 'native',
  lens: { kind: 'skill', name: 'code-review:code-review', text: 'Five agents.', origin: '/p' },
}

describe('buildConvertPrompt', () => {
  const prompt = buildConvertPrompt(
    { pullRequest: pullRequestFixture() },
    'abcdefabcdef',
    PASS,
    'Found 1 issue.',
  )

  it('asks to rewrite the skill output in Phada report without a reviewer lens or tools', () => {
    expect(prompt.instructions.startsWith(CONVERT_ROLE('code-review:code-review'))).toBe(true)
    expect(prompt.instructions).toContain('Never add an issue the output does not raise')
    expect(prompt.instructions).toContain('never leave out one it raises')
    expect(prompt.instructions).not.toContain('You are a senior engineer')
    expect(prompt.instructions).not.toContain('Five agents.')
    expect(prompt.tools).toBeUndefined()
    expect(prompt.outputSchema).toBe(REVIEW_REPORT_JSON_SCHEMA)
  })

  it('sends the pull request, the annotated diff and the skill output as delimited data', () => {
    expect(prompt.data).toContain('<<<PHADA_PR_abcdefabcdef')
    expect(prompt.data).toContain(
      `<<<PHADA_DIFF_abcdefabcdef\n${annotateDiff(pullRequestFixture().diff)}`,
    )
    expect(prompt.data).toContain(
      '<<<PHADA_SKILL_OUTPUT_abcdefabcdef\nFound 1 issue.\nPHADA_SKILL_OUTPUT_abcdefabcdef>>>',
    )
    expect(prompt.data.indexOf('PHADA_DIFF')).toBeLessThan(
      prompt.data.indexOf('PHADA_SKILL_OUTPUT'),
    )
  })

  it('takes the verdict of each claim of the description from the output alone', () => {
    expect(prompt.instructions).toContain('"claims": [{"claim": "...", "verdict": "unverified"')
    expect(prompt.instructions).toContain(
      '- claims: each concrete, checkable thing the title or description of the pull',
    )
    expect(prompt.instructions).toContain('The verdict comes from the output alone')
    expect(prompt.instructions).toContain('"not checked by the guide"')
  })

  it('asks for the review language', () => {
    const translated = buildConvertPrompt(
      { pullRequest: pullRequestFixture(), language: 'pt-BR' },
      'abcdefabcdef',
      PASS,
      'x',
    )
    expect(translated.instructions).toContain('in pt-BR')
  })

  it('keeps its fixed text', () => {
    expect(createHash('sha256').update(prompt.instructions).digest('hex')).toBe(
      'aabc4f4c89f0a6794681d830f75f24cb299c8248d8d700e32c52a3d1062e9c71',
    )
  })
})
