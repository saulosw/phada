import { parseDocument } from 'yaml'
import type { Document } from 'yaml'
import { parseConfigText } from './parse-config.js'
import type { ConfigFile } from './schema.js'

export type SettingKey = 'provider' | 'model' | 'language'

export type UserConfigChange =
  { kind: 'set'; key: SettingKey; value: string } | { kind: 'unset'; key: SettingKey }

export type ValueChange = { key: SettingKey; before: string | null; after: string | null }

export interface UserConfigPlan {
  path: string
  exists: boolean
  before: string | null
  text: string
  changes: ValueChange[]
}

export type PlannedUserConfig =
  | { ok: true; plan: UserConfigPlan }
  | { ok: false; reason: 'invalid-config' | 'invalid-result'; message: string }
  | { ok: false; reason: 'ollama-without-model' }

export interface UserConfigEdit {
  path: string
  current: string | null
  template: string
  changes: readonly UserConfigChange[]
}

const SETTING_KEYS: readonly SettingKey[] = ['provider', 'model', 'language']

export function planUserConfigEdit(edit: UserConfigEdit): PlannedUserConfig {
  const { path, current } = edit
  const withTemplate = (text: string) => (current === null ? `${text}\n${edit.template}` : text)
  const parsedBefore = parseConfigText(current ?? '')
  if (!parsedBefore.ok) {
    return { ok: false, reason: 'invalid-config', message: parsedBefore.message }
  }
  const doc = parseDocument(current ?? '')
  for (const change of edit.changes) applyChange(doc, change)
  const rendered = doc.toString({ lineWidth: 0 })
  const parsedAfter = parseConfigText(rendered)
  if (!parsedAfter.ok) {
    return { ok: false, reason: 'invalid-result', message: parsedAfter.message }
  }
  if (ollamaWithoutModel(parsedBefore.config, parsedAfter.config, edit.changes)) {
    return { ok: false, reason: 'ollama-without-model' }
  }
  const changes = valueChanges(parsedBefore.config, parsedAfter.config)
  return {
    ok: true,
    plan: {
      path,
      exists: current !== null,
      before: current,
      text: changes.length === 0 && current !== null ? current : withTemplate(rendered),
      changes,
    },
  }
}

function applyChange(doc: Document, change: UserConfigChange): void {
  if (change.kind === 'set') doc.set(change.key, change.value)
  else doc.delete(change.key)
}

function ollamaWithoutModel(
  before: ConfigFile,
  after: ConfigFile,
  changes: readonly UserConfigChange[],
): boolean {
  if (after.provider !== 'ollama') return false
  if (after.model === undefined) return true
  const switched = before.provider !== 'ollama'
  return switched && !changes.some((change) => change.kind === 'set' && change.key === 'model')
}

function valueChanges(before: ConfigFile, after: ConfigFile): ValueChange[] {
  return SETTING_KEYS.flatMap((key) => {
    const was = before[key] ?? null
    const now = after[key] ?? null
    return was === now ? [] : [{ key, before: was, after: now }]
  })
}
