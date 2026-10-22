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
  })

  it('asks for the review language', () => {
    expect(
      nativeSkillContext({ ...input, language: 'pt-BR' }).endsWith('Write the review in pt-BR.'),
    ).toBe(true)
  })

  it('keeps its fixed text', () => {
    expect(createHash('sha256').update(nativeSkillContext(input)).digest('hex')).toBe(
      '8c95e4cfd97cfc2f3959e0573e524da0501172c32203ef6b0e569ca52c2ec278',
    )
  })
})
