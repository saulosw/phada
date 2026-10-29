import type { ReviewOutput, ReviewProvider, TokenUsage } from '../providers/types.js'
import type { Toolbox } from '../investigation/toolbox.js'
import { claimWarnings, mergeClaims } from './claims.js'
import { withKnownReferences, withRuleSeverity } from './context-findings.js'
import { separateDebt, withoutDroppedDebt } from './debt.js'
import { diffFingerprint } from './diff-fingerprint.js'
import { findDiffFile, parseDiffFiles } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import {
  countingToolbox,
  investigationFloor,
  investigationShortfall,
} from './investigation-floor.js'
import { newNonce } from './nonce.js'
import { InvalidReviewReportError } from './errors.js'
import { parseReviewReport } from './parse-report.js'
import type { ParsedReport } from './parse-report.js'
import { buildConvertPrompt } from './convert-prompt.js'
import { buildReviewPrompt } from './prompt.js'
import { scoreFindings } from './score.js'
import { skillBodyText, skillOutputText } from './skill-output.js'
import { checkSuggestions } from './suggestions.js'
import { sumUsage, totalUsage } from './token-usage.js'
import {
  CONFIDENCE_FLOOR,
  isConfidenceCut,
  MAX_CONFIDENCE,
  prepareCandidates,
  splitAtCut,
  summarizeFiles,
  VERIFY_CANDIDATE_FLOOR,
} from './select-findings.js'
import type {
  DebtMode,
  Finding,
  NativeSkillRun,
  PassReport,
  PassUsage,
  ReviewOutcome,
  ReviewRequest,
  SkillBody,
  SkillPass,
} from './types.js'
import { verifyCandidates } from './verify-findings.js'

export const DEFAULT_MIN_CONFIDENCE = 60
export const DEFAULT_DEBT_MODE: DebtMode = 'summary'

export interface RunReviewDeps {
  provider: ReviewProvider
  verifier?: ReviewProvider
  tools?: (pass: 'review' | 'verify') => Toolbox
  runSkill?: (pass: SkillPass) => Promise<NativeSkillRun>
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
  if (first === undefined) {
    return { status: 'skipped', reason: 'no-skill-applies', passes: answered.reports }
  }
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
    (request.ci ?? []).filter(({ state }) => state === 'failing').map(({ name }) => name),
  )
  const prepared = prepareCandidates(
    reported,
    diffFiles,
    minConfidence,
    verify ? VERIFY_CANDIDATE_FLOOR : CONFIDENCE_FLOOR,
  )
  const checked = verify
    ? await verifyCandidates(
        verifiedRequest(request, answered.reports),
        prepared.candidates,
        deps.verifier ?? deps.provider,
        createNonce(),
        deps.tools?.('verify'),
      )
    : undefined
  const debtMode = request.debt ?? DEFAULT_DEBT_MODE
  const kept = withoutDroppedDebt(
    withRuleSeverity(checked?.findings ?? prepared.candidates, request.context),
    debtMode,
  )
  const selection = splitAtCut(kept.findings, minConfidence)
  const { findings, debt } = separateDebt(selection.findings, debtMode)
  const passUsage: PassUsage[] = [
    ...answered.passUsage,
    ...(checked === undefined || checked.verification.candidates === 0
      ? []
      : [usageOf('verify', checked.verification.usage)]),
  ]
  const usage = totalUsage(passUsage)
  const ignored = request.context?.ignored ?? []
  const externalCalls = [...passExternalCalls, ...(checked?.externalCalls ?? [])]
  const warnings = [
    ...new Set([
      ...answered.warnings,
      ...answered.outputs.flatMap(({ output }) => output.warnings ?? []),
      ...(checked?.warnings ?? []),
    ]),
  ]
  const skillBodies = nativeBodies(
    answered.outputs,
    diffFiles,
    verify ? VERIFY_CANDIDATE_FLOOR : CONFIDENCE_FLOOR,
  )
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
      ...(usage === undefined ? {} : { usage }),
      passUsage,
      summary: first.report.summary,
      files: summarizeFiles(first.report.files, findings, diffFiles),
      findings,
      ...(debt.length === 0 ? {} : { debt }),
      worthChecking: selection.worthChecking,
      worthCheckingOmitted: selection.worthCheckingOmitted,
      minConfidence,
      score: scoreFindings(findings),
      dropped: {
        invalid: answered.outputs.reduce((sum, { report }) => sum + report.invalid, 0),
        belowFloor: prepared.belowFloor + selection.belowFloor,
        outsideDiff: prepared.outsideDiff,
        duplicate: prepared.duplicate,
        rejected: checked?.verification.rejected.length ?? 0,
        ...(kept.dropped === 0 ? {} : { debt: kept.dropped }),
      },
      ...(checked === undefined ? {} : { verification: checked.verification }),
      ...(suggested.counts === undefined
        ? {}
        : { suggestions: { ...suggested.counts, dropped: checked?.droppedSuggestions ?? 0 } }),
      claims: mergeClaims(answered.outputs.map(({ report }) => report.claims ?? [])),
      ...(answered.investigatedPasses === 0
        ? {}
        : {
            investigationFloor: {
              expected: investigationFloor(pullRequest.diff),
              shortfalls: answered.shortfalls,
            },
          }),
      ...(ignored.length === 0 ? {} : { ignored: [...ignored] }),
      ...(externalCalls.length === 0 ? {} : { externalCalls }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(request.passes === undefined ? {} : { passes: answered.reports }),
      ...(skillBodies.length === 0 ? {} : { skillBodies }),
    },
  }
}

