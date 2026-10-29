import { useState } from 'react'
import type { PullRequestTarget, ReviewMode } from '../../app/requested-review.js'
import { ConfirmStep } from './confirm-step.js'
import { EnqueueStep } from './enqueue-step.js'
import { ModeStep } from './mode-step.js'
import { PickStep } from './pick-step.js'
import { PullsStep } from './pulls-step.js'
import { RunStep } from './run-step.js'

type FlowStep =
  | { kind: 'pick'; typing: boolean }
  | { kind: 'pulls'; repo: string }
  | { kind: 'mode'; target: PullRequestTarget; title: string | null; chosen?: ReviewMode }
  | { kind: 'confirm'; target: PullRequestTarget; title: string | null; watch?: number }
  | { kind: 'run'; target: PullRequestTarget; title: string | null; mode: ReviewMode }
  | { kind: 'enqueue'; target: PullRequestTarget; title: string | null }

export function ReviewFlow({
  repo,
  onClose,
  onQueue,
}: {
  repo?: string
  onClose(): void
  onQueue(): void
}) {
  const [stack, setStack] = useState<FlowStep[]>(() => [
    repo === undefined ? { kind: 'pick', typing: true } : { kind: 'pulls', repo },
  ])
  const step: FlowStep = stack.at(-1) ?? { kind: 'pick', typing: true }
  const go = (next: FlowStep, left: FlowStep = step) =>
    setStack((current) => [...current.slice(0, -1), left, next])
  const back = () => (stack.length <= 1 ? onClose() : setStack((current) => current.slice(0, -1)))
  const key = String(stack.length)
  switch (step.kind) {
    case 'pick':
      return (
        <PickStep
          key={key}
          typing={step.typing}
          back={back}
          onTarget={(target) =>
            go({ kind: 'mode', target, title: null }, { kind: 'pick', typing: true })
          }
          onRepo={(name) => go({ kind: 'pulls', repo: name }, { kind: 'pick', typing: false })}
        />
      )
    case 'pulls':
      return (
        <PullsStep
          key={key}
          repo={step.repo}
          back={back}
          onPick={(target, title) => go({ kind: 'mode', target, title })}
        />
      )
    case 'mode':
      return (
        <ModeStep
          key={key}
          target={step.target}
          title={step.title}
          back={back}
          chosen={step.chosen}
          onMode={(mode, watch) =>
            go(
              mode === 'publish'
                ? {
                    kind: 'confirm',
                    target: step.target,
                    title: step.title,
                    ...(watch === undefined ? {} : { watch }),
                  }
                : { kind: 'run', target: step.target, title: step.title, mode },
              { ...step, chosen: mode },
            )
          }
        />
      )
    case 'confirm':
      return (
        <ConfirmStep
          key={key}
          target={step.target}
          title={step.title}
          watch={step.watch}
          back={back}
          onConfirm={() =>
            go(
              step.watch === undefined
                ? { kind: 'run', target: step.target, title: step.title, mode: 'publish' }
                : { kind: 'enqueue', target: step.target, title: step.title },
            )
          }
        />
      )
    case 'run':
      return (
        <RunStep
          key={key}
          target={step.target}
          title={step.title}
          mode={step.mode}
          onClose={onClose}
          onWatchRunning={(watch) =>
            setStack((current) => [
              ...current.slice(0, -2),
              { kind: 'confirm', target: step.target, title: step.title, watch },
            ])
          }
        />
      )
    case 'enqueue':
      return (
        <EnqueueStep
          key={key}
          target={step.target}
          title={step.title}
          onClose={onClose}
          onQueue={onQueue}
        />
      )
  }
}
