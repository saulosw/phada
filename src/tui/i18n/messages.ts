import type { QueueJob } from '../../app/read-queue.js'
import type { TimeMessages } from '../relative-time.js'
import { english } from './en.js'
import { spanish } from './es.js'
import { portuguese } from './pt.js'

export type ScreenId =
  'home' | 'repositories' | 'rules' | 'reviews' | 'queue' | 'automation' | 'provider' | 'learnings'

export interface ScreenTitle {
  full: string
  short: string
}

export interface UiMessages {
  screens: Readonly<Record<ScreenId, ScreenTitle>>
  keys: {
    screens: string
    cycle: string
    jump: string
    palette: string
    help: string
    back: string
    quit: string
    more: string
    select: string
    open: string
    close: string
    refresh: string
  }
  help: { title: string; global: string }
  palette: { title: string; empty: string }
  tooSmall(columns: number, rows: number): string
  tooSmallHint: string
  placeholder: string
  home: { tagline: string }
  loading: string
  failed(message: string): string
  time: TimeMessages
  list: { range(first: number, last: number, total: number): string; scroll: string }
  field: { apply: string; cancel: string }
  requests: {
    sources: Readonly<Record<RequestSource, string>>
    publish: Readonly<Record<QueueJob['requests'][number]['publish'], string>>
    author(login: string): string
    channel(id: string): string
  }
  queue: QueueMessages
}

type RequestSource = QueueJob['requests'][number]['source']
export type QueueRowKind = 'running' | 'waiting' | 'queued' | 'skipped' | 'failed'

export interface QueueMessages {
  running(pid: number): string
  stopped: string
  lastCycle(when: string): string
  next(when: string): string
  startWith: string
  paused(until: string, relative: string, reason: string): string
  pauseReasons: { rateLimit: string; usageLimit: string }
  hourly(count: number, max: number): string
  never: string
  empty: string
  kinds: Readonly<Record<QueueRowKind, string>>
  statuses: Readonly<Record<QueueJob['job']['status'], string>>
  started(when: string): string
  starts(when: string): string
  ready: string
  attempt(number: number): string
  ciUntil(when: string): string
  pending(count: number, names: string): string
  noChecks: string
  failing(names: string): string
  checked(when: string): string
  askedFrom(sources: string): string
  detail: {
    created: string
    notBefore: string
    started: string
    finished: string
    ciDeadline: string
    pending: string
    failing: string
    checked: string
    attempts: string
    error: string
    publish: string
    requests(count: number): string
    gone: string
  }
}

const CATALOGS: Readonly<Record<string, UiMessages>> = {
  en: english,
  pt: portuguese,
  es: spanish,
}

export function uiMessagesFor(language: string | undefined): UiMessages {
  const base = language?.split('-', 1)[0]?.toLowerCase() ?? 'en'
  return CATALOGS[base] ?? english
}
