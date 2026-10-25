export type ColorLevel = 'none' | '16' | '256' | 'truecolor'

export type ColorToken = 'accent' | 'soft' | 'dim' | 'ok' | 'warn' | 'error' | 'info'

export interface Theme {
  level: ColorLevel
  colors: Partial<Record<ColorToken, string>>
}

export type ColorEnv = Readonly<Record<string, string | undefined>>

const VIOLETA: Record<ColorToken, string> = {
  accent: '#8B5CF6',
  soft: '#C4B5FD',
  dim: '#7C6F9B',
  ok: '#4ADE80',
  warn: '#FACC15',
  error: '#F87171',
  info: '#38BDF8',
}

const NAMED: Record<ColorToken, string> = {
  accent: 'magentaBright',
  soft: 'magenta',
  dim: 'gray',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  info: 'cyan',
}

const FORCED: Readonly<Record<string, ColorLevel>> = {
  '0': 'none',
  '1': '16',
  '2': '256',
  '3': 'truecolor',
}

export function colorLevel(env: ColorEnv): ColorLevel {
  if ((env.NO_COLOR ?? '') !== '') return 'none'
  const forced = FORCED[env.FORCE_COLOR ?? '']
  if (forced !== undefined) return forced
  const term = env.TERM ?? ''
  if (term === 'dumb') return 'none'
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor'
  if (term.includes('256color')) return '256'
  return '16'
}

export function resolveTheme(level: ColorLevel): Theme {
  if (level === 'none') return { level, colors: {} }
  const tokens = Object.keys(VIOLETA) as ColorToken[]
  const colors = Object.fromEntries(tokens.map((token) => [token, tokenColor(token, level)]))
  return { level, colors }
}

function tokenColor(token: ColorToken, level: Exclude<ColorLevel, 'none'>): string {
  if (level === 'truecolor') return VIOLETA[token]
  if (level === '256') return `ansi256(${nearestXterm(VIOLETA[token])})`
  return NAMED[token]
}

const CUBE = [0, 95, 135, 175, 215, 255]

function nearestXterm(hex: string): number {
  const target = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))
  const candidates: [number, number[]][] = []
  for (let index = 16; index < 232; index += 1) {
    const offset = index - 16
    const rgb = [Math.floor(offset / 36), Math.floor(offset / 6) % 6, offset % 6]
    candidates.push([index, rgb.map((step) => CUBE[step] ?? 0)])
  }
  for (let index = 232; index < 256; index += 1) {
    const gray = 8 + (index - 232) * 10
    candidates.push([index, [gray, gray, gray]])
  }
  let best = 16
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [index, rgb] of candidates) {
    const distance = rgb.reduce((sum, value, i) => sum + (value - (target[i] ?? 0)) ** 2, 0)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return best
}
