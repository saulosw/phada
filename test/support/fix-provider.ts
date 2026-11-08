import type { BlockedCommand, FixRequest, ReviewProvider } from '../../src/providers/types.js'

export type FakeFixAnswer = string | { text: string; blocked?: BlockedCommand[] }

export interface FakeFixProvider extends ReviewProvider {
  requests: FixRequest[]
}

export function fakeFixProvider(
  answer: (request: FixRequest) => FakeFixAnswer | Promise<FakeFixAnswer>,
  id = 'fake-cli',
): FakeFixProvider {
  const requests: FixRequest[] = []
  return {
    id,
    requests,
    review: async () => ({ text: '', durationMs: 1 }),
    fix: async (request) => {
      requests.push(request)
      const answered = await answer(request)
      return typeof answered === 'string'
        ? { text: answered, durationMs: 1, blocked: [] }
        : { blocked: [], ...answered, durationMs: 1 }
    },
  }
}

export function suggestionsOnlyProvider(id = 'fake-ollama'): ReviewProvider {
  return { id, review: async () => ({ text: '', durationMs: 1 }) }
}
