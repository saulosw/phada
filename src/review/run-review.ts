import type { ReviewOutput, ReviewProvider, TokenUsage } from '../providers/types.js'
import type { Toolbox } from '../investigation/toolbox.js'
import { withKnownReferences, withRuleSeverity } from './context-findings.js'
import { diffFingerprint } from './diff-fingerprint.js'
import { parseDiffFiles } from './diff-lines.js'
import { newNonce } from './nonce.js'
import { parseReviewReport } from './parse-report.js'
import type { ParsedReport } from './parse-report.js'
import { buildReviewPrompt } from './prompt.js'
import { scoreFindings } from './score.js'
import { checkSuggestions } from './suggestions.js'
import {
  CONFIDENCE_FLOOR,
  isConfidenceCut,
  MAX_CONFIDENCE,
  prepareCandidates,
  splitAtCut,
  summarizeFiles,
  VERIFY_CANDIDATE_FLOOR,
} from './select-findings.js'
import type { Finding, PassReport, ReviewOutcome, ReviewRequest, SkillPass } from './types.js'
import { verifyCandidates } from './verify-findings.js'

export const DEFAULT_MIN_CONFIDENCE = 60

export interface RunReviewDeps {
  provider: ReviewProvider
  verifier?: ReviewProvider
  tools?: (pass: 'review' | 'verify') => Toolbox
  createNonce?: () => string
  events?: { passStarted?(pass: SkillPass, index: number): void }
}

