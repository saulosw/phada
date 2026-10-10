#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { nodeFileSystem } from './config/local-files.js'
import { createReview } from './github/create-review.js'
import { fetchReviewState } from './github/pull-request-reviews.js'
import { fetchPullRequest } from './github/pull-request.js'
import { fetchRepositoryFile, fetchRepositoryTree } from './github/repository-files.js'
import { openGitCheckout } from './investigation/checkout/git-checkout.js'
import { createProvider, run } from './main.js'

const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8')
const { version } = JSON.parse(packageJson) as { version: string }

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  version,
  cwd: process.cwd(),
  home: homedir(),
  files: nodeFileSystem,
  stdout: process.stdout,
  stderr: process.stderr,
  fetchPullRequest,
  fetchReviewState,
  createReview,
  fetchRepositoryTree,
  fetchRepositoryFile,
  openCheckout: openGitCheckout,
  createProvider,
})
