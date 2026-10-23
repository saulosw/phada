export type ReviewPass = 'review' | 'verify' | 'recheck'

export interface ToolCallRecord {
  pass: ReviewPass
  tool: string
  server?: string
  args: unknown
  paths: string[]
  touched: string[]
  bytes: number
  durationMs: number
  error?: string
}

export class ToolLog {
  readonly records: ToolCallRecord[] = []

  add(record: ToolCallRecord): void {
    this.records.push(record)
  }
}
