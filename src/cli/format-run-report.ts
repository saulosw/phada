import type { RunReport } from '../app/read-run-report.js'
import { toTerminalText } from '../app/terminal-text.js'
import type { RunRecord } from '../store/history-store.js'
import { formatGitHubPreview } from './format-github.js'
import { runJson } from './format-history.js'
import { formatRunSections } from './format-run-sections.js'
import type { RunSections } from './format-run-sections.js'
import { singleLine } from './markdown-text.js'
import { shortSha } from './review-text.js'
import { formatLocalTime } from './units.js'

const SCHEMA_VERSION = 1

export function formatRunReportText(report: RunReport): string {
  const head = [
    headerLine(report.run, report.publishedFrom),
    ...(report.title === null ? [] : [singleLine(report.title)]),
    ...(report.checks === undefined ? [] : [checksLine(report.checks)]),
  ]
  const sections = [
    ...(report.posted === undefined ? [] : [formatGitHubPreview(report.posted)]),
    ...formatRunSections(sectionsOf(report)),
  ]
  const body = sections.length === 0 ? '' : `\n${sections.join('\n')}`
  return toTerminalText(`${head.join('\n')}\n${body}`)
}

export function formatRunReportJson(report: RunReport): string {
  const body = { schemaVersion: SCHEMA_VERSION, run: runJson(report.run), result: report.result }
  return `${JSON.stringify(body, null, 2)}\n`
}

function headerLine(run: Omit<RunRecord, 'resultJson'>, publishedFrom?: number): string {
  const provider = run.model === undefined ? run.provider : `${run.provider}/${run.model}`
  return [
    `Run ${run.id ?? '?'}`,
    `${run.repo}#${run.number} at ${shortSha(run.headSha)}`,
    formatLocalTime(new Date(run.startedAt)),
    run.requestSource ?? run.source,
    ...(provider === undefined ? [] : [provider]),
    singleLine(
      publishedFrom === undefined
        ? statusText(run)
        : `${statusText(run)} from run ${publishedFrom}`,
    ),
  ].join(' · ')
}

function statusText(run: Omit<RunRecord, 'resultJson'>): string {
  switch (run.status) {
    case 'published':
      return run.url === undefined ? 'published' : `published ${run.url}`
    case 'dry-run':
      return 'dry run'
    case 'skipped':
      return run.reason === undefined ? 'skipped' : `skipped: ${run.reason}`
    case 'failed':
      return run.error === undefined ? 'failed' : `failed: ${run.error}`
    case 'nothing':
      return 'nothing to review'
    case 'not-published':
      return 'not published'
    case 'superseded':
      return 'superseded by a newer commit'
  }
}

function checksLine({ state, failing, pending }: NonNullable<RunReport['checks']>): string {
  const parts = [
    `CI: ${state}`,
    ...(failing.length === 0 ? [] : [`failing: ${failing.join(', ')}`]),
    ...(pending.length === 0 ? [] : [`pending: ${pending.join(', ')}`]),
  ]
  return parts.join('; ')
}

function sectionsOf(report: RunReport): RunSections {
  const context = report.context ?? undefined
  const reviewed = context !== undefined
  const fixes = report.passes?.fixes
  return {
    ...(report.closeToCut === undefined ? {} : { closeToCut: report.closeToCut }),
    ...(report.claims === undefined ? {} : { claims: report.claims }),
    ...(context === undefined ? {} : { context }),
    ...(report.conversation === undefined || (!reviewed && report.conversation === null)
      ? {}
      : { conversation: report.conversation }),
    ...(report.ci === undefined || (!reviewed && report.ci === null) ? {} : { ci: report.ci }),
    ...(report.impact === undefined || report.impact === null ? {} : { impact: report.impact }),
    ...(report.related === undefined || report.related === null ? {} : { related: report.related }),
    ...(report.passes === undefined
      ? {}
      : {
          passes: {
            reports: report.passes.reports,
            fixFor: (blocked) => fixes?.get(blocked) ?? '',
          },
        }),
    ...(report.investigation === undefined || report.investigation === null
      ? {}
      : { investigation: report.investigation }),
    ...(report.usage === undefined ? {} : { usage: report.usage }),
  }
}
