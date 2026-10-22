import { spawn } from 'node:child_process'
import { gitRefusal } from './git-guard.js'

const argv = process.argv.slice(2)
const realGit = process.env.PHADA_REAL_GIT
const refusal = gitRefusal(argv)
if (refusal !== undefined || realGit === undefined || realGit === '') {
  process.stderr.write(`${refusal ?? 'phada: git is only available inside a Phada review.'}\n`)
  process.exitCode = 1
} else {
  const { GIT_EXTERNAL_DIFF: _external, ...env } = process.env
  const child = spawn(realGit, argv, {
    stdio: 'inherit',
    env: { ...env, GIT_PAGER: 'cat', PAGER: 'cat' },
  })
  child.on('error', (error) => {
    process.stderr.write(`phada: ${error.message}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 128)
  })
}