export async function runReview(
  request: ReviewRequest,
  deps: RunReviewDeps,
): Promise<ReviewOutcome> {
  const { pullRequest, minConfidence = DEFAULT_MIN_CONFIDENCE } = request
  if (!isConfidenceCut(minConfidence)) {
    throw new RangeError(
      `Invalid minConfidence ${minConfidence}: use an integer from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE}.`,
    )
  }
  if (pullRequest.diff.trim() === '') {
    const allIgnored = (request.context?.ignored.length ?? 0) > 0
    return { status: 'skipped', reason: allIgnored ? 'all-ignored' : 'empty-diff' }
  }

  const createNonce = deps.createNonce ?? newNonce
  const answered = await runPasses(request, deps, createNonce)
  const first = answered.outputs[0]
  const diffFiles = parseDiffFiles(pullRequest.diff)
  const verify = request.verify === true
  const suggested = checkSuggestions(
    answered.outputs.flatMap(({ findings }) => findings),
    diffFiles,
  )
  const passExternalCalls = answered.outputs.flatMap(({ output }) => output.externalCalls ?? [])
  const reported = withKnownReferences(
    suggested.findings,
    request.context,
    diffFiles.map((file) => file.path),
    {
      touched: answered.touched,
      servers: passExternalCalls.map((call) => call.server),
    },
  )
  const prepared = prepareCandidates(
    reported,
    diffFiles,
    minConfidence,
    verify ? VERIFY_CANDIDATE_FLOOR : CONFIDENCE_FLOOR,
  )
  const checked = verify
    ? await verifyCandidates(
        request,
        prepared.candidates,
        deps.verifier ?? deps.provider,
        createNonce(),
        deps.tools?.('verify'),
      )
    : undefined
  const selection = splitAtCut(
    withRuleSeverity(checked?.findings ?? prepared.candidates, request.context),
    minConfidence,
  )
  const totalUsage = sumUsage(answered.usage, checked?.verification.usage)
  const ignored = request.context?.ignored ?? []
  const externalCalls = [...passExternalCalls, ...(checked?.externalCalls ?? [])]
  const warnings = [
    ...new Set([
      ...answered.warnings,
      ...answered.outputs.flatMap(({ output }) => output.warnings ?? []),
      ...(checked?.warnings ?? []),
    ]),
  ]
  const model = first?.output.model
  const additionalModels = otherModels(answered.outputs, model)
  return {
    status: 'reviewed',
    result: {
      target: {
        repo: pullRequest.repo,
        number: pullRequest.number,
        headSha: pullRequest.headSha,
        diffFingerprint: diffFingerprint(pullRequest.diff),
      },
      providerId: deps.provider.id,
      ...(model === undefined ? {} : { model }),
      ...(additionalModels === undefined ? {} : { additionalModels }),
      durationMs: answered.durationMs + (checked?.verification.durationMs ?? 0),
      ...(totalUsage === undefined ? {} : { usage: totalUsage }),
      summary: first?.report.summary ?? NO_SKILL_APPLIES,
      files: summarizeFiles(first?.report.files ?? [], selection.findings, diffFiles),
      findings: selection.findings,
      worthChecking: selection.worthChecking,
      worthCheckingOmitted: selection.worthCheckingOmitted,
      minConfidence,
      score: scoreFindings(selection.findings),
      dropped: {
        invalid: answered.outputs.reduce((sum, { report }) => sum + report.invalid, 0),
        belowFloor: prepared.belowFloor + selection.belowFloor,
        outsideDiff: prepared.outsideDiff,
        duplicate: prepared.duplicate,
        rejected: checked?.verification.rejected.length ?? 0,
      },
      ...(checked === undefined ? {} : { verification: checked.verification }),
      ...(suggested.counts === undefined
        ? {}
        : { suggestions: { ...suggested.counts, dropped: checked?.droppedSuggestions ?? 0 } }),
      ...(ignored.length === 0 ? {} : { ignored: [...ignored] }),
      ...(externalCalls.length === 0 ? {} : { externalCalls }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(request.passes === undefined ? {} : { passes: answered.reports }),
    },
  }
}

const NO_SKILL_APPLIES = 'No skill applies to the changed files.'

interface AnsweredPass {
  output: ReviewOutput
  report: ParsedReport
  findings: Finding[]
}

interface AnsweredPasses {
  outputs: AnsweredPass[]
  reports: PassReport[]
  touched: string[]
  durationMs: number
  usage?: TokenUsage
  warnings: string[]
}

async function runPasses(
  request: ReviewRequest,
  deps: RunReviewDeps,
  createNonce: () => string,
): Promise<AnsweredPasses> {
  const passes = request.passes
  const planned: (SkillPass | undefined)[] = passes ?? [undefined]
  const answered: AnsweredPasses = {
    outputs: [],
    reports: [],
    touched: [],
    durationMs: 0,
    warnings: [],
  }
  let firstError: unknown
  let ran = 0
  for (const [index, pass] of planned.entries()) {
    const origin = pass === undefined || pass.lens.kind === 'default' ? 'phada' : pass.lens.origin
    if (pass?.skip !== undefined) {
      answered.reports.push({
        skill: pass.skill,
        origin,
        status: 'skipped',
        durationMs: 0,
        findings: 0,
        reason: pass.skip,
      })
      continue
    }
    ran++
    if (pass !== undefined) deps.events?.passStarted?.(pass, index)
    const tools = deps.tools?.('review')
    try {
      const output = await deps.provider.review(
        buildReviewPrompt(request, createNonce(), tools, pass),
      )
      const report = parseReviewReport(output.text)
      const findings =
        pass === undefined
          ? report.findings
          : report.findings.map((finding) => ({ ...finding, skill: pass.skill }))
      answered.outputs.push({ output, report, findings })
      answered.touched.push(...(tools?.touchedPaths() ?? []))
      answered.durationMs += output.durationMs
      answered.usage = sumUsage(answered.usage, output.usage)
      if (pass !== undefined) {
        answered.reports.push({
          skill: pass.skill,
          origin,
          status: 'reviewed',
          durationMs: output.durationMs,
          ...(output.usage === undefined ? {} : { usage: output.usage }),
          findings: findings.length,
        })
      }
    } catch (error) {
      if (pass === undefined || planned.length === 1) throw error
      firstError ??= error
      const message = error instanceof Error ? error.message : String(error)
      answered.warnings.push(`Skill ${pass.skill} failed: ${message}`)
      answered.reports.push({
        skill: pass.skill,
        origin,
        status: 'failed',
        durationMs: 0,
        findings: 0,
        reason: message,
      })
    }
  }
  if (ran > 0 && answered.outputs.length === 0) throw firstError
  return answered
}

function otherModels(
  outputs: readonly AnsweredPass[],
  model: string | undefined,
): string[] | undefined {
  const others = [
    ...new Set(
      outputs.flatMap(({ output }, index) => [
        ...(index === 0 || output.model === undefined ? [] : [output.model]),
        ...(output.additionalModels ?? []),
      ]),
    ),
  ].filter((name) => name !== model)
  return others.length === 0 ? undefined : others
}

function sumUsage(
  review: TokenUsage | undefined,
  verification: TokenUsage | undefined,
): TokenUsage | undefined {
  if (review === undefined || verification === undefined) return review ?? verification
  return {
    inputTokens: review.inputTokens + verification.inputTokens,
    outputTokens: review.outputTokens + verification.outputTokens,
  }
}
