import { useMessages } from '../app-context.js'
import { RepositoryPicker } from '../repository-picker.js'
import type { SetupStepProps } from './setup-steps.js'

export function RepositoriesStep({ next }: SetupStepProps) {
  const messages = useMessages()
  const m = messages.setup.repositories
  return (
    <RepositoryPicker
      intro={m.intro}
      noToken={m.noToken}
      onSaved={(plan) => next({ written: plan })}
      onContinue={{ label: messages.setup.continue, run: () => next() }}
    />
  )
}
