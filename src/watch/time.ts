export function later(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}
