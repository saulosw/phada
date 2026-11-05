import { toTerminalText } from '../app/terminal-text.js'
import type { DiffGroupLink, DiffGroupReport } from '../review/types.js'
import { formatCount, formatDuration } from './units.js'

const LINKS: Readonly<Record<DiffGroupLink, string>> = {
  directory: 'by directory',
  single: 'file alone',
}

export function groupSize(files: number, bytes: number): string {
  return `${formatCount(files, 'file')}, ${Math.max(1, Math.round(bytes / 1000))} KB`
}

export function groupLine(
  { label, files, bytes, link }: Pick<DiffGroupReport, 'label' | 'files' | 'bytes' | 'link'>,
  index: number,
): string {
  return toTerminalText(
    `${index + 1}. ${label} — ${groupSize(files.length, bytes)}, ${LINKS[link]}`,
  )
}

export function formatGroupsSection(groups: readonly DiffGroupReport[]): string {
  const lines = groups.map((group, index) => {
    const outcome = group.failed === true ? 'failed' : formatCount(group.findings, 'finding')
    return `${groupLine(group, index)} · ${outcome} · ${formatDuration(group.durationMs)}`
  })
  return `## Groups\n\nEach text pass ran once per group.\n${lines.join('\n')}\n`
}
