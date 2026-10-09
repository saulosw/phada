import { parse } from 'yaml'
import type { z } from 'zod'
import { ConfigFileSchema } from './schema.js'
import type { ConfigFile } from './schema.js'

export type ParsedConfig = { ok: true; config: ConfigFile } | { ok: false; message: string }

export function parseConfigText(text: string): ParsedConfig {
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    return { ok: false, message: firstLine(error instanceof Error ? error.message : String(error)) }
  }
  if (data === null || data === undefined) return { ok: true, config: {} }
  const parsed = ConfigFileSchema.safeParse(data)
  if (parsed.success) return { ok: true, config: parsed.data }
  return { ok: false, message: issueText(parsed.error.issues[0]) }
}

function issueText(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return 'invalid config'
  const path = issue.code === 'unrecognized_keys' ? [...issue.path, ...issue.keys] : [...issue.path]
  const key = path.map(String).join('.')
  const message = firstLine(issue.message)
  return key === '' ? message : `${key}: ${message}`
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]?.trim() ?? text
}
