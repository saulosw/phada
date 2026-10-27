import type { ConfigFileReport, ContextReport } from '../context/types.js'
import { docLine, ruleLine } from './format-context.js'
import { contextJson } from './format-json.js'
import { shortSha } from './review-text.js'
import { toTerminalText } from '../app/terminal-text.js'

export interface RulesView {
  pullRequest: { owner: string; repo: string; number: number; baseSha: string } | null
  repository: { owner: string; repo: string; ref: string }
}

export function formatRulesText(
  view: RulesView,
  report: ContextReport,
  ignore?: readonly string[],
): string {
  const { owner, repo, ref } = view.repository
  const title =
    view.pullRequest === null
      ? `Context for ${owner}/${repo} at ${toTerminalText(ref)}`
      : `Context for ${owner}/${repo}#${view.pullRequest.number} at ${shortSha(view.pullRequest.baseSha)}`
  const sections = [
    list('Config files', report.configFiles.map(configLine)),
    list('Rules', report.rules.map(ruleLine)),
    list('Docs', report.docs.map(docLine)),
  ].filter((section) => section !== '')
  const extra = [
    list('Ignored files', report.ignored.map(toTerminalText)),
    list('Ignore patterns', (ignore ?? []).map(toTerminalText)),
    list('Warnings', report.warnings.map(toTerminalText)),
  ].filter((section) => section !== '')
  const body = sections.length === 0 ? ['No config files, rules or docs.\n'] : sections
  return [`${title}\n`, ...body, ...extra].join('\n')
}

export function formatRulesJson(
  view: RulesView,
  report: ContextReport,
  ignore?: readonly string[],
): string {
  const output = {
    schemaVersion: 1,
    pullRequest: view.pullRequest,
    repository: view.repository,
    ignore: ignore === undefined ? null : [...ignore],
    context: contextJson(report),
  }
  return `${JSON.stringify(output, null, 2)}\n`
}

function configLine({ path, origin, status, message }: ConfigFileReport): string {
  const notes: string[] = [origin]
  if (status === 'invalid') notes.push(`invalid: ${toTerminalText(message ?? '')}`)
  return `${toTerminalText(path)} (${notes.join(', ')})`
}

function list(heading: string, items: readonly string[]): string {
  if (items.length === 0) return ''
  return `${heading}:\n${items.map((item) => `- ${item}`).join('\n')}\n`
}
