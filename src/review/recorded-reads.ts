import type { Toolbox } from '../investigation/toolbox.js'

export interface RecordedReads {
  toolbox: Toolbox
  reads(): string[]
  relatedReads(): string[]
}

export function recordingReads(toolbox: Toolbox): RecordedReads {
  const reads: string[] = []
  const relatedReads: string[] = []
  return {
    toolbox: {
      ...toolbox,
      touchedPaths: () => toolbox.touchedPaths(),
      call: async (name, args, options) => {
        const result = await toolbox.call(name, args, options)
        const read = readOf(name, args)
        if (read !== undefined && !result.isError) {
          if (read.repo === undefined) reads.push(read.path)
          else relatedReads.push(`${read.repo}:${read.path}`)
        }
        return result
      },
    },
    reads: () => [...reads],
    relatedReads: () => [...relatedReads],
  }
}

function readOf(name: string, args: unknown): { path: string; repo?: string } | undefined {
  if (name !== 'read_file' || typeof args !== 'object' || args === null) return undefined
  const { path, repo } = args as Record<string, unknown>
  if (typeof path !== 'string') return undefined
  if (repo === undefined || repo === null || repo === '') return { path }
  return typeof repo === 'string' ? { path, repo } : undefined
}
