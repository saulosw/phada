import type { CapturedComment, CapturedWrite } from '../review/types.js'
import { applyJq } from './gh-jq.js'
import { GhFacadeError } from './types.js'
import type { FieldValue, GhAnswer, GhCommand, GhPullData, ReadGitHub } from './types.js'

export interface GhResult {
  answer: GhAnswer
  captured?: CapturedWrite
}

const AVAILABLE =
  'gh pr view, gh pr diff, gh pr list, gh pr comment, gh pr review, gh issue view, gh issue list, gh search prs, gh search issues, gh repo view, gh api, gh auth status'
const PR_FIELDS = [
  'number',
  'title',
  'body',
  'url',
  'state',
  'isDraft',
  'author',
  'baseRefName',
  'headRefName',
  'baseRefOid',
  'headRefOid',
  'additions',
  'deletions',
  'changedFiles',
  'files',
  'labels',
  'comments',
  'reviews',
]
const OWN_LISTS =
  /^repos\/[^/]+\/[^/]+\/(?:issues\/\d+\/comments|pulls\/\d+\/(?:comments|reviews))$/
const LINE_COMMENTS = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/
const REVIEWS = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/
const ISSUE_COMMENTS = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/
const MAX_PAGES = 10

export async function answerGh(
  command: GhCommand,
  data: GhPullData,
  readGitHub: ReadGitHub,
): Promise<GhResult> {
  try {
    return await answer(command, data, readGitHub)
  } catch (error) {
    const message =
      error instanceof GhFacadeError
        ? error.message
        : `phada: GitHub answered: ${error instanceof Error ? error.message : String(error)}`
    return { answer: failure(message) }
  }
}

async function answer(command: GhCommand, data: GhPullData, read: ReadGitHub): Promise<GhResult> {
  const repoPath = `repos/${data.repo}`
  switch (command.kind) {
    case 'pr-view': {
      checkRepo(command.repo, data)
      checkPull(command.target, data)
      if (command.json === undefined) return ok(await pullText(command.comments, data, read))
      const unknown = command.json.find((field) => !PR_FIELDS.includes(field))
      if (unknown !== undefined) {
        throw new GhFacadeError(
          `Unknown JSON field: "${unknown}"\nAvailable fields:\n${PR_FIELDS.map((field) => `  ${field}`).join('\n')}`,
        )
      }
      const value: Record<string, unknown> = {}
      for (const field of command.json) value[field] = await pullField(field, data, read)
      return ok(output(value, command.jq))
    }
    case 'pr-diff':
      checkRepo(command.repo, data)
      checkPull(command.target, data)
      return ok(command.nameOnly ? lines(diffFiles(data.diff).map(({ path }) => path)) : data.diff)
    case 'pr-list': {
      checkRepo(command.repo, data)
      const items =
        command.search === undefined
          ? await read(`${repoPath}/pulls`, {
              state: listState(command.state),
              per_page: String(command.limit ?? 30),
            })
          : await searchItems(`${command.search} repo:${data.repo} is:pr`, command.limit, read)
      return ok(listing(asArray(items), command))
    }
    case 'issue-list': {
      checkRepo(command.repo, data)
      const items =
        command.search === undefined
          ? asArray(
              await read(`${repoPath}/issues`, {
                state: listState(command.state),
                per_page: String(command.limit ?? 30),
              }),
            ).filter((item) => !isRecord(item) || item.pull_request === undefined)
          : await searchItems(`${command.search} repo:${data.repo} is:issue`, command.limit, read)
      return ok(listing(asArray(items), command))
    }
    case 'search': {
      checkRepo(command.repo, data)
      const kind = command.type === 'prs' ? 'is:pr' : 'is:issue'
      const items = await searchItems(
        `${command.query} repo:${data.repo} ${kind}`,
        command.limit,
        read,
      )
      return ok(listing(items, command))
    }
    case 'issue-view': {
      checkRepo(command.repo, data)
      const number = issueNumber(command.target, data)
      const issue = await read(`${repoPath}/issues/${number}`)
      const comments =
        command.comments || command.json?.includes('comments')
          ? await read(`${repoPath}/issues/${number}/comments`)
          : []
      const shaped: Record<string, unknown> = {
        ...issueShape(issue),
        comments: asArray(comments)
          .filter((item) => !byViewer(item, data))
          .map(commentShape),
      }
      if (command.json !== undefined) return ok(output(pick(shaped, command.json), command.jq))
      return ok(issueText(shaped, command.comments))
    }
    case 'repo-view': {
      if (command.target !== undefined) checkRepo(command.target, data)
      const repo = await read(repoPath)
      const shaped = repoShape(repo)
      if (command.json !== undefined) return ok(output(pick(shaped, command.json), command.jq))
      return ok(`${String(shaped.nameWithOwner)}\n${String(shaped.description ?? '')}\n`)
    }
    case 'api':
      return api(command, data, read)
    case 'pr-comment':
      checkRepo(command.repo, data)
      checkPull(command.target, data)
      return captured(data, { command: 'gh pr comment', body: command.body, comments: [] })
    case 'pr-review':
      checkRepo(command.repo, data)
      checkPull(command.target, data)
      return captured(data, { command: 'gh pr review', body: command.body, comments: [] })
    case 'auth-status':
      return ok('Phada answers GitHub requests during this review.\n')
    case 'unsupported':
      throw new GhFacadeError(
        `phada: "gh ${command.sub}" is not available during a Phada review. Available: ${AVAILABLE}.`,
      )
  }
}

