import type { ReviewOutput, ReviewProvider, TokenUsage } from '../providers/types.js'
import type { Toolbox } from '../investigation/toolbox.js'
import { claimWarnings, mergeClaims, withSettledClaims } from './claims.js'
import { withKnownReferences, withRuleSeverity } from './context-findings.js'
import { separateDebt, withoutDroppedDebt } from './debt.js'
import { diffFingerprint } from './diff-fingerprint.js'
import { changedFiles, groupDiff, planDiffGroups } from './diff-groups.js'
import { mapLimit } from './map-limit.js'
import { findDiffFile, parseDiffFiles } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import { measureCoverage } from './coverage.js'
import { recordingReads } from './recorded-reads.js'
import { withBackedReimplementations } from './reimplementation.js'
import { newNonce } from './nonce.js'
import { InvalidReviewReportError } from './errors.js'
import { parseReviewReport } from './parse-report.js'
import type { ParsedReport } from './parse-report.js'
import { buildContinuationPrompt } from './continuation-prompt.js'
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
  Coverage,
  DebtMode,
  DiffGroup,
  DiffGroupReport,
  FileDeclaration,
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
  events?: {
    passStarted?(pass: SkillPass, index: number): void
    groupStarted?(group: DiffGroup, index: number, total: number, pass?: SkillPass): void
  }
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
  const groups =
    request.groups === undefined
      ? undefined
      : planDiffGroups(pullRequest.diff, request.context?.generated)
  const answered = await runPasses(
    request,
    deps,
    createNonce,
    groups === undefined ? undefined : { groups, concurrency: request.groups?.concurrency ?? 1 },
  )
  const first = answered.outputs[0]
  if (first === undefined) {
    return { status: 'skipped', reason: 'no-skill-applies', passes: answered.reports }
  }
  const diffFiles = parseDiffFiles(pullRequest.diff)
  const measured = coverageOf(answered.coverage, diffFiles)
  const continuation =
    measured?.level === 'low' && request.continuation !== false
      ? await continueReview(request, deps, answered, measured)
      : undefined
  const continued = continuation?.pass
  const coverage =
    measured === undefined || continued === undefined
      ? measured
      : continuedCoverage(measured, answered.coverage, continued, diffFiles)
  const verify = request.verify === true
  const suggested = checkSuggestions(
    [...answered.outputs.flatMap(({ findings }) => findings), ...(continued?.findings ?? [])],
    diffFiles,
  )
  const passExternalCalls = [
    ...answered.outputs,
    ...(continued === undefined ? [] : [continued]),
  ].flatMap(({ output }) => output.externalCalls ?? [])
  const reported = withKnownReferences(
    suggested.findings,
    request.context,
    diffFiles.map((file) => file.path),
    {
      touched: [...answered.touched, ...(continued?.touched ?? [])],
      servers: passExternalCalls.map((call) => call.server),
    },
    (request.ci ?? []).filter(({ state }) => state === 'failing').map(({ name }) => name),
  )
  const backed = withBackedReimplementations(reported, {
    repo: pullRequest.repo,
    reads: [
      ...answered.coverage.reads,
      ...answered.relatedReads,
      ...(continued?.reads ?? []),
      ...(continued?.relatedReads ?? []),
    ],
    diffFiles,
  })
  const prepared = prepareCandidates(
    backed.findings,
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
    ...(continued === undefined ? [] : [usageOf('continuation', continued.output.usage)]),
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
      ...(continued?.output.warnings ?? []),
      ...(continuation?.warning === undefined ? [] : [continuation.warning]),
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
      durationMs:
        answered.durationMs +
        (continued?.output.durationMs ?? 0) +
        (checked?.verification.durationMs ?? 0),
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
      ...(coverage === undefined ? {} : { coverage }),
      dropped: {
        invalid:
          answered.outputs.reduce((sum, { report }) => sum + report.invalid, 0) +
          (continued?.invalid ?? 0),
        belowFloor: prepared.belowFloor + selection.belowFloor,
        outsideDiff: prepared.outsideDiff + answered.outsideGroups,
        duplicate: prepared.duplicate,
        rejected: checked?.verification.rejected.length ?? 0,
        ...(kept.dropped === 0 ? {} : { debt: kept.dropped }),
        ...(backed.unbacked === 0 ? {} : { unbacked: backed.unbacked }),
      },
      ...(checked === undefined ? {} : { verification: checked.verification }),
      ...(suggested.counts === undefined
        ? {}
        : { suggestions: { ...suggested.counts, dropped: checked?.droppedSuggestions ?? 0 } }),
      claims: mergeClaims(
        answered.outputs.map(({ report, onlySettledClaims }) => ({
          claims: report.claims ?? [],
          onlySettled: onlySettledClaims === true,
        })),
      ),
      ...(ignored.length === 0 ? {} : { ignored: [...ignored] }),
      ...(externalCalls.length === 0 ? {} : { externalCalls }),
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(request.passes === undefined ? {} : { passes: answered.reports }),
      ...(answered.grouped ? { groups: answered.groups } : {}),
      ...(skillBodies.length === 0 ? {} : { skillBodies }),
    },
  }
}

