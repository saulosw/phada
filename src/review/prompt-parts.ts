import type { PullRequest } from '../github/pull-request.js'

export const CONFIDENCE_SCALE = `Rate each candidate problem from 0 to 100 for how confident you are that it
is real and will happen in practice: 0 does not survive light scrutiny;
25 might be real but is unverified; 50 is real but minor or rare; 75 is very
likely real and important; 100 is certain from the diff alone.`

export const SEVERITY = `Give each finding a severity:
- P0, must fix before merging: security holes (injection, running code that comes
  from user input, broken authentication or authorization, leaked secrets), data
  loss or corruption, crashes, wrong money or balance handling.
- P1, should fix: bugs, incorrect behavior, unhandled edge cases, race conditions,
  resource leaks.
- P2, worth considering: maintainability or design risks with a concrete consequence.
Severity is how much the problem matters; confidence is how sure you are that it
is real. Rate them independently.`

export const DIFF_ONLY = `You see only the diff, not the rest of the repository. If a problem depends
on code you cannot see, report it only if the diff alone makes it evident.`

export const DIFF_LINE_NUMBERS = `Each added or context line of the diff starts with its line number in the new
version of the file. Those numbers come from the review tool, not from the author.`

export function pullRequestDetails(pr: PullRequest): string {
  const { changedFiles, additions, deletions, commits } = pr.stats
  return [
    `Repository: ${pr.repo}`,
    `Pull request: #${pr.number} (${pr.state}${pr.draft ? ', draft' : ''})`,
    `Title: ${pr.title}`,
    `Author: ${pr.author}`,
    `Branch: ${pr.headRef} → ${pr.baseRef}`,
    `Changes: ${countOf(changedFiles, 'file')}, +${additions} −${deletions}, ${countOf(commits, 'commit')}`,
    '',
    'Description:',
    pr.description.trim() === '' ? '(none)' : pr.description,
  ].join('\n')
}

export function block(name: string, nonce: string, content: string): string {
  return `<<<${name}_${nonce}\n${content}\n${name}_${nonce}>>>`
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
