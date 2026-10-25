export const MAX_LISTED_NAMES = 5

export function firstNames(
  names: readonly string[],
  show: (name: string) => string = (name) => name,
): string[] {
  return names.slice(0, MAX_LISTED_NAMES).map(show)
}

export function joinNames(
  shown: readonly string[],
  total: number,
  more: (count: number) => string = (count) => `${count} more`,
): string {
  const left = total - shown.length
  return [...shown, ...(left > 0 ? [more(left)] : [])].join(', ')
}

export function nameList(
  names: readonly string[],
  show: (name: string) => string = (name) => name,
): string {
  return joinNames(firstNames(names, show), names.length)
}
