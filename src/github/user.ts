import { stringField } from './json-fields.js'
import { ACCEPT_JSON, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 15_000

export interface GitHubUser {
  login: string
}

export interface FetchUserOptions {
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export async function fetchAuthenticatedUser(options: FetchUserOptions): Promise<GitHubUser> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const response = await sendGitHubRequest(ctx, '/user', ACCEPT_JSON)
  await ensureOk(response, ctx)
  return { login: stringField(await readJson(response, ctx), 'login') }
}