async function api(
  command: Extract<GhCommand, { kind: 'api' }>,
  data: GhPullData,
  read: ReadGitHub,
): Promise<GhResult> {
  const [owner = '', repo = ''] = data.repo.split('/')
  const [rawPath = '', rawQuery = ''] = command.path
    .replace(/^\/+/, '')
    .replaceAll('{owner}', owner)
    .replaceAll('{repo}', repo)
    .split('?')
  const path = rawPath.replace(/\/+$/, '')
  if (command.method !== 'GET') return apiWrite(command, path, data)
  const query = Object.fromEntries(new URLSearchParams(rawQuery))
  if (path === 'search/issues') {
    const q = query.q ?? ''
    query.q = q.includes(`repo:${data.repo}`) ? q : `${q} repo:${data.repo}`.trim()
  } else if (!sameRepoPath(path, data)) {
    throw new GhFacadeError(`phada: only ${data.repo} can be read during this review.`)
  }
  let value: unknown
  if (command.paginate) {
    const pages: unknown[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = asArray(await read(path, { ...query, per_page: '100', page: String(page) }))
      pages.push(...items)
      if (items.length < 100) break
    }
    value = pages
  } else {
    value = await read(path, ...(Object.keys(query).length === 0 ? [] : [query]))
  }
  if (
    path.toLowerCase() === `repos/${data.repo.toLowerCase()}/pulls/${data.number}` &&
    isRecord(value)
  ) {
    value = { ...value, state: 'open', draft: false }
  }
  if (OWN_LISTS.test(path) && Array.isArray(value)) {
    value = value.filter((item) => !byViewer(item, data))
  }
  return ok(
    command.jq === undefined
      ? `${JSON.stringify(value, null, 2)}\n`
      : lines(applyJq(value, command.jq)),
  )
}

function apiWrite(
  command: Extract<GhCommand, { kind: 'api' }>,
  path: string,
  data: GhPullData,
): GhResult {
  const body = isObject(command.input) ? command.input : (command.fields ?? {})
  const number = (LINE_COMMENTS.exec(path) ?? REVIEWS.exec(path) ?? ISSUE_COMMENTS.exec(path))?.[1]
  if (!sameRepoPath(path, data) || number === undefined || Number(number) !== data.number) {
    throw new GhFacadeError(
      'phada: Phada does not write to GitHub during a review; only comments and reviews on this pull request are collected.',
    )
  }
  if (LINE_COMMENTS.test(path)) {
    return captured(data, { command: 'gh api', body: '', comments: commentsOf([body]) })
  }
  const comments = Array.isArray(body.comments) ? commentsOf(body.comments) : []
  return captured(data, { command: 'gh api', body: text(body.body), comments })
}

