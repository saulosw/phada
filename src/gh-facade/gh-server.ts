import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapturedWrite } from '../review/types.js'
import { answerGh } from './gh-answer.js'
import { parseGhCommand } from './gh-command.js'
import { GhFacadeError } from './types.js'
import type { GhAnswer, GhPullData, ReadGitHub } from './types.js'

export const GH_READS_PER_PASS = 60
export const GH_SOCKET_VARIABLE = 'PHADA_GH_SOCKET'

const LIMIT_MESSAGE = 'phada: the GitHub read limit of this review was reached.'
const MAX_REQUEST_BYTES = 8_000_000

export interface GhFacade {
  binDir: string
  env: Record<string, string>
  captured(): CapturedWrite[]
  close(): Promise<void>
}

export interface GhBridgeRequest {
  argv: string[]
  stdin?: string
  files: Record<string, string>
}

export async function serveGhFacade(input: {
  data: GhPullData
  readGitHub: ReadGitHub
  maxReads?: number
  execPath?: string
  execArgv?: readonly string[]
  tempRoot?: string
  path?: string
}): Promise<GhFacade> {
  const dir = await mkdtemp(join(input.tempRoot ?? tmpdir(), 'phada-gh-'))
  const binDir = join(dir, 'bin')
  const configDir = join(dir, 'config')
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\phada-gh-${randomBytes(8).toString('hex')}`
      : join(dir, 's')
  await mkdir(binDir)
  await mkdir(configDir)
  const captured: CapturedWrite[] = []
  let reads = 0
  const maxReads = input.maxReads ?? GH_READS_PER_PASS
  const limited: ReadGitHub = (path, query) => {
    reads += 1
    if (reads > maxReads) return Promise.reject(new GhFacadeError(LIMIT_MESSAGE))
    return input.readGitHub(path, query)
  }
  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('close', () => connections.delete(socket))
    socket.on('error', () => socket.destroy())
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy()
        return
      }
      const end = buffer.indexOf('\n')
      if (end === -1) return
      const line = buffer.slice(0, end)
      buffer = ''
      void respond(line).then((answer) => socket.end(`${JSON.stringify(answer)}\n`))
    })
  })
  const respond = async (line: string): Promise<GhAnswer> => {
    const request = parseRequest(line)
    if (request === undefined)
      return { stdout: '', stderr: 'phada: unreadable gh request.\n', exitCode: 1 }
    const command = parseGhCommand(request.argv, {
      files: request.files,
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
    })
    const result = await answerGh(command, input.data, limited)
    if (result.captured !== undefined) captured.push(result.captured)
    return result.answer
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const node = [input.execPath ?? process.execPath, ...(input.execArgv ?? process.execArgv)]
  await writeLauncher(join(binDir, 'gh'), [
    ...node,
    fileURLToPath(new URL('./gh-bridge.js', import.meta.url)),
  ])
  await writeLauncher(join(binDir, 'git'), [
    ...node,
    fileURLToPath(new URL('./git-bridge.js', import.meta.url)),
  ])
  const realGit = await findExecutable('git', input.path ?? process.env.PATH ?? '', binDir)
  return {
    binDir,
    env: {
      [GH_SOCKET_VARIABLE]: socketPath,
      GH_CONFIG_DIR: configDir,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      ...(realGit === undefined ? {} : { PHADA_REAL_GIT: realGit }),
    },
    captured: () => [...captured],
    close: async () => {
      for (const socket of connections) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function parseRequest(line: string): GhBridgeRequest | undefined {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return undefined
    const { argv, stdin, files } = value as Record<string, unknown>
    if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string')) return undefined
    const fileMap =
      typeof files === 'object' && files !== null
        ? Object.fromEntries(
            Object.entries(files).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {}
    return { argv, files: fileMap, ...(typeof stdin === 'string' ? { stdin } : {}) }
  } catch {
    return undefined
  }
}

async function writeLauncher(path: string, command: readonly string[]): Promise<void> {
  await writeFile(path, `#!/bin/sh\nexec ${command.map(shellQuote).join(' ')} "$@"\n`)
  await chmod(path, 0o755)
}

async function findExecutable(
  name: string,
  path: string,
  skip: string,
): Promise<string | undefined> {
  for (const dir of path.split(delimiter)) {
    if (dir === '' || dir === skip) continue
    const candidate = join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
