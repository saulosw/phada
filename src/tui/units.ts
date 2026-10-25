const BYTE_UNITS = ['KB', 'MB', 'GB']

export function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts = [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(rest > 0 || seconds === 0 ? [`${rest}s`] : []),
  ]
  return parts.join('')
}

export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let scaled = bytes / 1024
  let unit = 0
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(1)} ${BYTE_UNITS[unit]}`
}
