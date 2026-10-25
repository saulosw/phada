import { useEffect, useState } from 'react'

export interface TerminalSize {
  columns: number
  rows: number
}

export interface SizeSource {
  current(): TerminalSize
  subscribe(listener: () => void): () => void
}

export interface ResizableOutput {
  columns?: number
  rows?: number
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

export const MIN_SIZE: TerminalSize = { columns: 80, rows: 24 }

export function outputSize(output: ResizableOutput): SizeSource {
  return {
    current: () => ({
      columns: output.columns ?? MIN_SIZE.columns,
      rows: output.rows ?? MIN_SIZE.rows,
    }),
    subscribe: (listener) => {
      output.on('resize', listener)
      return () => {
        output.off('resize', listener)
      }
    },
  }
}

export function isTooSmall({ columns, rows }: TerminalSize): boolean {
  return columns < MIN_SIZE.columns || rows < MIN_SIZE.rows
}

export function useTerminalSize(source: SizeSource): TerminalSize {
  const [size, setSize] = useState(() => source.current())
  useEffect(() => {
    const update = () => setSize(source.current())
    update()
    return source.subscribe(update)
  }, [source])
  return size
}
