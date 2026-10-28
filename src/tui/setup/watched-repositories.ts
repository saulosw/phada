import { useEffect, useState } from 'react'
import { useAppDeps } from '../app-context.js'
import type { DataState } from '../data-hooks.js'
import { settle } from '../load-cache.js'

export function useWatchedRepositories(): DataState<string[]> {
  const { readRepositories } = useAppDeps()
  const [watched, setWatched] = useState<DataState<string[]>>({ status: 'loading' })
  useEffect(() => {
    let mounted = true
    void settle(async () => {
      const list = await readRepositories()
      if (list.configError !== null) throw new Error(list.configError)
      return list.repositories
        .filter(({ origins }) => origins.includes('watched'))
        .map(({ repo }) => repo)
    }).then((state) => {
      if (mounted) setWatched(state)
    })
    return () => {
      mounted = false
    }
  }, [readRepositories])
  return watched
}
