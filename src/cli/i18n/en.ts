import { CONFIDENCE_FLOOR } from '../../review/select-findings.js'
import { formatCount } from '../units.js'
import type { CiNames, Messages } from './messages.js'

function ciNames({ count, shown }: CiNames): string {
  const more = count - shown.length
  return `(${[...shown, ...(more > 0 ? [`${more} more`] : [])].join(', ')})`
}

export const english: Messages = {
  scoreLabels: {
    5: 'ready to merge',
    4: 'minor polish needed',
    3: 'implementation issues',
    2: 'significant bugs',
    1: 'critical problems',
    0: 'critical problems',
  },
  scoreReason: (focus) =>
    focus === undefined
      ? 'no problems found'
      : `${focus.count} ${focus.severity} ${focus.count === 1 ? 'finding' : 'findings'} (${focus.locations.join(', ')})`,
  confidence: 'confidence',
  fix: 'Fix',
  basedOn: 'Based on',
  leftOut: 'Left out of the review',
  rule: 'rule',
  skill: 'skill',
  ciCheck: 'CI check',
  summary: 'Summary',
  files: 'Files',
  fileColumns: ['File', 'Change', 'Findings'],
  moreFiles: (count) => formatCount(count, 'more file'),
  worthChecking: (minConfidence) => `Worth checking (confidence below ${minConfidence})`,
  moreItems: (count) => `… (+${count} more)`,
  dropped: (dropped) => {
    const reasons: ReadonlyArray<readonly [number, string]> = [
      [dropped.rejected, `${dropped.rejected} rejected by verification`],
      [dropped.outsideDiff, `${dropped.outsideDiff} outside the diff`],
      [dropped.duplicate, formatCount(dropped.duplicate, 'duplicate')],
      [dropped.belowFloor, `${dropped.belowFloor} below confidence ${CONFIDENCE_FLOOR}`],
      [dropped.invalid, `${dropped.invalid} invalid`],
    ]
    const shown = reasons.filter(([count]) => count > 0)
    const total = shown.reduce((sum, [count]) => sum + count, 0)
    return total === 0 ? '' : `${total} dropped (${shown.map(([, text]) => text).join(', ')})`
  },
  verification: ({ candidates, unverified }) => {
    if (unverified > 0 && unverified === candidates) return `not verified (${unverified} unchecked)`
    return unverified > 0 ? `verified, ${unverified} unchecked` : 'verified'
  },
  terminal: {
    reviewOf: 'Review of',
    head: 'head',
    state: (state, draft) => (draft ? `${state}, draft` : state),
    score: 'Confidence score',
    findings: 'Findings',
    severity: { P0: 'P0 · Must fix', P1: 'P1 · Should fix', P2: 'P2 · Consider' },
    findingCount: (count) => formatCount(count, 'finding'),
    worthCheckingCount: (count) => `${count} worth checking`,
    tokens: (input, output) => `${input} in / ${output} out`,
  },
  github: {
    skillBody: (skill) => `Review by skill ${skill}`,
    heading: '🦋 Phada review',
    generatedWith: 'Generated with Phada 🦋',
    inlineComments: (bySeverity, count) =>
      `**${bySeverity} as ${count === 1 ? 'inline comment' : 'inline comments'}**`,
    stillOpenCount: (count) => `${count} still open from previous reviews`,
    stillOpen: 'Still open from previous reviews',
    filesTruncated: (count) => `Files table truncated (${formatCount(count, 'file')}).`,
    truncated: '… (truncated)',
    allIgnoredTitle: 'nothing to review',
    allIgnored: (sha) =>
      `Every changed file in ${sha} was left out of the review, so the AI did not look at this commit.`,
    onlyStillOpenTitle: 'no new findings',
    onlyStillOpen: (count, sha) =>
      count === 1
        ? `No new problems in ${sha}. 1 Phada comment from previous reviews is still open: resolve it to get a full review of this commit.`
        : `No new problems in ${sha}. ${count} Phada comments from previous reviews are still open: resolve them to get a full review of this commit.`,
    preview: (index, total, place) => `===== Inline comment ${index}/${total} · ${place} =====`,
    fixedThreads: (count, sha) =>
      count === 1
        ? `1 comment from previous reviews is fixed in ${sha}.`
        : `${count} comments from previous reviews are fixed in ${sha}.`,
    resolvedReply: (sha, reason) => `Fixed in \`${sha}\`: ${reason}`,
    ci: (state, total, failing, pending) => {
      const checks = formatCount(total, 'check')
      if (state === 'passing')
        return total === 1 ? 'CI: 1 check passing' : `CI: all ${checks} passing`
      if (state === 'pending')
        return `CI: ${pending.count} of ${checks} pending ${ciNames(pending)}`
      const waiting = pending.count === 0 ? '' : ` · ${pending.count} pending`
      return `CI: ${failing.count} of ${checks} failing ${ciNames(failing)}${waiting}`
    },
  },
}
