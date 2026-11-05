import type { Toolbox } from '../investigation/toolbox.js'

export interface RecordedReads {
  toolbox: Toolbox
  reads(): string[]
  relatedReads(): string[]
  grepped(): string[]
}

const GREP_MATCH = /^(.+?):\d+: /

export function recordingReads(toolbox: Toolbox): RecordedReads {
  const reads: string[] = []
  const relatedReads: string[] = []
  const grepped: string[] = []
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
        if (name === 'grep' && !result.isError) grepped.push(...grepFiles(result.text))
        return result
      },
    },
    reads: () => [...reads],
    relatedReads: () => [...relatedReads],
    grepped: () => [...new Set(grepped)],
  }
}

function grepFiles(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const file = GREP_MATCH.exec(line)?.[1]
    return file === undefined ? [] : [file]
  })
}

function readOf(name: string, args: unknown): { path: string; repo?: string } | undefined {
  if (name !== 'read_file' || typeof args !== 'object' || args === null) return undefined
  const { path, repo } = args as Record<string, unknown>
  if (typeof path !== 'string') return undefined
  if (repo === undefined || repo === null || repo === '') return { path }
  return typeof repo === 'string' ? { path, repo } : undefined
}
