import { pathToFileURL } from 'node:url'

export const PLACEHOLDER_MESSAGE = 'phada: nothing to review yet'

export function main(): number {
  console.log(PLACEHOLDER_MESSAGE)
  return 0
}

// Run only when executed directly (npm run dev), never when imported by tests.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main()
}
