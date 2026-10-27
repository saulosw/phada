import type { LocalFileSystem } from '../config/local-files.js'
import { userConfigFile } from '../config/user-config.js'
import { planUserConfigEdit } from '../config/user-config-edit.js'
import type {
  PlannedUserConfig,
  UserConfigChange,
  UserConfigPlan,
} from '../config/user-config-edit.js'
import { errorMessage } from './error-message.js'

export type UserConfigFiles = Pick<LocalFileSystem, 'readText' | 'writeAtomic'>

export interface UserConfigRequest {
  env: NodeJS.ProcessEnv
  home: string
  template: string
  changes: readonly UserConfigChange[]
}

export type UserConfigPlanResult =
  PlannedUserConfig | { ok: false; reason: 'unreadable'; message: string }

export type AppliedUserConfig =
  | { ok: true; written: boolean }
  | { ok: false; reason: 'changed' }
  | { ok: false; reason: 'failed'; message: string }

export async function planUserConfig(
  request: UserConfigRequest,
  files: UserConfigFiles,
): Promise<UserConfigPlanResult> {
  const path = userConfigFile(request.env, request.home)
  let current: string | null
  try {
    current = await files.readText(path)
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: errorMessage(error) }
  }
  return planUserConfigEdit({
    path,
    current,
    template: request.template,
    changes: request.changes,
  })
}

export async function applyUserConfigPlan(
  plan: UserConfigPlan,
  files: UserConfigFiles,
): Promise<AppliedUserConfig> {
  if (plan.changes.length === 0) return { ok: true, written: false }
  try {
    if ((await files.readText(plan.path)) !== plan.before) return { ok: false, reason: 'changed' }
    await files.writeAtomic(plan.path, plan.text)
  } catch (error) {
    return { ok: false, reason: 'failed', message: errorMessage(error) }
  }
  return { ok: true, written: true }
}
