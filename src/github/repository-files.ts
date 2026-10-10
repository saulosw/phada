import { arrayField, booleanField, field, invalidPayload } from './json-fields.js'
import { ACCEPT_JSON, ensureOk, readJson, readText, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

export const ACCEPT_RAW = 'application/vnd.github.raw+json'
const DEFAULT_TIMEOUT_MS = 30_000
const SYMLINK_MODE = '120000'

export interface RepositoryTree {
  entries: { path: string; size: number }[]
  truncated: boolean
}

export interface RepositoryFilesOptions {
  owner: string
  repo: string
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export async function fetchRepositoryTree(
  options: RepositoryFilesOptions & { sha: string },
): Promise<RepositoryTree> {
  const ctx = contextOf(options)
  const response = await sendGitHubRequest(
    ctx,
    `${repositoryPath(options)}/git/trees/${encodeURIComponent(options.sha)}?recursive=1`,
    ACCEPT_JSON,
  )
  await ensureOk(response, ctx)
  const json = await readJson(response, ctx)
  const entries = arrayField(json, 'tree').flatMap((item) => {
    if (field(item, 'type') !== 'blob' || field(item, 'mode') === SYMLINK_MODE) return []
    const path = field(item, 'path')
    const size = field(item, 'size')
    if (typeof path !== 'string' || typeof size !== 'number') throw invalidPayload('tree')
    return [{ path, size }]
  })
  return { entries, truncated: booleanField(json, 'truncated') }
}

export async function fetchRepositoryFile(
  options: RepositoryFilesOptions & { path: string; ref: string },
): Promise<string | null> {
  const ctx = contextOf(options)
  const path = options.path.split('/').map(encodeURIComponent).join('/')
  const response = await sendGitHubRequest(
    ctx,
    `${repositoryPath(options)}/contents/${path}?ref=${encodeURIComponent(options.ref)}`,
    ACCEPT_RAW,
  )
  if (response.status === 404) return null
  await ensureOk(response, ctx)
  return readText(response, ctx)
}

function repositoryPath({ owner, repo }: RepositoryFilesOptions): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

function contextOf(options: RepositoryFilesOptions): GitHubRequestContext {
  return {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}
