import { readFile, realpath } from 'node:fs/promises'
import { connect } from 'node:net'
import { isAbsolute, relative, resolve } from 'node:path'
import { filesToRead } from './gh-command.js'

const OUTSIDE = 'phada: only files inside the checkout can be read by gh during a review.\n'

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const socketPath = process.env.PHADA_GH_SOCKET
  if (socketPath === undefined || socketPath === '') {
    process.stderr.write('phada: gh is only available inside a Phada review.\n')
    return 1
  }
  const root = await realpath(process.env.PHADA_GH_ROOT || process.cwd())
  const files: Record<string, string> = {}
  for (const path of filesToRead(argv)) {
    const real = await realpath(resolve(process.cwd(), path)).catch(() => undefined)
    const inside =
      real !== undefined &&
      !relative(root, real).startsWith('..') &&
      !isAbsolute(relative(root, real))
    if (real === undefined || !inside) {
      process.stderr.write(real === undefined ? `phada: ${path} was not found.\n` : OUTSIDE)
      return 1
    }
    files[path] = await readFile(real, 'utf8')
  }
  const needsStdin =
    argv.includes('-') || argv.includes('--input=-') || argv.some((arg) => arg.endsWith('=@-'))
  const stdin = needsStdin ? await readStdin() : undefined
  const answer = await ask(socketPath, { argv, files, ...(stdin === undefined ? {} : { stdin }) })
  process.stdout.write(answer.stdout)
  process.stderr.write(answer.stderr)
  return answer.exitCode
}

function readStdin(): Promise<string> {
  return new Promise((done) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => (text += chunk))
    process.stdin.on('end', () => done(text))
    process.stdin.on('error', () => done(text))
  })
}

function ask(
  socketPath: string,
  request: unknown,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((done) => {
    const socket = connect(socketPath)
    let reply = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => (reply += chunk.toString('utf8')))
    socket.on('error', () =>
      done({ stdout: '', stderr: 'phada: the review ended.\n', exitCode: 1 }),
    )
    socket.on('close', () => {
      try {
        done(JSON.parse(reply) as { stdout: string; stderr: string; exitCode: number })
      } catch {
        done({ stdout: '', stderr: 'phada: unreadable gh answer.\n', exitCode: 1 })
      }
    })
  })
}

process.exitCode = await main()
