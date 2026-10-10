import { posix } from 'node:path'

export function phadaDirs(changedFiles: readonly string[]): string[] {
  const dirs = new Set<string>([''])
  for (const file of changedFiles) {
    const parts = posix
      .dirname(file)
      .split('/')
      .filter((part) => part !== '' && part !== '.')
    parts.forEach((_part, index) => dirs.add(parts.slice(0, index + 1).join('/')))
  }
  return [...dirs].sort((a, b) => depth(a) - depth(b) || compare(a, b))
}

export function phadaFiles(dir: string): { config: string; rules: string } {
  const prefix = dir === '' ? '' : `${dir}/`
  return { config: `${prefix}.phada/config.yml`, rules: `${prefix}.phada/rules.md` }
}

function depth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