interface AnsweredPass {
  output: ReviewOutput
  report: ParsedReport
  findings: Finding[]
  body?: SkillBody
  onlySettledClaims?: true
}

interface AnsweredPasses {
  outputs: AnsweredPass[]
  reports: PassReport[]
  touched: string[]
  relatedReads: string[]
  durationMs: number
  passUsage: PassUsage[]
  warnings: string[]
  coverage: TextPassCoverage
  outsideGroups: number
  groups: DiffGroupReport[]
  grouped: boolean
}

interface GroupPlan {
  groups: DiffGroup[]
  concurrency: number
}

interface TextAnswer {
  answer: AnsweredPass
  nonce: string
  reads: string[]
  relatedReads: string[]
  verified: boolean
  touched: string[]
  durationMs: number
  usage?: TokenUsage
  warnings: string[]
  outsideGroups: number
}

interface TextPassCoverage {
  passes: number
  declarations: FileDeclaration[]
  reads: string[]
  verified: boolean
  first?: { pass: SkillPass | undefined; nonce: string }
}

interface ContinuedPass {
  output: ReviewOutput
  findings: Finding[]
  invalid: number
  declarations: FileDeclaration[]
  reads: string[]
  relatedReads: string[]
  verified: boolean
  touched: string[]
}

function coverageOf(
  { passes, declarations, reads, verified }: TextPassCoverage,
  files: readonly DiffFile[],
): Coverage | undefined {
  return passes === 0
    ? undefined
    : measureCoverage({ files, declarations, reads: new Set(reads), verified })
}

function continuedCoverage(
  before: Coverage,
  first: TextPassCoverage,
  continued: ContinuedPass,
  files: readonly DiffFile[],
): Coverage {
  return {
    ...measureCoverage({
      files,
      declarations: [...first.declarations, ...continued.declarations],
      reads: new Set([...first.reads, ...continued.reads]),
      verified: first.verified && continued.verified,
    }),
    continuation: { before: { level: before.level, covered: before.covered, total: before.total } },
  }
}