interface AnsweredPass {
  output: ReviewOutput
  report: ParsedReport
  findings: Finding[]
  body?: SkillBody
}

interface AnsweredPasses {
  outputs: AnsweredPass[]
  reports: PassReport[]
  touched: string[]
  durationMs: number
  passUsage: PassUsage[]
  warnings: string[]
  investigatedPasses: number
  shortfalls: string[]
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
    passUsage: [],
    warnings: [],
    investigatedPasses: 0,
    shortfalls: [],
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
    if (pass?.mode === 'native') {
      let native: Awaited<ReturnType<typeof runNativePass>>
      try {
        native = await runNativePass(request, deps, createNonce, pass)
      } catch (error) {
        if (planned.length === 1 || !isAnswerFailure(error)) throw error
        firstError ??= error
        const message = error instanceof Error ? error.message : String(error)
        answered.warnings.push(`Skill ${pass.skill} failed: ${message}`)
        answered.reports.push({
          skill: pass.skill,
          origin,
          status: 'failed',
          mode: 'native',
          durationMs: 0,
          findings: 0,
          reason: message,
        })
        continue
      }
      answered.outputs.push(native.answer)
      answered.durationMs += native.answer.output.durationMs
      answered.passUsage.push(usageOf('review', native.answer.output.usage, pass.skill))
      answered.warnings.push(...native.warnings)
      answered.reports.push(native.report)
      continue
    }
    const tools = deps.tools?.('review')
    const counted = tools === undefined ? undefined : countingToolbox(tools)
    try {
      const output = await deps.provider.review(
        buildReviewPrompt(request, createNonce(), counted?.toolbox, pass),
      )
      answered.passUsage.push(usageOf('review', output.usage, pass?.skill))
      const report = parseReviewReport(output.text)
      const findings =
        pass === undefined
          ? report.findings
          : report.findings.map((finding) => ({ ...finding, skill: pass.skill }))
      answered.outputs.push({ output, report, findings })
      answered.warnings.push(...claimWarnings(report, pass?.skill))
      if (counted !== undefined && output.withoutTools !== true) {
        answered.investigatedPasses++
        const shortfall = investigationShortfall(
          counted.calls(),
          request.pullRequest.diff,
          pass?.skill,
        )
        if (shortfall !== undefined) {
          answered.shortfalls.push(shortfall)
          answered.warnings.push(shortfall)
        }
      }
      answered.touched.push(...(tools?.touchedPaths() ?? []))
      answered.durationMs += output.durationMs
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
      if (pass === undefined || planned.length === 1 || !isAnswerFailure(error)) throw error
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

const EMPTY_REPORT: ParsedReport = {
  summary: '',
  files: [],
  findings: [],
  invalid: 0,
  claims: [],
  invalidClaims: 0,
}

async function runNativePass(
  request: ReviewRequest,
  deps: RunReviewDeps,
  createNonce: () => string,
  pass: SkillPass,
): Promise<{ answer: AnsweredPass; report: PassReport; warnings: string[] }> {
  if (deps.runSkill === undefined) {
    throw new Error(`Skill ${pass.skill} runs natively but no skill runner was given.`)
  }
  const run = await deps.runSkill(pass)
  const skillOutput = skillOutputText(run)
  const warnings: string[] = []
  let converted: ReviewOutput | undefined
  let report = EMPTY_REPORT
  try {
    converted = await deps.provider.review(
      buildConvertPrompt(request, createNonce(), pass, skillOutput),
    )
    report = parseReviewReport(converted.text)
    warnings.push(...claimWarnings(report, pass.skill))
  } catch (error) {
    if (!isAnswerFailure(error)) throw error
    warnings.push(
      `Skill ${pass.skill}: Phada could not read the converted review; the skill output is used as the review body.`,
    )
  }
  const findings = report.findings.map((finding) => ({ ...finding, skill: pass.skill }))
  const durationMs = run.durationMs + (converted?.durationMs ?? 0)
  const usage = sumUsage(run.usage, converted?.usage)
  const model = run.model ?? converted?.model
  const output: ReviewOutput = {
    text: converted?.text ?? '',
    durationMs,
    ...(model === undefined ? {} : { model }),
    ...(usage === undefined ? {} : { usage }),
    ...(run.externalCalls === undefined ? {} : { externalCalls: run.externalCalls }),
    ...(run.warnings === undefined ? {} : { warnings: run.warnings }),
  }
  const body = skillBodyText(run)
  return {
    answer: {
      output,
      report,
      findings,
      ...(body.trim() === '' ? {} : { body: { skill: pass.skill, text: body } }),
    },
    report: {
      skill: pass.skill,
      origin: pass.lens.kind === 'default' ? 'phada' : pass.lens.origin,
      status: 'reviewed',
      mode: 'native',
      durationMs,
      ...(usage === undefined ? {} : { usage }),
      findings: findings.length,
      output: skillOutput,
      captured: run.captured.length,
      blocked: run.blocked,
    },
    warnings,
  }
}

function nativeBodies(
  outputs: readonly AnsweredPass[],
  diffFiles: readonly DiffFile[],
  floor: number,
): SkillBody[] {
  return outputs.flatMap(({ body, findings }) => {
    if (body === undefined) return []
    const inDiff = findings.some(
      (finding) =>
        finding.confidence >= floor &&
        findDiffFile(finding.file, diffFiles)?.lines.has(finding.line) === true,
    )
    return inDiff ? [] : [body]
  })
}

function verifiedRequest(request: ReviewRequest, reports: readonly PassReport[]): ReviewRequest {
  if (request.passes === undefined) return request
  const answered = new Set(
    reports.filter(({ status }) => status === 'reviewed').map(({ skill }) => skill),
  )
  return { ...request, passes: request.passes.filter(({ skill }) => answered.has(skill)) }
}

const ANSWER_FAILURES: ReadonlySet<string> = new Set(['invalid-output', 'prompt-too-large'])

function isAnswerFailure(error: unknown): boolean {
  if (error instanceof InvalidReviewReportError) return true
  return (
    error instanceof Error &&
    error.name === 'ProviderError' &&
    'reason' in error &&
    typeof error.reason === 'string' &&
    ANSWER_FAILURES.has(error.reason)
  )
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

function usageOf(
  pass: PassUsage['pass'],
  usage: TokenUsage | undefined,
  skill?: string,
): PassUsage {
  return {
    pass,
    ...(skill === undefined ? {} : { skill }),
    ...(usage === undefined ? {} : { usage }),
  }
}
