import { redactSecrets } from '../providers/redact-secrets.js'

export interface GitHubAuth {
  env: Readonly<Record<string, string>>
  scrub(text: string): string
}

export function gitHubAuth(token: string): GitHubAuth {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    },
    scrub: (text) => redactSecrets(text.replaceAll(token, '').replaceAll(basic, '')),
  }
}
