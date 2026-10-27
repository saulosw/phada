import type { ComponentType } from 'react'
import type { IndexingResult } from '../../app/index-repository.js'
import type { RepositoryInit } from '../../app/repository-folder.js'
import type { UserConfigPlan } from '../../config/user-config-edit.js'
import type { SetupStepId } from '../i18n/messages.js'
import { AiStep } from './ai-step.js'
import { GitHubStep } from './github-step.js'
import { GraphStep } from './graph-step.js'
import { LanguageStep } from './language-step.js'
import { RepositoriesStep } from './repositories-step.js'
import { RepositoryStep } from './repository-step.js'
import { SummaryStep } from './summary-step.js'

export type IndexOutcome = IndexingResult | { kind: 'not-started' }

export interface RepositoryIndexOutcome {
  repo: string
  outcome: IndexOutcome
}

export interface SetupProgress {
  written: readonly UserConfigPlan[]
  skipped: readonly SetupStepId[]
  indexing?: readonly RepositoryIndexOutcome[]
  init?: RepositoryInit
}

export interface StepResult {
  written?: UserConfigPlan
  indexing?: readonly RepositoryIndexOutcome[]
  init?: RepositoryInit
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
  { id: 'graph', skippable: true, Step: GraphStep },
  { id: 'repository', skippable: true, Step: RepositoryStep },
  { id: 'summary', skippable: false, Step: SummaryStep },
]
