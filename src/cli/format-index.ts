import type { IndexReport, LeftOutFile } from '../app/index-repository.js'
import { LANGUAGE_LABELS } from '../repo-map/languages.js'
import type { Language } from '../repo-map/languages.js'
import type { SymbolKind } from '../repo-map/types.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes, formatDuration } from './units.js'

export interface IndexSizes {
  index: number
  mirror: number
  mirrorPath: string
}

const SYMBOL_NOUNS: readonly [SymbolKind, string, string][] = [
  ['function', 'function', 'functions'],
  ['method', 'method', 'methods'],
  ['class', 'class', 'classes'],
  ['struct', 'struct', 'structs'],
  ['interface', 'interface', 'interfaces'],
  ['type', 'type', 'types'],
  ['enum', 'enum', 'enums'],
  ['variable', 'variable', 'variables'],
  ['parameter', 'parameter', 'parameters'],
]
const LEFT_OUT_LABELS: readonly [LeftOutFile['reason'], string, string][] = [
  ['no-grammar', 'no grammar', 'no grammar'],
  ['ignored', 'ignored', 'ignored'],
  ['too-large', 'too large', 'too large'],
  ['binary', 'binary', 'binary'],
  ['parse-timeout', 'timed out', 'timed out'],
  ['parse-failed', 'unreadable by the parser', 'unreadable by the parser'],
  ['symlink', 'symbolic link', 'symbolic links'],
  ['submodule', 'submodule', 'submodules'],
]
const EXTENSIONS_SHOWN = 3

export function formatIndexText(report: IndexReport, sizes: IndexSizes, home: string): string {
  const { files, summary } = report
  const ref =
    report.ref === report.commit
      ? ''
      : ` (${report.ref === 'HEAD' ? 'default branch' : report.ref})`
  const lines = [
    `Indexed ${report.repository} at ${report.commit.slice(0, 7)}${ref} in ${formatDuration(report.durationMs)}`,
  ]
  if (report.rebuilt) lines.push('Index rebuilt: the format changed.')
  const leftOut = report.leftOut.length === 0 ? '' : ` · ${number(report.leftOut.length)} left out`
  lines.push(
    `Files: ${number(files.indexed)} indexed (${number(files.extracted)} read, ${number(files.reused)} unchanged)${leftOut}`,
  )
  const languages = Object.entries(summary.languages)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .map(([language, count]) => `${LANGUAGE_LABELS[language as Language]} ${number(count ?? 0)}`)
  lines.push(`Languages: ${languages.length === 0 ? 'none' : languages.join(' · ')}`)
  const symbols = SYMBOL_NOUNS.flatMap(([kind, one, many]) => {
    const count = summary.symbols[kind] ?? 0
    return count === 0 ? [] : [`${number(count)} ${count === 1 ? one : many}`]
  })
  lines.push(`Symbols: ${symbols.length === 0 ? 'none' : symbols.join(' · ')}`)
  const errors =
    summary.parseErrors === 0
      ? ''
      : ` · ${number(summary.parseErrors)} parse error${summary.parseErrors === 1 ? '' : 's'}`
  lines.push(
    `Imports ${number(summary.imports)} · exports ${number(summary.exports)} · calls ${number(summary.calls)}${errors}`,
  )
  if (report.leftOut.length > 0) lines.push(`Left out: ${leftOutText(report.leftOut)}`)
  lines.push(
    `Index: ${shortPath(report.indexPath, home)} (${formatBytes(sizes.index)}) · mirror ${formatBytes(sizes.mirror)}`,
  )
  return `${toTerminalText(lines.join('\n'))}\n`
}

export function formatIndexJson(report: IndexReport, sizes: IndexSizes): string {
  const { summary } = report
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      repository: report.repository,
      commit: report.commit,
      ref: report.ref,
      durationMs: report.durationMs,
      files: report.files,
      languages: summary.languages,
      symbols: summary.symbols,
      imports: summary.imports,
      exports: summary.exports,
      calls: summary.calls,
      parseErrors: summary.parseErrors,
      leftOut: report.leftOut,
      rebuilt: report.rebuilt,
      warnings: report.warnings,
      index: { path: report.indexPath, bytes: sizes.index },
      mirror: { path: sizes.mirrorPath, bytes: sizes.mirror },
    },
    null,
    2,
  )}\n`
}

function leftOutText(leftOut: readonly LeftOutFile[]): string {
  return LEFT_OUT_LABELS.flatMap(([reason, one, many]) => {
    const files = leftOut.filter((file) => file.reason === reason)
    if (files.length === 0) return []
    const label = `${number(files.length)} ${files.length === 1 ? one : many}`
    return [reason === 'no-grammar' ? `${label} (${byExtension(files)})` : label]
  }).join(' · ')
}

function byExtension(files: readonly LeftOutFile[]): string {
  const counts = new Map<string, number>()
  for (const { path } of files) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const extension = dot <= 0 ? '(none)' : name.slice(dot).toLowerCase()
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  const sorted = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
  const shown = sorted
    .slice(0, EXTENSIONS_SHOWN)
    .map(([extension, count]) => `${extension} ${count}`)
  const other = sorted.slice(EXTENSIONS_SHOWN).reduce((sum, [, count]) => sum + count, 0)
  return [...shown, ...(other === 0 ? [] : [`other ${other}`])].join(', ')
}

function shortPath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}
