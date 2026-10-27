import type { ComponentType } from 'react'
import type { UserConfigPlan } from '../../config/user-config-edit.js'
import type { SetupStepId } from '../i18n/messages.js'
import { PendingStep } from './pending-step.js'

export interface SetupProgress {
  written: readonly UserConfigPlan[]
  skipped: readonly SetupStepId[]
}

export interface SetupStepProps {
  progress: SetupProgress
  next(written?: UserConfigPlan): void
}

export interface SetupStep {
  id: SetupStepId
  skippable: boolean
  Step: ComponentType<SetupStepProps>
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { id: 'github', skippable: true, Step: PendingStep },
  { id: 'ai', skippable: true, Step: PendingStep },
  { id: 'language', skippable: true, Step: PendingStep },
  { id: 'repositories', skippable: true, Step: PendingStep },
  { id: 'graph', skippable: true, Step: PendingStep },
  { id: 'repository', skippable: true, Step: PendingStep },
  { id: 'summary', skippable: true, Step: PendingStep },
]
