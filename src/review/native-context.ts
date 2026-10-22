import type { PullRequest } from '../github/pull-request.js'

export interface NativeContextInput {
  pullRequest: PullRequest
  baseRef: string
  mergeBase: string
  diffFile: string
  language?: string
}

export function nativeSkillContext({
  pullRequest,
  baseRef,
  mergeBase,
  diffFile,
  language,
}: NativeContextInput): string {
  const lines = [
    `You are running inside Phada, which reviews pull request ${pullRequest.repo}#${pullRequest.number} (${pullRequest.url}).`,
    `The working directory is a checkout of the pull request head ${pullRequest.headSha} on branch ${pullRequest.headRef}. The base branch ${baseRef} is available as origin/${baseRef} (the merge base, ${mergeBase}), so \`git diff origin/${baseRef}...HEAD\` shows the change. The diff is also in ${diffFile}.`,
    'gh answers questions about this pull request and this repository.',
    'Nobody can answer questions during this run: when the guide asks the user something, decide yourself from the pull request.',
    'Phada already decided that this pull request should be reviewed now.',
    'Do not publish anything yourself: if the guide says to comment on the pull request, run the gh command it asks for and Phada collects what you wrote. Phada publishes the review.',
    'Finish with your review as your final answer.',
    ...(language === undefined ? [] : [`Write the review in ${language}.`]),
  ]
  return lines.join('\n')
}
