import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [envFile, command, ...args] = process.argv.slice(2)

let env: Record<string, string>
try {
  const parsed = JSON.parse(readFileSync(envFile ?? '', 'utf8')) as { env?: Record<string, string> }
  env = parsed.env ?? {}
} catch {
  process.stderr.write('phada: the MCP server environment could not be read.\n')
  process.exit(2)
}

if (command === undefined) process.exit(2)

const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    `phada: ${error.code === 'ENOENT' ? `${command} was not found` : error.message}\n`,
  )
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
