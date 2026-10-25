import { describe, expect, it } from 'vitest'
import { answerGh } from './gh-answer.js'
import { parseGhCommand } from './gh-command.js'
import type { GhPullData, ReadGitHub } from './types.js'

const DIFF = [
  'diff --git a/src/shop.ts b/src/shop.ts',
  '--- a/src/shop.ts',
  '+++ b/src/shop.ts',
  '@@ -1,2 +1,3 @@',
  ' a',
  '-b',
  '+c',
  '+d',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n')

const DATA: GhPullData = {
  repo: 'acme/shop',
  number: 12,
  url: 'https://github.com/acme/shop/pull/12',
  title: 'Spend crystals',
  body: 'Lets users spend.',
  author: 'dev',
  baseRef: 'main',
  headRef: 'feat/spend',
  mergeBase: 'b'.repeat(40),
  headSha: 'h'.repeat(40),
  diff: DIFF,
  viewer: 'phada-user',
}

function github(answers: Record<string, unknown> = {}) {
  const calls: { path: string; query?: Readonly<Record<string, string>> }[] = []
  const read: ReadGitHub = async (path, query) => {
    calls.push({ path, ...(query === undefined ? {} : { query }) })
    if (path in answers) return answers[path]
    throw new Error(`HTTP 404 for ${path}`)
  }
  return { read, calls }
}

async function gh(line: string, read: ReadGitHub = github().read, stdin?: string) {
  const command = parseGhCommand(line.split(' '), {
    files: {},
    ...(stdin === undefined ? {} : { stdin }),
  })
  return answerGh(command, DATA, read)
}

const COMMENTS = [
  { user: { login: 'phada-user' }, body: 'Earlier Phada review', created_at: 't', html_url: 'u1' },
  { user: { login: 'teammate' }, body: 'Looks fine', created_at: 't', html_url: 'u2' },
]

describe('answerGh', () => {
  it('shows the pull request as open and not a draft', async () => {
    const { answer } = await gh('pr view --json state,isDraft,title,files')

    expect(answer.exitCode).toBe(0)
    expect(JSON.parse(answer.stdout)).toEqual({
      state: 'OPEN',
      isDraft: false,
      title: 'Spend crystals',
      files: [
        { path: 'src/shop.ts', additions: 2, deletions: 1 },
        { path: 'README.md', additions: 1, deletions: 1 },
      ],
    })
  })

  it('leaves out the comments and reviews of the token owner', async () => {
    const { read, calls } = github({
      'repos/acme/shop/issues/12/comments': COMMENTS,
      'repos/acme/shop/pulls/12/reviews': [
        { user: { login: 'phada-user' }, body: 'old', state: 'COMMENTED', submitted_at: 't' },
      ],
    })

    const { answer } = await gh('pr view 12 --json comments,reviews', read)

    expect(JSON.parse(answer.stdout)).toEqual({
      comments: [{ author: { login: 'teammate' }, body: 'Looks fine', createdAt: 't', url: 'u2' }],
      reviews: [],
    })
    expect(calls.map(({ path }) => path)).toEqual([
      'repos/acme/shop/issues/12/comments',
      'repos/acme/shop/pulls/12/reviews',
    ])
  })

  it('applies --jq', async () => {
    expect((await gh('pr view --json files --jq .files[].path')).answer.stdout).toBe(
      'src/shop.ts\nREADME.md\n',
    )
  })

  it('prints the pull request as text without --json', async () => {
    const { answer } = await gh('pr view')

    expect(answer.stdout).toContain('Spend crystals #12')
    expect(answer.stdout).toContain('dev wants to merge into main from feat/spend')
    expect(answer.stdout).toContain('Lets users spend.')
  })

  it('names the supported fields for an unknown one', async () => {
    const { answer } = await gh('pr view --json commits')

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toContain('Unknown JSON field: "commits"')
    expect(answer.stderr).toContain('headRefOid')
  })

  it('answers pr diff with the diff Phada reviews', async () => {
    expect((await gh('pr diff')).answer.stdout).toBe(DIFF)
    expect((await gh('pr diff --name-only')).answer.stdout).toBe('src/shop.ts\nREADME.md\n')
  })

  it.each(['pr view 13', 'pr view https://github.com/other/repo/pull/12', 'pr diff 99'])(
    'refuses another pull request: %s',
    async (line) => {
      const { answer } = await gh(line)

      expect(answer.exitCode).toBe(1)
      expect(answer.stderr).toBe(
        'phada: only pull request acme/shop#12 can be read during this review.\n',
      )
    },
  )

  it('refuses another repository without asking GitHub', async () => {
    const { read, calls } = github()

    const { answer } = await gh('issue view 3 --repo other/repo', read)

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toBe('phada: only acme/shop can be read during this review.\n')
    expect(calls).toEqual([])
  })

  it('reads the pull request through the api as open and not a draft', async () => {
    const { read } = github({
      'repos/acme/shop/pulls/12': { number: 12, state: 'closed', draft: true },
    })

    const { answer } = await gh('api repos/{owner}/{repo}/pulls/12', read)

    expect(JSON.parse(answer.stdout)).toEqual({ number: 12, state: 'open', draft: false })
  })

  it('leaves the token owner out of api comment lists', async () => {
    const { read } = github({ 'repos/acme/shop/issues/12/comments': COMMENTS })

    const { answer } = await gh('api /repos/acme/shop/issues/12/comments', read)

    expect(JSON.parse(answer.stdout)).toEqual([COMMENTS[1]])
  })

  it('refuses an admin endpoint of the repository', async () => {
    const { read, calls } = github()

    const { answer } = await gh('api repos/acme/shop/actions/variables', read)

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toContain(
      'phada: gh api repos/acme/shop/actions/variables is not available during a Phada review.',
    )
    expect(calls).toEqual([])
  })

  it('refuses an api path of another repository', async () => {
    const { answer } = await gh('api repos/x/y/pulls/1')

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toBe('phada: only acme/shop can be read during this review.\n')
  })

  it('searches within the repository of the pull request', async () => {
    const { read, calls } = github({
      'search/issues': {
        items: [
          {
            number: 3,
            title: 'Old cart fix',
            html_url: 'u',
            state: 'closed',
            user: { login: 'x' },
          },
        ],
      },
    })

    const { answer } = await gh('search prs cart --json number,title', read)

    expect(calls).toEqual([
      { path: 'search/issues', query: { q: 'cart repo:acme/shop is:pr', per_page: '30' } },
    ])
    expect(JSON.parse(answer.stdout)).toEqual([{ number: 3, title: 'Old cart fix' }])
  })

  it.each([
    ['search issues x repo:victim/private', 'x repo:acme/shop is:issue'],
    ['search prs x org:victim user:someone', 'x repo:acme/shop is:pr'],
  ])('keeps a search inside the repository: %s', async (line, q) => {
    const { read, calls } = github({ 'search/issues': { items: [] } })

    await gh(line, read)

    expect(calls[0]?.query?.q).toBe(q)
  })

  it('drops other scopes from an api search', async () => {
    const { read, calls } = github({ 'search/issues': { items: [] } })

    await gh('api search/issues?q=x+repo:victim/private+repo:acme/shop', read)

    expect(calls[0]?.query?.q).toBe('x repo:acme/shop')
  })

  it('drops other scopes from pr list --search', async () => {
    const { read, calls } = github({ 'search/issues': { items: [] } })

    await gh('pr list --search repo:victim/private', read)

    expect(calls[0]?.query?.q).toBe('repo:acme/shop is:pr')
  })

  it('turns pr list filters into a search of the repository', async () => {
    const { read, calls } = github({ 'search/issues': { items: [] } })

    await gh('pr list --author dev --label bug --base main --head feat/x --draft', read)

    expect(calls[0]).toEqual({
      path: 'search/issues',
      query: {
        q: 'author:dev label:bug base:main head:feat/x draft:true repo:acme/shop is:pr',
        per_page: '30',
      },
    })
  })

  it('refuses --template', async () => {
    const { answer } = await gh('pr view --json title --template x')

    expect(answer.exitCode).toBe(1)
  })

  it('keeps the event of a captured review', async () => {
    expect((await gh('pr review --approve -b ok')).captured?.command).toBe('gh pr review --approve')
    expect((await gh('pr review --request-changes -b no')).captured?.command).toBe(
      'gh pr review --request-changes',
    )
    expect((await gh('pr review -b hm')).captured?.command).toBe('gh pr review')
  })

  it('captures a comment and never asks GitHub', async () => {
    const { read, calls } = github()

    const result = await gh('pr comment 12 --body Looks-bad', read)

    expect(result.answer).toEqual({
      stdout: 'https://github.com/acme/shop/pull/12#phada-captured\n',
      stderr: '',
      exitCode: 0,
    })
    expect(result.captured).toEqual({ command: 'gh pr comment', body: 'Looks-bad', comments: [] })
    expect(calls).toEqual([])
  })

  it('captures an api review with line comments', async () => {
    const result = await gh(
      'api repos/{owner}/{repo}/pulls/12/reviews --input -',
      github().read,
      JSON.stringify({
        body: 'Two issues',
        event: 'COMMENT',
        comments: [{ path: 'src/shop.ts', line: 3, start_line: 2, body: 'x' }],
      }),
    )

    expect(result.captured).toEqual({
      command: 'gh api',
      body: 'Two issues',
      comments: [{ path: 'src/shop.ts', line: 3, startLine: 2, body: 'x' }],
    })
  })

  it('captures an api line comment', async () => {
    const result = await gh(
      'api repos/acme/shop/pulls/12/comments -f body=Fix -f path=src/shop.ts -F line=3',
    )

    expect(result.captured).toEqual({
      command: 'gh api',
      body: '',
      comments: [{ path: 'src/shop.ts', line: 3, body: 'Fix' }],
    })
  })

  it('refuses other writes', async () => {
    const { answer, captured } = await gh('api repos/acme/shop/labels -X POST -f name=x')

    expect(captured).toBeUndefined()
    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toContain('Phada does not write to GitHub')
  })

  it('says it answers GitHub for auth status', async () => {
    expect((await gh('auth status')).answer).toEqual({
      stdout: 'Phada answers GitHub requests during this review.\n',
      stderr: '',
      exitCode: 0,
    })
  })

  it('lists what is available for an unsupported command', async () => {
    const { answer } = await gh('run list')

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toMatch(
      /^phada: "gh run list" is not available during a Phada review\. Available: /,
    )
  })

  it('reports a GitHub error without failing the run', async () => {
    const { answer } = await gh('issue view 3')

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toBe('phada: GitHub answered: HTTP 404 for repos/acme/shop/issues/3\n')
  })
})

describe('answerGh pr checks', () => {
  const CHECKS: GhPullData['checks'] = [
    {
      name: 'lint',
      state: 'SUCCESS',
      link: 'https://github.com/acme/shop/actions/runs/1/job/2',
      description: 'No problems',
      workflow: '',
      startedAt: '2026-10-20T10:00:00Z',
      completedAt: '2026-10-20T10:01:30Z',
    },
    {
      name: 'test',
      state: 'FAILURE',
      link: 'https://github.com/acme/shop/actions/runs/1/job/3',
      description: 'Tests failed',
      workflow: '',
      startedAt: '2026-10-20T10:00:00Z',
      completedAt: '2026-10-20T11:00:05Z',
    },
    { name: 'ci/deploy', state: 'PENDING', link: '', description: 'Waiting', workflow: '' },
    {
      name: 'e2e',
      state: 'CANCELLED',
      link: 'https://ci.example/e2e',
      description: '',
      workflow: '',
    },
    { name: 'docs', state: 'SKIPPED', link: '', description: '', workflow: '' },
  ]
  const withChecks = (checks: GhPullData['checks']) => (line: string) =>
    answerGh(parseGhCommand(line.split(' '), { files: {} }), { ...DATA, checks }, github().read)

  it('prints the checks tab-separated like gh, failing first, and fails like gh', async () => {
    const { answer } = await withChecks(CHECKS)('pr checks')

    expect(answer.stdout).toBe(
      [
        'test\tfail\t1h0m5s\thttps://github.com/acme/shop/actions/runs/1/job/3\tTests failed',
        'ci/deploy\tpending\t0\t\tWaiting',
        'docs\tskipping\t0\t\t',
        'e2e\tfail\t0\thttps://ci.example/e2e\t',
        'lint\tpass\t1m30s\thttps://github.com/acme/shop/actions/runs/1/job/2\tNo problems',
        '',
      ].join('\n'),
    )
    expect(answer.exitCode).toBe(1)
  })

  it('exits 8 when checks are pending and none fails, and 0 when all pass', async () => {
    const pending = await withChecks(CHECKS.filter(({ state }) => state === 'PENDING'))('pr checks')
    const passing = await withChecks(CHECKS.filter(({ state }) => state === 'SUCCESS'))('pr checks')

    expect(pending.answer.exitCode).toBe(8)
    expect(passing.answer.exitCode).toBe(0)
  })

  it('answers --json with the fields asked and --jq', async () => {
    const { answer } = await withChecks(CHECKS.slice(0, 1))(
      'pr checks --json name,state,bucket,link,description,workflow,startedAt,completedAt',
    )
    const pending = await withChecks(CHECKS.slice(2, 3))(
      'pr checks 12 --json name,bucket,startedAt',
    )
    const names = await withChecks(CHECKS)('pr checks --json name,bucket --jq .[].bucket')

    expect(JSON.parse(answer.stdout)).toEqual([
      {
        name: 'lint',
        state: 'SUCCESS',
        bucket: 'pass',
        link: 'https://github.com/acme/shop/actions/runs/1/job/2',
        description: 'No problems',
        workflow: '',
        startedAt: '2026-10-20T10:00:00Z',
        completedAt: '2026-10-20T10:01:30Z',
      },
    ])
    expect(answer.exitCode).toBe(0)
    expect(JSON.parse(pending.answer.stdout)).toEqual([
      { name: 'ci/deploy', bucket: 'pending', startedAt: '0001-01-01T00:00:00Z' },
    ])
    expect(names.answer.stdout).toBe('pass\nfail\npending\ncancel\nskipping\n')
  })

  it('refuses an unknown JSON field and lists the ones it has', async () => {
    const { answer } = await withChecks(CHECKS)('pr checks --json name,conclusion')

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toContain('Unknown JSON field: "conclusion"')
    expect(answer.stderr).toContain('  bucket')
  })

  it('answers --watch at once and --required with every check', async () => {
    const plain = await withChecks(CHECKS)('pr checks')
    const watch = await withChecks(CHECKS)('pr checks --watch --fail-fast --interval 5')
    const required = await withChecks(CHECKS)('pr checks --required')

    expect(watch.answer).toEqual(plain.answer)
    expect(required.answer).toEqual(plain.answer)
  })

  it('refuses --watch with --json like gh', async () => {
    const { answer } = await withChecks(CHECKS)('pr checks --watch --json name')

    expect(answer).toEqual({
      stdout: '',
      stderr: 'cannot use `--watch` with `--json` flag\n',
      exitCode: 1,
    })
  })

  it('says no checks were reported on the branch like gh, also with --json', async () => {
    const plain = await withChecks([])('pr checks')
    const json = await withChecks([])('pr checks --json name')

    expect(plain.answer).toEqual({
      stdout: '',
      stderr: "no checks reported on the 'feat/spend' branch\n",
      exitCode: 1,
    })
    expect(json.answer).toEqual(plain.answer)
  })

  it('says Phada did not read the checks when the review did not', async () => {
    const { answer } = await withChecks(undefined)('pr checks')

    expect(answer.exitCode).toBe(1)
    expect(answer.stderr).toContain('Phada did not read the checks')
  })

  it('answers only for this pull request and never asks GitHub', async () => {
    const { read, calls } = github()
    const other = await answerGh(
      parseGhCommand(['pr', 'checks', '13'], { files: {} }),
      { ...DATA, checks: CHECKS },
      read,
    )
    await answerGh(
      parseGhCommand(['pr', 'checks'], { files: {} }),
      { ...DATA, checks: CHECKS },
      read,
    )

    expect(other.answer.exitCode).toBe(1)
    expect(other.answer.stderr).toContain('only pull request acme/shop#12')
    expect(calls).toEqual([])
  })
})
