import { z } from 'zod'
import type { ToolCallOptions, ToolDefinition, ToolResult, Toolbox } from '../toolbox.js'
import { BUDGET_EXHAUSTED, DEFAULT_TOOL_BUDGET, MAX_ANSWER_BYTES } from './budget.js'
import type { ToolBudget } from './budget.js'
import { CheckoutError } from '../checkout/checkout.js'
import { InvalidRepoPathError } from '../checkout/repo-path.js'
import type { ReviewPass, ToolLog } from './tool-log.js'

export interface ToolOutput {
  text: string
  paths: string[]
  touched: string[]
}

export class ToolFailure extends Error {
  override readonly name = 'ToolFailure'
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface RegisteredTool<A> {
  definition: ToolDefinition
  args: z.ZodType<A>
  run(args: A): Promise<ToolOutput>
}

export function createToolbox(
  tools: readonly RegisteredTool<any>[],
  log: ToolLog,
  pass: ReviewPass,
  budget: ToolBudget = DEFAULT_TOOL_BUDGET,
): Toolbox {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]))
  const touched = new Set<string>()
  let calls = 0
  let bytes = 0

  return {
    definitions: tools.map((tool) => tool.definition),
    touchedPaths: () => [...touched],
    async call(name: string, args: unknown, options: ToolCallOptions = {}): Promise<ToolResult> {
      const startedAt = performance.now()
      const record = (fields: { paths?: string[]; bytes?: number; error?: string }) =>
        log.add({
          pass,
          tool: name,
          args,
          paths: fields.paths ?? [],
          bytes: fields.bytes ?? 0,
          durationMs: performance.now() - startedAt,
          ...(fields.error === undefined ? {} : { error: fields.error }),
        })

      if (calls >= budget.calls || bytes >= budget.bytes) {
        record({ error: 'budget' })
        return { text: BUDGET_EXHAUSTED, isError: true }
      }
      calls += 1
      const tool = byName.get(name)
      if (tool === undefined) {
        record({ error: 'unknown-tool' })
        const available = [...byName.keys()].join(', ')
        return { text: `Unknown tool "${name}". Available: ${available}.`, isError: true }
      }
      const parsed = tool.args.safeParse(args)
      if (!parsed.success) {
        record({ error: 'invalid-arguments' })
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
          .join('; ')
        return { text: `Invalid arguments for ${name}: ${issues}`, isError: true }
      }
      try {
        const output = await tool.run(parsed.data)
        const limit = Math.min(
          MAX_ANSWER_BYTES,
          budget.bytes - bytes,
          options.maxBytes ?? Number.POSITIVE_INFINITY,
        )
        const text = cutToBytes(output.text, limit)
        const size = Buffer.byteLength(text)
        bytes += size
        for (const path of output.touched) touched.add(path)
        record({ paths: output.paths, bytes: size })
        return { text, isError: false }
      } catch (error) {
        const { code, message } = describeFailure(name, error)
        record({ error: code })
        return { text: message, isError: true }
      }
    },
  }
}

export function inputSchemaOf(schema: z.ZodType): ToolDefinition['inputSchema'] {
  return Object.fromEntries(
    Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== '$schema'),
  )
}

function cutToBytes(text: string, limit: number): string {
  const encoded = Buffer.from(text)
  if (encoded.length <= limit) return text
  const kept = encoded
    .subarray(0, limit)
    .toString('utf8')
    .replace(/\uFFFD+$/, '')
  return `${kept}\n[answer cut at ${limit} of ${encoded.length} bytes: read a smaller range with from and to, or narrow the search]`
}

function describeFailure(name: string, error: unknown): { code: string; message: string } {
  if (error instanceof ToolFailure) return { code: error.code, message: error.message }
  if (error instanceof CheckoutError) return { code: error.reason, message: error.message }
  if (error instanceof InvalidRepoPathError) return { code: 'invalid-path', message: error.message }
  return { code: 'failed', message: `${name} failed` }
}
