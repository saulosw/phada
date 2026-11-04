import type { Toolbox } from '../investigation/toolbox.js'

export function recordingReads(toolbox: Toolbox): { toolbox: Toolbox; reads(): string[] } {
  const reads: string[] = []
  return {
    toolbox: {
      ...toolbox,
      touchedPaths: () => toolbox.touchedPaths(),
      call: async (name, args, options) => {
        const result = await toolbox.call(name, args, options)
        const path = readPath(name, args)
        if (path !== undefined && !result.isError) reads.push(path)
        return result
      },
    },
    reads: () => [...reads],
  }
}

function readPath(name: string, args: unknown): string | undefined {
  if (name !== 'read_file' || typeof args !== 'object' || args === null) return undefined
  const { path, repo } = args as Record<string, unknown>
  const inThisRepository = repo === undefined || repo === null || repo === ''
  return typeof path === 'string' && inThisRepository ? path : undefined
}