function commentsOf(items: readonly FieldValue[]): CapturedComment[] {
  return items.flatMap((item) => {
    if (!isObject(item) || typeof item.path !== 'string') return []
    const line = numberOf(item.line)
    const startLine = numberOf(item.start_line)
    return [
      {
        path: item.path,
        ...(line === undefined ? {} : { line }),
        ...(startLine === undefined ? {} : { startLine }),
        body: text(item.body),
      },
    ]
  })
}

async function pullField(field: string, data: GhPullData, read: ReadGitHub): Promise<unknown> {
  const files = diffFiles(data.diff)
  switch (field) {
    case 'number':
      return data.number
    case 'title':
      return data.title
    case 'body':
      return data.body
    case 'url':
      return data.url
    case 'state':
      return 'OPEN'
    case 'isDraft':
      return false
    case 'author':
      return { login: data.author }
    case 'baseRefName':
      return data.baseRef
    case 'headRefName':
      return data.headRef
    case 'baseRefOid':
      return data.mergeBase
    case 'headRefOid':
      return data.headSha
    case 'additions':
      return files.reduce((sum, file) => sum + file.additions, 0)
    case 'deletions':
      return files.reduce((sum, file) => sum + file.deletions, 0)
    case 'changedFiles':
      return files.length
    case 'files':
      return files
    case 'labels': {
      const issue = await read(`repos/${data.repo}/issues/${data.number}`)
      return isRecord(issue)
        ? asArray(issue.labels).map((label) => ({ name: isRecord(label) ? label.name : label }))
        : []
    }
    case 'comments':
      return asArray(await read(`repos/${data.repo}/issues/${data.number}/comments`))
        .filter((item) => !byViewer(item, data))
        .map(commentShape)
    default:
      return asArray(await read(`repos/${data.repo}/pulls/${data.number}/reviews`))
        .filter((item) => !byViewer(item, data))
        .map((item) => ({
          author: { login: loginOf(item) },
          body: isRecord(item) ? item.body : '',
          state: isRecord(item) ? item.state : '',
          submittedAt: isRecord(item) ? item.submitted_at : '',
        }))
  }
}

async function pullText(
  withComments: boolean,
  data: GhPullData,
  read: ReadGitHub,
): Promise<string> {
  const files = diffFiles(data.diff)
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const parts = [
    `${data.title} #${data.number}`,
    `Open • ${data.author} wants to merge into ${data.baseRef} from ${data.headRef} • +${additions} -${deletions} • ${files.length} files`,
    '',
    data.body,
    '',
  ]
  if (withComments) {
    const comments = (await pullField('comments', data, read)) as {
      author: { login: string }
      body: unknown
    }[]
    for (const comment of comments) parts.push(`${comment.author.login}:`, String(comment.body), '')
  }
  parts.push(`View this pull request on GitHub: ${data.url}`, '')
  return parts.join('\n')
}

function listing(items: readonly unknown[], command: { json?: string[]; jq?: string }): string {
  const shaped = items.map(issueShape)
  if (command.json !== undefined) {
    return output(
      shaped.map((item) => pick(item, command.json ?? [])),
      command.jq,
    )
  }
  return lines(
    shaped.map((item) => `#${String(item.number)}\t${String(item.title)}\t${String(item.state)}`),
  )
}

async function searchItems(
  query: string,
  limit: number | undefined,
  read: ReadGitHub,
): Promise<unknown[]> {
  const found = await read('search/issues', { q: query, per_page: String(limit ?? 30) })
  return isRecord(found) ? asArray(found.items) : []
}

function issueShape(item: unknown): Record<string, unknown> {
  const record = isRecord(item) ? item : {}
  return {
    number: record.number,
    title: record.title,
    body: record.body ?? '',
    url: record.html_url,
    state: typeof record.state === 'string' ? record.state.toUpperCase() : record.state,
    author: { login: loginOf(record) },
    labels: asArray(record.labels).map((label) => ({ name: isRecord(label) ? label.name : label })),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    isDraft: record.draft === true,
    headRefName: isRecord(record.head) ? record.head.ref : undefined,
    baseRefName: isRecord(record.base) ? record.base.ref : undefined,
  }
}

