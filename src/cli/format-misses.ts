import type { MissList, MissRecord } from '../app/read-misses.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatCount } from './units.js'

const SCHEMA_VERSION = 1
const COMMENT_CHARS = 100
const INDENT = '      '

export function formatMissesText({ misses, dismissed }: MissList, all: boolean): string {
  const hidden = all ? 0 : dismissed
  if (misses.length === 0 && hidden === 0) return 'No misses in the history yet.\n'
  const blocks = misses.map((miss) => missLines(miss).join('\n'))
  if (hidden > 0) {
    const one = hidden === 1
    blocks.push(
      `${formatCount(hidden, 'dismissed miss', 'dismissed misses')} not shown; add --all to see ${one ? 'it' : 'them'}.`,
    )
  }
  return `${blocks.join('\n\n')}\n`
}

export function formatMissesJson({ misses, total }: MissList): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, total, misses: misses.map(missJson) }, null, 2)}\n`
}

function missPlace(miss: Pick<MissRecord, 'file' | 'startLine' | 'line'>): string {
  const lines =
    miss.startLine === undefined || miss.startLine === miss.line
      ? String(miss.line)
      : `${miss.startLine}-${miss.line}`
  return `${miss.file}:${lines}`
}

export function missLines(miss: MissRecord, status: string = miss.state): string[] {
  const header = [
    String(miss.id).padStart(4),
    `${miss.repo}#${miss.number}`,
    missPlace(miss),
    miss.role === undefined ? miss.author : `${miss.author} (${miss.role})`,
    `${miss.origin} · ${miss.seen}`,
    status,
  ].join('  ')
  const url = threadUrlOf(miss)
  return [
    toTerminalText(header),
    `${INDENT}${firstLine(miss.body)}`,
    ...(url === null ? [] : [`${INDENT}${toTerminalText(url)}`]),
  ]
}

function threadUrlOf(miss: MissRecord): string | null {
  return miss.threadUrl === undefined || miss.threadUrl === '' ? null : miss.threadUrl
}

function firstLine(body: string): string {
  const line = toTerminalText(body).trim().split('\n', 1)[0]?.trim() ?? ''
  const chars = [...line]
  return chars.length <= COMMENT_CHARS ? line : `${chars.slice(0, COMMENT_CHARS - 1).join('')}…`
}

export function missJson(miss: MissRecord) {
  return {
    id: miss.id,
    origin: miss.origin,
    seen: miss.seen,
    repo: miss.repo,
    number: miss.number,
    file: miss.file,
    startLine: miss.startLine ?? null,
    line: miss.line,
    author: miss.author,
    role: miss.role ?? null,
    body: miss.body,
    threadUrl: threadUrlOf(miss),
    reviewedSha: miss.reviewedSha ?? null,
    commitSha: miss.commitSha,
    createdAt: miss.createdAt,
    harvestedAt: miss.harvestedAt,
    state: miss.state,
  }
}
