import type { AiRun, ReviewProgress } from '../app/review-progress.js'
import type { UiMessages } from './i18n/messages.js'
import { oneLine } from './text-fit.js'
import { durationText } from './units.js'

export type ReviewStep =
  | { kind: 'fetch'; title?: string }
  | { kind: 'context'; rules: number; docs: number }
  | { kind: 'conversation'; items: number }
  | { kind: 'ci'; state: string }
  | { kind: 'ciWait'; pending: number; waited: boolean }
  | { kind: 'index'; done: number; total: number }
  | { kind: 'related'; count: number }
  | { kind: 'impact'; symbols: number }
  | { kind: 'pass'; skill: string; index: number; total: number }
  | { kind: 'ai'; provider: string; run: AiRun; startedAt: number; endedAt?: number }
  | { kind: 'publish' }

export interface ReviewSteps {
  steps: ReviewStep[]
  warnings: string[]
}

export const NO_STEPS: ReviewSteps = { steps: [{ kind: 'fetch' }], warnings: [] }

export function stepsAfter(state: ReviewSteps, event: ReviewProgress, now: number): ReviewSteps {
  const add = (step: ReviewStep): ReviewSteps => ({ ...state, steps: [...state.steps, step] })
  const replaceLast = (kind: ReviewStep['kind'], step: ReviewStep): ReviewSteps => {
    const index = state.steps.findLastIndex((entry) => entry.kind === kind)
    if (index < 0) return add(step)
    return { ...state, steps: state.steps.map((entry, at) => (at === index ? step : entry)) }
  }
  switch (event.kind) {
    case 'fetched':
      return replaceLast('fetch', { kind: 'fetch', title: event.pullRequest.title })
    case 'contextLoaded':
      return add({
        kind: 'context',
        rules: event.report.rules.filter(({ status }) => status === 'applied').length,
        docs: event.report.docs.filter(({ status }) => status === 'included').length,
      })
    case 'conversationRead':
      return add({ kind: 'conversation', items: event.conversation.report.items })
    case 'ciRead':
      return add({ kind: 'ci', state: event.ci.summary.state })
    case 'ciWaiting':
      return replaceLast('ciWait', {
        kind: 'ciWait',
        pending: event.wait.pending.length,
        waited: false,
      })
    case 'ciWaited':
      return replaceLast('ciWait', { kind: 'ciWait', pending: 0, waited: true })
    case 'indexing':
      return add({ kind: 'index', done: 0, total: event.total })
    case 'indexed':
      return replaceLast('index', { kind: 'index', done: event.done, total: event.total })
    case 'relatedReady': {
      const count = event.report.repositories.length
      return count === 0 ? state : add({ kind: 'related', count })
    }
    case 'impactReady':
      return event.report.status === 'used'
        ? add({ kind: 'impact', symbols: event.report.changed.length })
        : state
    case 'passStarted':
      return event.total > 1
        ? add({ kind: 'pass', skill: event.skill, index: event.index, total: event.total })
        : state
    case 'aiStarted':
      return add({ kind: 'ai', provider: event.provider, run: event.run, startedAt: now })
    case 'aiFinished':
      return {
        ...state,
        steps: state.steps.map((entry, at) =>
          at === runningAi(state.steps, event.run) && entry.kind === 'ai'
            ? { ...entry, endedAt: now }
            : entry,
        ),
      }
    case 'publishing':
      return add({ kind: 'publish' })
    case 'warning':
      return { ...state, warnings: [...state.warnings, event.message] }
    case 'passesPlanned':
      return state
  }
}

function runningAi(steps: readonly ReviewStep[], run: AiRun): number {
  return steps.findLastIndex(
    (entry) => entry.kind === 'ai' && entry.run === run && entry.endedAt === undefined,
  )
}

export function stepRunning(step: ReviewStep, last: boolean): boolean {
  switch (step.kind) {
    case 'fetch':
      return step.title === undefined
    case 'ai':
      return step.endedAt === undefined
    case 'index':
      return last && step.done < step.total
    case 'ciWait':
      return !step.waited
    case 'publish':
      return last
    default:
      return false
  }
}

export function stepText(
  step: ReviewStep,
  ref: string,
  messages: UiMessages,
  time: number,
): string {
  const s = messages.reviewFlow.steps
  switch (step.kind) {
    case 'fetch':
      return step.title === undefined ? s.fetching(ref) : s.fetched(oneLine(step.title))
    case 'context':
      return s.context(step.rules, step.docs)
    case 'conversation':
      return s.conversation(step.items)
    case 'ci':
      return s.ci(messages.reviews.ciStates[step.state] ?? oneLine(step.state))
    case 'ciWait':
      return step.waited ? s.ciWaited : s.ciWaiting(step.pending)
    case 'index':
      return s.indexing(step.done, step.total)
    case 'related':
      return s.related(step.count)
    case 'impact':
      return s.impact(step.symbols)
    case 'pass':
      return s.pass(oneLine(step.skill), step.index, step.total)
    case 'ai':
      return s.ai(
        oneLine(step.provider),
        messages.reviewFlow.runs[step.run],
        durationText((step.endedAt ?? time) - step.startedAt),
      )
    case 'publish':
      return s.publishing
  }
}
