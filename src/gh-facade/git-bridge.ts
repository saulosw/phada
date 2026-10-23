import { spawn } from 'node:child_process'
import { gitRefusal } from './git-guard.js'

const argv = process.argv.slice(2)
const realGit = process.env.PHADA_REAL_GIT
const refusal = gitRefusal(argv)
if (refusal !== undefined || realGit === undefined || realGit === '') {
  process.stderr.write(`${refusal ?? 'phada: git is only available inside a Phada review.'}\n`)
  process.exitCode = 1
} else {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  const child = spawn(realGit, ['-c', 'credential.helper=', ...argv], {
    stdio: 'inherit',
    env: { ...env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  })
  child.on('error', (error) => {
    process.stderr.write(`phada: ${error.message}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128)
  })
}
