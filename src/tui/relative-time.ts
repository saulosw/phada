export interface TimeMessages {
  now: string
  soon: string
  ago(span: string): string
  in(span: string, estimated: boolean): string
}

const NOW_SECONDS = 10

export function relativeTime(
  at: string,
  now: Date,
  messages: TimeMessages,
  options: { estimated?: boolean } = {},
): string {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return at
  const seconds = Math.round((time - now.getTime()) / 1000)
  const estimated = options.estimated ?? false
  if (seconds < NOW_SECONDS && (estimated || seconds > -NOW_SECONDS)) {
    return seconds > 0 || estimated ? messages.soon : messages.now
  }
  const span = timeSpan(Math.abs(seconds))
  return seconds < 0 ? messages.ago(span) : messages.in(span, estimated)
}

function timeSpan(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function absoluteTime(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
