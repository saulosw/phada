import { arrayField, field, nullableStringField, numberField, stringField } from './json-fields.js'
import type { RepositoryFilesOptions } from './repository-files.js'
import {
  ACCEPT_JSON,
  ensureReadable,
  nextPagePath,
  readJson,
  sendGitHubRequest,
} from './request.js'
import type { GitHubRequestContext, ReadPermission } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_PAGES = 10
const RUNS: ReadPermission = { what: 'the check runs', permission: 'checks:read' }
const ANNOTATIONS: ReadPermission = {
  what: 'the check run annotations',
  permission: 'checks:read',
}

export interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  title: string | null
  summary: string | null
  url: string | null
  app: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface CheckAnnotation {
  path: string
  line: number
  level: string
  title: string | null
  message: string
}

export async function fetchCheckRuns(
  options: RepositoryFilesOptions & { sha: string },
): Promise<CheckRun[]> {
  const ctx = context(options)
  let path: string | undefined =
    `${repoPath(options)}/commits/${encodeURIComponent(options.sha)}/check-runs?per_page=100`
  const runs: CheckRun[] = []
  for (let page = 0; path !== undefined && page < MAX_PAGES; page++) {
    const response = await sendGitHubRequest(ctx, path, ACCEPT_JSON)
    await ensureReadable(response, ctx, RUNS)
    runs.push(...arrayField(await readJson(response, ctx), 'check_runs').map(toCheckRun))
    path = nextPagePath(response.headers.get('link'))
  }
  return runs
}

export async function fetchCheckAnnotations(
  options: RepositoryFilesOptions & { checkRunId: number },
): Promise<CheckAnnotation[]> {
  const ctx = context(options)
  const response = await sendGitHubRequest(
    ctx,
    `${repoPath(options)}/check-runs/${options.checkRunId}/annotations?per_page=50`,
    ACCEPT_JSON,
  )
  await ensureReadable(response, ctx, ANNOTATIONS)
  const items = await readJson(response, ctx)
  return (Array.isArray(items) ? items : []).map(toAnnotation)
}

function toCheckRun(json: unknown): CheckRun {
  return {
    id: numberField(json, 'id'),
    name: stringField(json, 'name'),
    status: stringField(json, 'status'),
    conclusion: nullableStringField(json, 'conclusion'),
    title: optionalString(json, 'output.title'),
    summary: optionalString(json, 'output.summary'),
    url: optionalString(json, 'html_url'),
    app: optionalString(json, 'app.slug'),
    startedAt: optionalString(json, 'started_at'),
    completedAt: optionalString(json, 'completed_at'),
  }
}

function toAnnotation(json: unknown): CheckAnnotation {
  return {
    path: stringField(json, 'path'),
    line: numberField(json, 'start_line'),
    level: stringField(json, 'annotation_level'),
    title: optionalString(json, 'title'),
    message: stringField(json, 'message'),
  }
}

function optionalString(json: unknown, path: string): string | null {
  const value = field(json, path)
  return typeof value === 'string' ? value : null
}

function context(options: RepositoryFilesOptions): GitHubRequestContext {
  return {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

function repoPath(options: { owner: string; repo: string }): string {
  return `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
}
