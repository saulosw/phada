import { join } from 'node:path'

export function phadaDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env.PHADA_DATA_HOME?.trim()
  if (explicit) return explicit
  const xdg = env.XDG_DATA_HOME?.trim()
  return xdg ? join(xdg, 'phada') : join(home, '.local', 'share', 'phada')
}

export function dataFiles(env: NodeJS.ProcessEnv, home: string): { history: string; lock: string } {
  const dir = phadaDataDir(env, home)
  return { history: join(dir, 'history.sqlite'), lock: join(dir, 'watch.lock') }
}
