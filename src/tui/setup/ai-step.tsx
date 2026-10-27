import { useMessages } from '../app-context.js'
import { ProviderPicker } from '../provider-picker.js'
import type { SetupStepProps } from './setup-steps.js'

export function AiStep({ next }: SetupStepProps) {
  const messages = useMessages()
  return (
    <ProviderPicker intro={messages.setup.ai.intro} onSaved={(plan) => next({ written: plan })} />
  )
}
