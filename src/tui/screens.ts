import type { ComponentType } from 'react'
import type { ScreenTitle, UiMessages } from './i18n/messages.js'
import { AutomationScreen } from './screens/automation.js'
import { GraphScreen } from './screens/graph.js'
import { HomeScreen } from './screens/home.js'
import { LearningsScreen } from './screens/learnings.js'
import { ProviderScreen } from './screens/provider.js'
import { QueueScreen } from './screens/queue.js'
import { RepositoriesScreen } from './screens/repositories.js'
import { ReviewsScreen } from './screens/reviews.js'
import { RulesScreen } from './screens/rules.js'

export interface ScreenDefinition {
  id: string
  title(messages: UiMessages): ScreenTitle
  Screen: ComponentType
}

export const SCREENS: readonly ScreenDefinition[] = [
  { id: 'home', title: (messages) => messages.screens.home, Screen: HomeScreen },
  {
    id: 'repositories',
    title: (messages) => messages.screens.repositories,
    Screen: RepositoriesScreen,
  },
  { id: 'rules', title: (messages) => messages.screens.rules, Screen: RulesScreen },
  { id: 'reviews', title: (messages) => messages.screens.reviews, Screen: ReviewsScreen },
  { id: 'queue', title: (messages) => messages.screens.queue, Screen: QueueScreen },
  { id: 'automation', title: (messages) => messages.screens.automation, Screen: AutomationScreen },
  { id: 'provider', title: (messages) => messages.screens.provider, Screen: ProviderScreen },
  { id: 'graph', title: (messages) => messages.screens.graph, Screen: GraphScreen },
  { id: 'learnings', title: (messages) => messages.screens.learnings, Screen: LearningsScreen },
]
