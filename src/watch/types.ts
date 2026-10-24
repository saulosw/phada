export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'superseded'
export type RequestSource = 'watch' | 'enqueue' | 'mcp' | 'pr-command' | 'slack'
export type PublishTarget = 'pr' | 'none'
export type FailureKind = 'transient' | 'usage-limit' | 'rate-limit' | 'definitive' | 'fatal'

export interface PullRecord {
  repo: string
  number: number
  headSha: string
  headSeenAt: string
  baselineSha?: string
  eligible: boolean
  state: 'open' | 'gone'
}

export interface JobRecord {
  id: number
  repo: string
  number: number
  headSha: string
  status: JobStatus
  attempts: number
  notBefore: string
  publish?: PublishTarget
  reason?: string
  errorKind?: FailureKind
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface PauseState {
  until: string
  reason: string
  streak: number
}

export interface RequestRecord {
  id: number
  jobId: number
  source: RequestSource
  publish: PublishTarget
  data?: Record<string, unknown>
  createdAt: string
}