async function continueReview(
  request: ReviewRequest,
  deps: RunReviewDeps,
  answered: AnsweredPasses,
  measured: Coverage,
): Promise<{ pass?: ContinuedPass; warning?: string } | undefined> {
  const first = answered.coverage.first
  if (first === undefined) return undefined
  const { pass, nonce } = first
  const tools = deps.tools?.('review')
  const recorded = tools === undefined ? undefined : recordingReads(tools)
  try {
    const output = await deps.provider.review(
      buildContinuationPrompt(request, nonce, recorded?.toolbox, pass, {
        gaps: measured.gaps,
        findings: answered.outputs.flatMap(({ findings }) => findings),
      }),
    )
    const report = parseReviewReport(output.text)
    return {
      pass: {
        output,
        findings:
          pass === undefined
            ? report.findings
            : report.findings.map((finding) => ({ ...finding, skill: pass.skill })),
        invalid: report.invalid,
        declarations: report.files,
        reads: recorded?.reads() ?? [],
        relatedReads: recorded?.relatedReads() ?? [],
        verified: recorded !== undefined && output.withoutTools !== true,
        touched: [...(tools?.touchedPaths() ?? [])],
      },
    }
  } catch (error) {
    if (!isAnswerFailure(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    return {
      warning: `The continuation pass failed, so the review keeps the first answer: ${message}`,
    }
  }
}

async function runPasses(
  request: ReviewRequest,
  deps: RunReviewDeps,
  createNonce: () => string,
  plan: GroupPlan | undefined,
): Promise<AnsweredPasses> {
  const passes = request.passes
  const planned: (SkillPass | undefined)[] = passes ?? [undefined]
  const answered: AnsweredPasses = {
    outputs: [],
    reports: [],
    touched: [],
    relatedReads: [],
    durationMs: 0,
    passUsage: [],
    warnings: [],
    coverage: { passes: 0, declarations: [], reads: [], verified: true },
    outsideGroups: 0,
    groups: plan?.groups.map((group) => ({ ...group, findings: 0, durationMs: 0 })) ?? [],
    grouped: false,
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
    try {
      const text =
        plan === undefined
          ? await answerWhole(request, deps, createNonce, pass, answered.passUsage)
          : await answerInGroups(request, deps, createNonce, pass, plan, answered)
      recordText(answered, pass, origin, text)
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

function recordText(
  answered: AnsweredPasses,
  pass: SkillPass | undefined,
  origin: string,
  text: TextAnswer,
): void {
  answered.outputs.push(text.answer)
  answered.warnings.push(...text.warnings)
  if (answered.coverage.passes === 0) answered.coverage.first = { pass, nonce: text.nonce }
  answered.coverage.passes++
  answered.coverage.declarations.push(...text.answer.report.files)
  answered.coverage.reads.push(...text.reads)
  answered.relatedReads.push(...text.relatedReads)
  if (!text.verified) answered.coverage.verified = false
  answered.touched.push(...text.touched)
  answered.durationMs += text.durationMs
  answered.outsideGroups += text.outsideGroups
  if (pass !== undefined) {
    answered.reports.push({
      skill: pass.skill,
      origin,
      status: 'reviewed',
      durationMs: text.durationMs,
      ...(text.usage === undefined ? {} : { usage: text.usage }),
      findings: text.answer.findings.length,
    })
  }
}

async function answerWhole(
  request: ReviewRequest,
  deps: RunReviewDeps,
  createNonce: () => string,
  pass: SkillPass | undefined,
  usage: PassUsage[],
): Promise<TextAnswer> {
  const tools = deps.tools?.('review')
  const recorded = tools === undefined ? undefined : recordingReads(tools)
  const nonce = createNonce()
  const output = await deps.provider.review(
    buildReviewPrompt(request, nonce, recorded?.toolbox, pass),
  )
  usage.push(usageOf('review', output.usage, pass?.skill))
  const report = parseReviewReport(output.text)
  return {
    answer: { output, report, findings: withSkill(report.findings, pass) },
    nonce,
    reads: recorded?.reads() ?? [],
    relatedReads: recorded?.relatedReads() ?? [],
    verified: recorded !== undefined && output.withoutTools !== true,
    touched: [...(tools?.touchedPaths() ?? [])],
    durationMs: output.durationMs,
    ...(output.usage === undefined ? {} : { usage: output.usage }),
    warnings: claimWarnings(report, pass?.skill),
    outsideGroups: 0,
  }
}

interface GroupAnswer {
  output: ReviewOutput
  report: ParsedReport
  findings: Finding[]
  nonce: string
  reads: string[]
  relatedReads: string[]
  verified: boolean
  touched: string[]
}

async function answerInGroups(
  request: ReviewRequest,
  deps: RunReviewDeps,
  createNonce: () => string,
  pass: SkillPass | undefined,
  plan: GroupPlan,
  answered: AnsweredPasses,
): Promise<TextAnswer> {
  const diff = request.pullRequest.diff
  const changed = changedFiles(diff)
  const total = plan.groups.length
  const asked = await mapLimit(plan.groups, plan.concurrency, async (group, index) => {
    deps.events?.groupStarted?.(group, index, total, pass)
    const tools = deps.tools?.('review')
    const recorded = tools === undefined ? undefined : recordingReads(tools)
    const nonce = createNonce()
    const part = groupDiff(diff, group.files)
    try {
      const output = await deps.provider.review(
        buildReviewPrompt(
          { ...request, pullRequest: { ...request.pullRequest, diff: part } },
          nonce,
          recorded?.toolbox,
          pass,
          { index, total, group, changed },
        ),
      )
      return { output, nonce, part, tools, recorded }
    } catch (error) {
      if (!isAnswerFailure(error)) throw error
      return { error }
    }
  })
  answered.grouped = true
  const answers: GroupAnswer[] = []
  const warnings: string[] = []
  let outsideGroups = 0
  let firstError: unknown
  for (const [index, result] of asked.entries()) {
    const group = plan.groups[index]
    const tally = answered.groups[index]
    if (group === undefined || tally === undefined) continue
    const fail = (error: unknown) => {
      firstError ??= error
      tally.failed = true
      const message = error instanceof Error ? error.message : String(error)
      const of = pass === undefined ? '' : ` of skill ${pass.skill}`
      warnings.push(
        `Group ${index + 1}/${total} (${group.label})${of} failed, so its files are left as gaps: ${message}`,
      )
    }
    if ('error' in result) {
      fail(result.error)
      continue
    }
    const { output, nonce, part, tools, recorded } = result
    answered.passUsage.push({ ...usageOf('review', output.usage, pass?.skill), group: group.label })
    tally.durationMs += output.durationMs
    const usage = sumUsage(tally.usage, output.usage)
    if (usage !== undefined) tally.usage = usage
    let report: ParsedReport
    try {
      report = parseReviewReport(output.text)
    } catch (error) {
      if (!isAnswerFailure(error)) throw error
      fail(error)
      continue
    }
    const files = parseDiffFiles(part)
    const inGroup = report.findings.filter(
      ({ file, line }) => findDiffFile(file, files)?.lines.has(line) === true,
    )
    outsideGroups += report.findings.length - inGroup.length
    tally.findings += inGroup.length
    warnings.push(...claimWarnings(report, pass?.skill))
    answers.push({
      output,
      report: { ...report, findings: inGroup },
      findings: withSkill(inGroup, pass),
      nonce,
      reads: recorded?.reads() ?? [],
      relatedReads: recorded?.relatedReads() ?? [],
      verified: recorded !== undefined && output.withoutTools !== true,
      touched: [...(tools?.touchedPaths() ?? [])],
    })
  }
  const first = answers[0]
  if (first === undefined) throw firstError
  const usage = answers.reduce<TokenUsage | undefined>(
    (sum, { output }) => sumUsage(sum, output.usage),
    undefined,
  )
  const durationMs = answers.reduce((sum, { output }) => sum + output.durationMs, 0)
  const model = first.output.model
  const additionalModels = otherModels(answers, model)
  const externalCalls = answers.flatMap(({ output }) => output.externalCalls ?? [])
  const outputWarnings = answers.flatMap(({ output }) => output.warnings ?? [])
  const output: ReviewOutput = {
    text: '',
    durationMs,
    ...(model === undefined ? {} : { model }),
    ...(additionalModels === undefined ? {} : { additionalModels }),
    ...(usage === undefined ? {} : { usage }),
    ...(externalCalls.length === 0 ? {} : { externalCalls }),
    ...(outputWarnings.length === 0 ? {} : { warnings: outputWarnings }),
  }
  const report: ParsedReport = {
    summary: answers
      .map(({ report: part }) => part.summary.trim())
      .filter((summary) => summary !== '')
      .join(' '),
    files: answers.flatMap(({ report: part }) => part.files),
    findings: answers.flatMap(({ report: part }) => part.findings),
    invalid: answers.reduce((sum, { report: part }) => sum + part.invalid, 0),
    claims: mergeClaims(
      answers.map(({ report: part }) => ({ claims: part.claims ?? [], onlySettled: false })),
    ),
    invalidClaims: answers.reduce((sum, { report: part }) => sum + part.invalidClaims, 0),
  }
  return {
    answer: { output, report, findings: answers.flatMap(({ findings }) => findings) },
    nonce: first.nonce,
    reads: answers.flatMap(({ reads }) => reads),
    relatedReads: answers.flatMap(({ relatedReads }) => relatedReads),
    verified: answers.every(({ verified }) => verified),
    touched: answers.flatMap(({ touched }) => touched),
    durationMs,
    ...(usage === undefined ? {} : { usage }),
    warnings,
    outsideGroups,
  }
}

function withSkill(findings: readonly Finding[], pass: SkillPass | undefined): Finding[] {
  return pass === undefined
    ? [...findings]
    : findings.map((finding) => ({ ...finding, skill: pass.skill }))
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
    report = withSettledClaims(parseReviewReport(converted.text))
    warnings.push(...claimWarnings(report, pass.skill))
  } catch (error) {
    if (!isAnswerFailure(error)) throw error
    warnings.push(
      `Skill ${pass.skill}: Phada could not read the converted review; the skill output is used as the review body.`,
    )
  }
  const findings = report.findings.map(({ existing: _existing, ...finding }) => ({
    ...finding,
    skill: pass.skill,
  }))
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
      onlySettledClaims: true,
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
  outputs: readonly { output: ReviewOutput }[],
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