function issueText(issue: Record<string, unknown>, withComments: boolean): string {
  const parts = [
    `${String(issue.title)} #${String(issue.number)}`,
    String(issue.state),
    '',
    String(issue.body),
    '',
  ]
  if (withComments) {
    for (const comment of asArray(issue.comments)) {
      if (isRecord(comment) && isRecord(comment.author)) {
        parts.push(`${String(comment.author.login)}:`, String(comment.body), '')
      }
    }
  }
  return parts.join('\n')
}

function repoShape(repo: unknown): Record<string, unknown> {
  const record = isRecord(repo) ? repo : {}
  return {
    name: record.name,
    nameWithOwner: record.full_name,
    description: record.description,
    url: record.html_url,
    defaultBranchRef: { name: record.default_branch },
    visibility:
      typeof record.visibility === 'string' ? record.visibility.toUpperCase() : record.visibility,
  }
}

function commentShape(item: unknown): Record<string, unknown> {
  const record = isRecord(item) ? item : {}
  return {
    author: { login: loginOf(record) },
    body: record.body,
    createdAt: record.created_at,
    url: record.html_url,
  }
}

function diffFiles(diff: string): { path: string; additions: number; deletions: number }[] {
  const files: { path: string; additions: number; deletions: number }[] = []
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line)
    if (header !== null) {
      files.push({ path: header[1] ?? '', additions: 0, deletions: 0 })
      continue
    }
    const current = files.at(-1)
    if (current === undefined || line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) current.additions++
    else if (line.startsWith('-')) current.deletions++
  }
  return files
}

function checkPull(target: string | undefined, data: GhPullData): void {
  if (target === undefined || target === String(data.number) || target === `#${data.number}`) return
  if (target === data.headRef || target.toLowerCase() === data.url.toLowerCase()) return
  throw new GhFacadeError(
    `phada: only pull request ${data.repo}#${data.number} can be read during this review.`,
  )
}

function checkRepo(repo: string | undefined, data: GhPullData): void {
  if (repo === undefined) return
  const name = repo.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  if (name.toLowerCase() !== data.repo.toLowerCase()) {
    throw new GhFacadeError(`phada: only ${data.repo} can be read during this review.`)
  }
}

function issueNumber(target: string, data: GhPullData): string {
  const fromUrl = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/.exec(target)
  if (fromUrl !== null) {
    checkRepo(fromUrl[1], data)
    return fromUrl[2] ?? ''
  }
  const number = target.replace(/^#/, '')
  if (!/^\d+$/.test(number)) throw new GhFacadeError(`phada: "${target}" is not an issue number.`)
  return number
}

function sameRepoPath(path: string, data: GhPullData): boolean {
  const prefix = `repos/${data.repo}`.toLowerCase()
  const lower = path.toLowerCase()
  return lower === prefix || lower.startsWith(`${prefix}/`)
}

function byViewer(item: unknown, data: GhPullData): boolean {
  return loginOf(item).toLowerCase() === data.viewer.toLowerCase()
}

function loginOf(item: unknown): string {
  if (!isRecord(item)) return ''
  const user = isRecord(item.user) ? item.user : isRecord(item.author) ? item.author : undefined
  return typeof user?.login === 'string' ? user.login : ''
}

function listState(state: string | undefined): string {
  if (state === 'all' || state === 'closed') return state
  return state === 'merged' ? 'closed' : 'open'
}

function pick(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, value[field] ?? null]))
}

function output(value: unknown, jq: string | undefined): string {
  return jq === undefined ? `${JSON.stringify(value, null, 2)}\n` : lines(applyJq(value, jq))
}

function captured(data: GhPullData, write: CapturedWrite): GhResult {
  return {
    answer: { stdout: `${data.url}#phada-captured\n`, stderr: '', exitCode: 0 },
    captured: write,
  }
}

function ok(stdout: string): GhResult {
  return { answer: { stdout, stderr: '', exitCode: 0 } }
}

function failure(message: string): GhAnswer {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}

function lines(values: readonly string[]): string {
  return values.length === 0 ? '' : `${values.join('\n')}\n`
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: FieldValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: FieldValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObject(value: FieldValue | undefined): value is { [key: string]: FieldValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
