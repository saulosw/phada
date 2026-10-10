import type { Finding, ReviewContext, Severity } from './types.js'

export const MAX_SOURCES = 5

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2 }
const LINE_SUFFIX = /:\d+(?:-\d+)?$/
const SERVER_SOURCE = /^([^:\s/]+(?: [^:/]+)?):\s/

export interface InvestigatedReferences {
  touched: readonly string[]
  servers: readonly string[]
}

export function withKnownReferences(
  findings: readonly Finding[],
  context: ReviewContext | undefined,
  diffPaths: readonly string[],
  investigated: InvestigatedReferences = { touched: [], servers: [] },
): Finding[] {
  const rules = new Set(context?.rules.map((rule) => rule.key))
  const known = new Set([
    ...diffPaths,
    ...(context?.docs.map((doc) => doc.path) ?? []),
    ...(context?.rules.map((rule) => rule.origin) ?? []),
    ...investigated.touched,
  ])
  const servers = new Set(investigated.servers.map(serverKey))
  const isKnown = (source: string) => {
    if (known.has(source.replace(LINE_SUFFIX, ''))) return true
    const server = SERVER_SOURCE.exec(source)?.[1]
    return server !== undefined && servers.has(serverKey(server))
  }
  return findings.map(({ rule, sources, ...finding }) => {
    const kept = (sources ?? []).filter(isKnown).slice(0, MAX_SOURCES)
    return {
      ...finding,
      ...(rule !== undefined && rules.has(rule) ? { rule } : {}),
      ...(kept.length === 0 ? {} : { sources: kept }),
    }
  })
}

export function withRuleSeverity(
  findings: readonly Finding[],
  context: ReviewContext | undefined,
): Finding[] {
  const floors = new Map<string, Severity>()
  for (const rule of context?.rules ?? []) {
    if (rule.severity !== undefined) floors.set(rule.key, rule.severity)
  }
  return findings.map((finding) => {
    const floor = finding.rule === undefined ? undefined : floors.get(finding.rule)
    return floor !== undefined && SEVERITY_RANK[finding.severity] > SEVERITY_RANK[floor]
      ? { ...finding, severity: floor }
      : finding
  })
}

function serverKey(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase()
}
