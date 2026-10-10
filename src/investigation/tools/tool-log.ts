export type ReviewPass = 'review' | 'verify'

export interface ToolCallRecord {
  pass: ReviewPass
  tool: string
  args: unknown
  paths: string[]
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
