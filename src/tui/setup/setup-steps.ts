import type { ComponentType } from 'react'
import type { UserConfigPlan } from '../../config/user-config-edit.js'
import type { SetupStepId } from '../i18n/messages.js'
import { AiStep } from './ai-step.js'
import { GitHubStep } from './github-step.js'
import { LanguageStep } from './language-step.js'
import { PendingStep } from './pending-step.js'
import { RepositoriesStep } from './repositories-step.js'
import { SummaryStep } from './summary-step.js'

export interface SetupProgress {
  written: readonly UserConfigPlan[]
  skipped: readonly SetupStepId[]
}

export interface StepResult {
  written?: UserConfigPlan
}

export interface SetupStepProps {
  progress: SetupProgress
  next(result?: StepResult): void
}

export interface SetupStep {
  id: SetupStepId
  skippable: boolean
  Step: ComponentType<SetupStepProps>
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { id: 'github', skippable: true, Step: GitHubStep },
  { id: 'ai', skippable: true, Step: AiStep },
  { id: 'language', skippable: true, Step: LanguageStep },
  { id: 'repositories', skippable: true, Step: RepositoriesStep },
  { id: 'graph', skippable: true, Step: PendingStep },
  { id: 'repository', skippable: true, Step: PendingStep },
  { id: 'summary', skippable: false, Step: SummaryStep },
]
