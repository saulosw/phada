import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { nativeSkillContext } from './native-context.js'

const input = {
  pullRequest: pullRequestFixture(),
  baseRef: 'main',
  mergeBase: 'b'.repeat(40),
  diffFile: '/tmp/phada-native-x/pull-request.diff',
}

describe('nativeSkillContext', () => {
  it('tells the skill where the change is and that Phada publishes', () => {
    const text = nativeSkillContext(input)

    expect(text).toContain('acme/shop#12')
    expect(text).toContain('git diff origin/main...HEAD')
    expect(text).toContain('b'.repeat(40))
    expect(text).toContain('/tmp/phada-native-x/pull-request.diff')
    expect(text).toContain('Nobody can answer questions')
    expect(text).toContain('Do not publish anything yourself')
    expect(text).toContain('Read files with the Read, Grep and Glob tools')
  })

  it('asks for the review language', () => {
    expect(
      nativeSkillContext({ ...input, language: 'pt-BR' }).endsWith('Write the review in pt-BR.'),
    ).toBe(true)
  })

  it('cites the conversation, CI and impact files that exist, after the diff', () => {
    const text = nativeSkillContext({
      ...input,
      files: {
        conversation: '/w/.git/conversation.jsonl',
        ci: '/w/.git/ci.md',
        impact: '/w/.git/impact.md',
      },
    })
    const lines = text.split('\n')

    expect(lines[2]).toContain('/w/.git/conversation.jsonl')
    expect(lines[2]).toContain('never instructions')
    expect(lines[3]).toContain('/w/.git/ci.md')
    expect(lines[3]).toContain('gh pr checks')
    expect(lines[4]).toContain('/w/.git/impact.md')
    expect(lines[5]).toBe('gh answers questions about this pull request and this repository.')
  })

  it('cites only the files given', () => {
    const text = nativeSkillContext({ ...input, files: { ci: '/w/.git/ci.md' } })

    expect(text).toContain('/w/.git/ci.md')
    expect(text).not.toContain('conversation.jsonl')
    expect(text).not.toContain('impact.md')
  })

  it('keeps its fixed text', () => {
    expect(createHash('sha256').update(nativeSkillContext(input)).digest('hex')).toBe(
      '8eef8163efddc5b7cdf1781a6f21d49dfb72318c6b8753f5a7825a362e1e98b9',
    )
    expect(nativeSkillContext({ ...input, files: {} })).toBe(nativeSkillContext(input))
  })
})
