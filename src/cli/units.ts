export function formatDuration(ms: number): string {
  const tenthsOfSecond = Math.round(ms / 100)
  if (tenthsOfSecond < 600) return `${(tenthsOfSecond / 10).toFixed(1)}s`
  return formatMinutes(Math.round(ms / 1000))
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : formatMinutes(seconds)
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  return withUnit(count, 1000, ['k', 'M'], '')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return withUnit(bytes, 1024, ['KB', 'MB'], ' ')
}

export function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function withUnit(
  value: number,
  base: number,
  units: readonly string[],
  separator: string,
): string {
  let scaled = value / base
  let index = 0
  while (Math.round(scaled * 10) >= base * 10 && index < units.length - 1) {
    scaled /= base
    index += 1
  }
  return `${scaled.toFixed(1)}${separator}${units[index]}`
}

function formatMinutes(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}m${seconds}s`
}
