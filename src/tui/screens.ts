import type { ComponentType } from 'react'
import type { ScreenTitle, UiMessages } from './i18n/messages.js'
import { HomeScreen } from './screens/home.js'
import { PlaceholderScreen } from './screens/placeholder.js'
import { QueueScreen } from './screens/queue.js'
import { ReviewsScreen } from './screens/reviews.js'

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
    Screen: PlaceholderScreen,
  },
  { id: 'rules', title: (messages) => messages.screens.rules, Screen: PlaceholderScreen },
  { id: 'reviews', title: (messages) => messages.screens.reviews, Screen: ReviewsScreen },
  { id: 'queue', title: (messages) => messages.screens.queue, Screen: QueueScreen },
  { id: 'automation', title: (messages) => messages.screens.automation, Screen: PlaceholderScreen },
  { id: 'provider', title: (messages) => messages.screens.provider, Screen: PlaceholderScreen },
  { id: 'learnings', title: (messages) => messages.screens.learnings, Screen: PlaceholderScreen },
]
