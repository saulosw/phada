import { describe, expect, it } from 'vitest'
import { gitHubAuth } from './github-auth.js'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')

describe('gitHubAuth', () => {
  it('sends the token to github.com as a basic authorization header through the git config environment', () => {
    expect(gitHubAuth(TOKEN).env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
    })
  })

  it('scrubs the raw and the base64 token from a text', () => {
    const { scrub } = gitHubAuth('plain-token')
    const basic = Buffer.from('x-access-token:plain-token').toString('base64')

    expect(scrub(`fatal: plain-token rejected (${basic})`)).toBe('fatal:  rejected ()')
  })

  it('redacts other secrets left in the text', () => {
    expect(gitHubAuth('plain-token').scrub(`remote said ${TOKEN}`)).toBe('remote said [REDACTED]')
  })
})
