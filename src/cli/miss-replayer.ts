import type { MissReplayRun } from '../app/replay-misses.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import { toTerminalText } from '../app/terminal-text.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { SkipReason } from '../publish/types.js'
import type { SkipReviewReason } from '../review/types.js'
import { ReplayRanNoAiError } from './errors.js'
import { prepareReview, runManualReview } from './manual-review.js'
import type { ManualReviewDeps, PreparedReview } from './manual-review.js'
import type { MissReplayer } from './misses-replay-command.js'
import { printHistorySave } from './print-history-save.js'
import { printReviewProgress } from './print-review-progress.js'
import type { TextOutput } from './progress.js'

export function reviewReplayer(deps: ManualReviewDeps & { stderr: TextOutput }): MissReplayer {
  return (token) => {
    const prepared = new Map<string, Promise<PreparedReview>>()
    return async ({ repo, number }, sha) => {
      const ref = { ...splitRepoName(repo), number }
      const key = repo.toLowerCase()
      const ready = prepared.get(key) ?? prepareReview(ref, token, {}, deps)
      prepared.set(key, ready)
      const { run, history } = await runManualReview(
        { ...(await ready), ref },
        { force: false, dryRun: true, waitCi: false, head: sha, options: {} },
        deps,
        {
          progress: printReviewProgress(deps.stderr, deps.clock),
          reviewed: ({ outcome }) => {
            if (outcome.status !== 'reviewed') return
            for (const warning of outcome.result.warnings ?? []) {
              deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
            }
          },
        },
      )
      printHistorySave(deps.stderr, history)
      return {
        ...(history.status === 'saved' ? { runId: history.runId } : {}),
        findings: findingsOf(run, sha),
      }
    }
  }
}

function findingsOf(run: ReviewRun, sha: string): MissReplayRun['findings'] {
  if (run.status === 'reviewed' && run.reviewed.outcome.status === 'reviewed') {
    return run.reviewed.outcome.result.findings
  }
  throw new ReplayRanNoAiError(sha, noAiReason(run))
}

function noAiReason(run: ReviewRun): string {
  if (run.status === 'skipped') return SKIPPED_TEXT[run.reason.kind]
  const { outcome } = run.reviewed
  return outcome.status === 'skipped' ? NOTHING_TEXT[outcome.reason] : 'nothing was reviewed'
}

const SKIPPED_TEXT: Readonly<Record<SkipReason['kind'], string>> = {
  'open-threads': 'Phada had already reviewed it',
  'nothing-found': 'Phada had already reviewed it',
  'already-reviewed': 'Phada had already reviewed it',
  'same-diff': 'the diff was already reviewed',
  'closed-or-draft': 'the pull request is closed or a draft',
}

const NOTHING_TEXT: Readonly<Record<SkipReviewReason, string>> = {
  'empty-diff': 'the diff is empty',
  'all-ignored': 'every changed file is ignored',
  'no-skill-applies': 'no skill applies to the changed files',
}
