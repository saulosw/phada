import type {
  CallerList,
  DefinitionList,
  DependencyList,
  Explored,
  ExploredSymbol,
  GraphExplorer,
  GraphOpening,
} from '../app/explore-graph.js'

export interface AppGraphDeps {
  open(repo: string): Promise<GraphOpening>
  commitOf(repo: string): Promise<string | undefined>
}

export interface AppGraph {
  searchSymbol(repo: string, name: string): Promise<Explored<DefinitionList>>
  symbolCallers(repo: string, symbol: ExploredSymbol): Promise<Explored<CallerList>>
  symbolDependencies(repo: string, symbol: ExploredSymbol): Promise<Explored<DependencyList>>
  close(): void
}

const CLOSED = 'The graph of the app was closed'

interface Held {
  explorer?: GraphExplorer
  dropped: boolean
}

interface Entry {
  repo: string
  opening: Promise<GraphOpening>
  held: Held
}

export function appGraph(deps: AppGraphDeps): AppGraph {
  let current: Entry | undefined
  let closed = false

  const drop = (entry: Entry | undefined) => {
    if (entry === undefined) return
    entry.held.dropped = true
    entry.held.explorer?.close()
  }

  const replace = (repo: string): Promise<GraphOpening> => {
    drop(current)
    const held: Held = { dropped: false }
    const opening = deps.open(repo).then((opened) => {
      if (opened.state !== 'open') return opened
      if (held.dropped) {
        opened.explorer.close()
        throw new Error(CLOSED)
      }
      held.explorer = opened.explorer
      return opened
    })
    current = { repo, opening, held }
    return opening
  }

  const openFor = async (repo: string, commit?: () => Promise<string | undefined>) => {
    if (closed) throw new Error(CLOSED)
    const entry = current
    if (entry?.repo === repo) {
      const opened = await entry.opening.catch(() => undefined)
      if (opened?.state === 'open' && !entry.held.dropped) {
        if (commit === undefined || opened.explorer.commit === (await commit())) return opened
      }
    }
    if (closed) throw new Error(CLOSED)
    return replace(repo)
  }

  const explore = async <T>(
    repo: string,
    query: (explorer: GraphExplorer) => T,
    commit?: () => Promise<string | undefined>,
  ): Promise<Explored<T>> => {
    const opened = await openFor(repo, commit)
    if (opened.state === 'not-indexed') return opened
    const { explorer } = opened
    return {
      state: 'read',
      repo: explorer.repo,
      commit: explorer.commit,
      linked: explorer.linked,
      result: query(explorer),
    }
  }

  return {
    searchSymbol: (repo, name) =>
      explore(
        repo,
        (explorer) => explorer.search(name),
        () => deps.commitOf(repo),
      ),
    symbolCallers: (repo, symbol) => explore(repo, (explorer) => explorer.callers(symbol)),
    symbolDependencies: (repo, symbol) =>
      explore(repo, (explorer) => explorer.dependencies(symbol)),
    close: () => {
      closed = true
      drop(current)
      current = undefined
    },
  }
}
