import type { LocalGit } from '../repository/local-git.js'
import { isSeverity, numberFindings } from '../review/finding-numbers.js'
import type { NumberedFinding } from '../review/finding-numbers.js'
import type { Finding } from '../review/types.js'
import type { RunRecord } from '../store/history-store.js'
import { readStoredRun, titledFindings } from './stored-run.js'

export interface LocalFixReadDeps {
  local: Pick<LocalGit, 'branch' | 'head' | 'origin'>
  lastLocalRun(repo: string, branch: string): RunRecord | undefined
}

export interface LocalFixReadOptions {
  historyOff?: boolean
}

export interface LocalFixTarget {
  repo: string
  branch: string
  run: number
  head: string
  reviewedHead: string
  findings: NumberedFinding[]
}

export class NoLocalBranchError extends Error {
  override readonly name = 'NoLocalBranchError'

  constructor() {
    super('HEAD is not on a branch: phada fix reads the last local review of the current branch.')
  }
}

export class NoLocalReviewError extends Error {
  override readonly name = 'NoLocalReviewError'

  constructor(name: string, historyOff: boolean) {
    super(
      historyOff
        ? `No local review of ${name} in the history, which is off in your config: turn it on (history: true) and run phada review first.`
        : `No local review of ${name} in the history: run phada review first.`,
    )
  }
}

export async function readLocalFix(
  deps: LocalFixReadDeps,
  options: LocalFixReadOptions = {},
): Promise<LocalFixTarget> {
  const { local } = deps
  const origin = await local.origin()
  const repo = `${origin.owner}/${origin.repo}`
  const branch = await local.branch()
  if (branch === undefined) throw new NoLocalBranchError()
  const head = await local.head()
  const run = deps.lastLocalRun(repo, branch)
  if (run?.id === undefined) {
    throw new NoLocalReviewError(`${repo}@${branch}`, options.historyOff === true)
  }
  return {
    repo,
    branch,
    run: run.id,
    head,
    reviewedHead: run.headSha,
    findings: numberFindings(fixableFindings(run.resultJson)),
  }
}

function fixableFindings(json: string | undefined): Finding[] {
  const findings = readStoredRun(json).review?.findings ?? []
  return titledFindings(findings).flatMap((stored): Finding[] => {
    const { severity, line, rule, suggestion } = stored
    if (!isSeverity(severity) || line === null) return []
    return [
      {
        severity,
        confidence: stored.confidence ?? 0,
        file: stored.file,
        line,
        title: stored.title,
        why: stored.why ?? '',
        fix: stored.fix,
        ...(rule === null ? {} : { rule }),
        ...(suggestion === undefined ? {} : { suggestion }),
      },
    ]
  })
}
