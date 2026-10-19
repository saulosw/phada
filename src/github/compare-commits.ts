import { GitHubError } from './errors.js'
import { arrayField, field, stringField } from './json-fields.js'
import { ACCEPT_JSON, ensureOk, readJson, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface ComparedFile {
  path: string
  previousPath?: string
  status: string
  patch?: string
}

export interface CompareOptions {
  owner: string
  repo: string
  token: string
  base: string
  head: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export class ComparisonNotFoundError extends GitHubError {
  override readonly name = 'ComparisonNotFoundError'

  constructor(base: string, head: string) {
    super(`Cannot compare ${base.slice(0, 7)} with ${head.slice(0, 7)}: a commit is gone`)
  }
}

export async function fetchComparison(options: CompareOptions): Promise<ComparedFile[]> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const repo = `${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
  const response = await sendGitHubRequest(
    ctx,
    `/repos/${repo}/compare/${options.base}...${options.head}`,
    ACCEPT_JSON,
  )
  if (response.status === 404) throw new ComparisonNotFoundError(options.base, options.head)
  await ensureOk(response, ctx)
  const json = await readJson(response, ctx)
  return arrayField(json, 'files').map(toComparedFile)
}

function toComparedFile(node: unknown): ComparedFile {
  const previous = field(node, 'previous_filename')
  const patch = field(node, 'patch')
  return {
    path: stringField(node, 'filename'),
    ...(typeof previous === 'string' ? { previousPath: previous } : {}),
    status: stringField(node, 'status'),
    ...(typeof patch === 'string' ? { patch } : {}),
  }
}
