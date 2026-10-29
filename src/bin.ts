#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { nodeFileSystem } from './config/local-files.js'
import { fetchCheckAnnotations, fetchCheckRuns } from './github/check-runs.js'
import { fetchCommitStatuses } from './github/commit-statuses.js'
import { fetchComparison } from './github/compare-commits.js'
import { fetchJobLog } from './github/job-log.js'
import { createReview } from './github/create-review.js'
import { replyAndResolve } from './github/resolve-thread.js'
import { fetchPullComments, fetchReviewState } from './github/pull-request-reviews.js'
import { fetchRepositoryFile, fetchRepositoryTree } from './github/repository-files.js'
import { suppressSqliteWarning } from './cli/suppress-sqlite-warning.js'
import { pathSize } from './config/cache-paths.js'
import { createExtractor } from './repo-map/extract.js'
import { openGitMirror } from './repository/git-mirror.js'
import { openIndexStore } from './store/index-store.js'
import { openObservedStore } from './store/observed-store.js'
import { openHistoryStore } from './store/history-store.js'
import { setTimeout as wait } from 'node:timers/promises'
import { addCommentReaction, listIssueComments } from './github/issue-comments.js'
import { listOpenPullRequests } from './github/list-pull-requests.js'
import {
  fetchPullRequest,
  fetchPullRequestHead,
  fetchPullRequestMetadata,
} from './github/pull-request.js'
import { fetchBranchHead, fetchRepository } from './github/repository.js'
import { ghTokenReader } from './cli/github-token.js'
import { killDetachedChildren } from './process/run-command.js'
import { removeOpenWorkDirs } from './process/work-dirs.js'
import { lockHolder, withMirrorLock } from './repository/mirror-lock.js'
import { createProvider, run } from './main.js'

const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8')
const { version } = JSON.parse(packageJson) as { version: string }

suppressSqliteWarning(process)

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  ghToken: ghTokenReader(process.env),
  version,
  pid: process.pid,
  cwd: process.cwd(),
  home: homedir(),
  files: nodeFileSystem,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  fetchPullRequest,
  fetchReviewState,
  fetchPullComments,
  fetchCheckRuns,
  fetchCommitStatuses,
  fetchCheckAnnotations,
  fetchJobLog,
  createReview,
  fetchComparison,
  replyAndResolve,
  fetchRepositoryTree,
  fetchRepositoryFile,
  fetchRepository,
  openMirror: openGitMirror,
  openIndexStore: (path, version) => openIndexStore(path, { version }),
  openObservedStore: (path) => openObservedStore(path),
  createExtractor: () => createExtractor(),
  pathSize,
  createProvider,
  openHistoryStore: (path) => openHistoryStore(path),
  listOpenPullRequests,
  listIssueComments,
  addCommentReaction,
  fetchPullRequestHead,
  fetchPullRequestMetadata,
  fetchBranchHead,
  withLock: (path, work) =>
    withMirrorLock(path, { timeoutMs: 0, staleMs: Number.POSITIVE_INFINITY }, work),
  lockHolder,
  onSignal: (handler) => {
    process.on('SIGINT', () => handler('SIGINT'))
    process.on('SIGTERM', () => handler('SIGTERM'))
  },
  killDetachedChildren,
  abort: (code) => {
    killDetachedChildren()
    removeOpenWorkDirs()
    process.exit(code)
  },
  sleep: (ms, signal) => wait(ms, undefined, { signal }).catch(() => undefined),
  clock: () => new Date(),
})
