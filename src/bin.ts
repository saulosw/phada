#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fetchPullRequest } from './github/pull-request.js'
import { createProvider, run } from './main.js'

const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8')
const { version } = JSON.parse(packageJson) as { version: string }

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  version,
  stdout: process.stdout,
  stderr: process.stderr,
  fetchPullRequest,
  createProvider,
})
