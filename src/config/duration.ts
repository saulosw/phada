export const DURATION = /^\d+(s|m|h)$/

const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 }

export function durationMs(text: string): number {
  const unit = text.slice(-1)
  return Number(text.slice(0, -1)) * (UNIT_MS[unit] ?? 0)
}
