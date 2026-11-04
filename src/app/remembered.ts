export function remembered<Args extends unknown[], Value>(
  keyOf: (...args: Args) => string,
  read: (...args: Args) => Promise<Value>,
): (...args: Args) => Promise<Value> {
  const known = new Map<string, Promise<Value>>()
  return (...args) => {
    const key = keyOf(...args)
    const earlier = known.get(key)
    if (earlier !== undefined) return earlier
    const reading = read(...args)
    known.set(key, reading)
    reading.catch(() => known.delete(key))
    return reading
  }
}
