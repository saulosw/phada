import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact-secrets.js'

const BODY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

describe('redactSecrets', () => {
  it.each([
    ['classic GitHub token', `ghp_${BODY}`],
    ['GitHub OAuth token', `gho_${BODY}`],
    ['GitHub user-to-server token', `ghu_${BODY}`],
    ['GitHub server-to-server token', `ghs_${BODY}`],
    ['GitHub refresh token', `ghr_${BODY}`],
    ['fine-grained GitHub token', `github_pat_11ABC_${BODY}`],
    ['OpenAI-style key', `sk-${BODY}`],
    ['Anthropic key', `sk-ant-api03-${BODY}`],
    ['bearer header value', `Bearer ${BODY}`],
    ['lower-case bearer', `bearer ${BODY}`],
  ])('redacts a %s', (_, secret) => {
    const redacted = redactSecrets(`before ${secret} after`)

    expect(redacted).toBe('before [REDACTED] after')
  })

  it('redacts every occurrence', () => {
    const redacted = redactSecrets(`ghp_${BODY} and again ghp_${BODY}`)

    expect(redacted).toBe('[REDACTED] and again [REDACTED]')
  })

  it.each([
    'task-list and risk-free-and-long-enough-words',
    'ghp_short',
    'a Bearer of bad news',
    'Not logged in · Please run /login',
  ])('keeps ordinary text intact: %s', (text) => {
    expect(redactSecrets(text)).toBe(text)
  })
})
