export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await run(items[index] as T, index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
