import { describe, expect, it } from 'vitest'
import { gitRefusal } from './git-guard.js'

const refusal = (line: string) => gitRefusal(line.split(' '))

describe('gitRefusal', () => {
  it.each([
    'diff origin/main...HEAD',
    'log --oneline origin/main..HEAD',
    'show HEAD:src/a.ts',
    'blame -L 1,5 src/a.ts',
    'grep -n spend',
    'status --porcelain',
    'rev-parse HEAD',
    'merge-base origin/main HEAD',
    'ls-files',
    'log -- --output',
  ])('lets %s through', (line) => {
    expect(refusal(line)).toBeUndefined()
  })

  it.each([
    ['grep -Oecho spend', '-O'],
    ['grep --open-files-in-pager=sh spend', '--open-files-in-pager'],
    ['diff --output=/tmp/x', '--output'],
    ['log -p --output /tmp/x', '--output'],
    ['diff --no-index /dev/null /home/u/.npmrc', '--no-index'],
    ['blame --contents /home/u/.aws/credentials -- a.ts', '--contents'],
    ['diff --ext-diff', '--ext-diff'],
    ['log -p --textconv', '--textconv'],
    ['-c core.pager=sh log', '-c'],
    ['-C /home/u/other log', '-C'],
    ['--git-dir=/home/u/other/.git log', '--git-dir'],
    ['--work-tree /home/u log', '--work-tree'],
    ['--exec-path=/tmp log', '--exec-path'],
    ['ls-files --exclude-from=/home/u/.ssh/id_rsa', '--exclude-from'],
    ['grep -f /home/u/.ssh/id_rsa', '-f'],
  ])('refuses %s', (line, option) => {
    expect(refusal(line)).toBe(
      `phada: git ${option} is not available during a Phada review: it could run a program, write a file or read outside the checkout.`,
    )
  })
})
