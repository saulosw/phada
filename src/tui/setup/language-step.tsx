import { LanguagePicker } from '../language-picker.js'
import type { SetupStepProps } from './setup-steps.js'

export function LanguageStep({ next }: SetupStepProps) {
  return <LanguagePicker onDone={(plan) => next(plan === undefined ? {} : { written: plan })} />
}
