import { describe, expect, it } from 'vitest'
import { parseConfigText } from './parse-config.js'

describe('parseConfigText', () => {
  it('reads every key', () => {
    const text = [
      'provider: codex',
      'model: gpt-5',
      'language: pt-BR',
      'minConfidence: 70',
      'verify: true',
      'ignore: ["**/*.snap"]',
      'rules:',
      '  - id: orm-only',
      '    rule: Use the ORM.',
      '    scope: ["**/*.py"]',
      '    severity: P1',
      '  - rule: No console.log in request code.',
      'disabledRules: [no-console]',
      'context:',
      '  defaults: false',
      '  files:',
      '    - path: docs/architecture.md',
      '      description: Layers',
      'localFiles: ["~/notes/rules"]',
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        provider: 'codex',
        model: 'gpt-5',
        language: 'pt-BR',
        minConfidence: 70,
        verify: true,
        ignore: ['**/*.snap'],
        rules: [
          { id: 'orm-only', rule: 'Use the ORM.', scope: ['**/*.py'], severity: 'P1' },
          { rule: 'No console.log in request code.' },
        ],
        disabledRules: ['no-console'],
        context: {
          defaults: false,
          files: [{ path: 'docs/architecture.md', description: 'Layers' }],
        },
        localFiles: ['~/notes/rules'],
      },
    })
  })

  it.each([
    ['an empty file', ''],
    ['only comments', '# nothing here\n'],
  ])('treats %s as an empty config', (_case, text) => {
    expect(parseConfigText(text)).toEqual({ ok: true, config: {} })
  })

  it.each([
    ['an unknown key', 'colour: red', 'colour'],
    ['a severity outside P0-P2', 'rules:\n  - rule: x\n    severity: P3', 'rules.0.severity'],
    ['a cut outside 50-100', 'minConfidence: 40', 'minConfidence'],
    ['an invalid language tag', 'language: português', 'language'],
    ['an empty rule', 'rules:\n  - rule: "  "', 'rules.0.rule'],
    ['a rule id with spaces', 'rules:\n  - id: no console\n    rule: x', 'rules.0.id'],
    ['an unknown key inside a rule', 'rules:\n  - rule: x\n    level: high', 'rules.0.level'],
    ['an exception in ignore', 'ignore: ["dist/**", "!dist/keep.js"]', 'ignore.1'],
    [
      'an exception in a rule scope',
      'rules:\n  - rule: x\n    scope: ["!**/*.test.ts"]',
      'rules.0.scope.0',
    ],
    ['a repository without owner', 'context:\n  repos: [acme]', 'context.repos.0'],
    ['a repository with a path', 'context:\n  repos: [acme/web/x]', 'context.repos.0'],
    [
      'a long repository description',
      `context:\n  repos:\n    - repo: acme/web\n      description: ${'x'.repeat(301)}`,
      'context.repos.0.description',
    ],
    [
      'an unknown key in a repository',
      'context:\n  repos:\n    - repo: acme/web\n      ref: main',
      'context.repos.0.ref',
    ],
    [
      'a non-boolean privateOnPublic',
      'context:\n  privateOnPublic: yes please',
      'context.privateOnPublic',
    ],
    [
      'an exception in context files',
      'context:\n  files:\n    - path: "!docs/**"',
      'context.files.0.path',
    ],
  ])('rejects %s and names the key', (_case, text, path) => {
    const parsed = parseConfigText(text)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(new RegExp(`^${path.replaceAll('.', '\\.')}: `))
  })

  it.each([
    ['a list at the top', '- a\n- b'],
    ['a scalar at the top', 'just text'],
  ])('rejects %s', (_case, text) => {
    expect(parseConfigText(text).ok).toBe(false)
  })

  it('explains that exceptions with ! are not supported', () => {
    expect(parseConfigText('ignore: ["!src/keep.ts"]')).toEqual({
      ok: false,
      message: 'ignore.0: exceptions with ! are not supported; list only the files to match',
    })
  })

  it('reports broken YAML on one line', () => {
    const parsed = parseConfigText('rules: [unclosed')

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).not.toContain('\n')
  })

  it('reads related repositories as names or with a description', () => {
    const text = [
      'context:',
      '  repos:',
      '    - acme/web',
      '    - repo: acme/sdk',
      '      description: SDK for the frontends',
      '  privateOnPublic: true',
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        context: {
          repos: ['acme/web', { repo: 'acme/sdk', description: 'SDK for the frontends' }],
          privateOnPublic: true,
        },
      },
    })
  })

  it('reads investigate and the list of MCP servers', () => {
    expect(parseConfigText('investigate: false\nmcp: [linear, "claude.ai Linear"]')).toEqual({
      ok: true,
      config: { investigate: false, mcp: ['linear', 'claude.ai Linear'] },
    })
  })

  it('refuses mcp that is not a list of server names', () => {
    expect(parseConfigText('mcp: all').ok).toBe(false)
    const parsed = parseConfigText('mcp: ["a/b"]')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('use the server name as your AI CLI shows it')
  })

  it('reads MCP servers declared with a command or a url, and named ones with options', () => {
    const text = [
      'mcp:',
      '  - linear',
      "  - name: 'claude.ai Linear'",
      '    tools: [get_issue]',
      '    description: Ticket cited in the title',
      '  - name: tickets',
      '    command: npx',
      "    args: [-y, '@acme/tickets-mcp']",
      "    env: { TICKETS_TOKEN: '${TICKETS_TOKEN}' }",
      '    tools: [get_ticket]',
      '  - name: docs',
      '    url: https://mcp.acme.dev/mcp',
      "    headers: { Authorization: 'Bearer ${DOCS_TOKEN}', X-Project: acme }",
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        mcp: [
          'linear',
          {
            name: 'claude.ai Linear',
            tools: ['get_issue'],
            description: 'Ticket cited in the title',
          },
          {
            name: 'tickets',
            command: 'npx',
            args: ['-y', '@acme/tickets-mcp'],
            env: { TICKETS_TOKEN: '${TICKETS_TOKEN}' },
            tools: ['get_ticket'],
          },
          {
            name: 'docs',
            url: 'https://mcp.acme.dev/mcp',
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Project': 'acme' },
          },
        ],
      },
    })
  })

  it.each([
    [
      'command and url together',
      'mcp: [{ name: a, command: x, url: "https://x" }]',
      'use either command or url',
    ],
    [
      'the name phada',
      'mcp: [{ name: phada, command: x }]',
      "phada is the name of Phada's own server",
    ],
    [
      'a declared name with a space',
      'mcp: [{ name: "a b", command: x }]',
      'use letters, digits, dashes or underscores',
    ],
    ['an empty tools list', 'mcp: [{ name: a, tools: [] }]', 'mcp.0.tools'],
    [
      'a long description',
      `mcp: [{ name: a, description: "${'x'.repeat(301)}" }]`,
      'mcp.0.description',
    ],
    [
      'env without command',
      'mcp: [{ name: a, url: "https://x", env: { A: b } }]',
      'env goes with command',
    ],
    [
      'headers without url',
      'mcp: [{ name: a, command: x, headers: { A: b } }]',
      'headers go with url',
    ],
    ['an invalid variable name', 'mcp: [{ name: a, command: x, args: ["${1X}"] }]', 'mcp.0.args.0'],
    ['a server listed twice', 'mcp: [a, { name: a, tools: [t] }]', 'a is listed twice'],
  ])('refuses %s', (_name, text, message) => {
    const parsed = parseConfigText(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain(message)
  })

  it.each([
    [
      'an env key that names a secret',
      'env: { API_TOKEN: abc123 }',
      'mcp.0.env.API_TOKEN',
      'API_TOKEN',
      'abc123',
    ],
    [
      'an Authorization header',
      'headers: { Authorization: "Bearer abc" }',
      'mcp.0.headers.Authorization',
      'DOCS_AUTHORIZATION',
      'Bearer abc',
    ],
    [
      'a token in args',
      `args: ["--token=ghp_${'a'.repeat(36)}"]`,
      'mcp.0.args.0',
      'TOKEN',
      `ghp_${'a'.repeat(36)}`,
    ],
    [
      'a token in the url',
      `url: "https://x/mcp?k=sk-${'a'.repeat(24)}"`,
      'mcp.0.url',
      'TOKEN',
      `sk-${'a'.repeat(24)}`,
    ],
  ])('refuses a literal secret: %s', (_name, fields, key, variable, value) => {
    const transport = fields.startsWith('headers') || fields.startsWith('url') ? '' : 'command: x, '
    const url = fields.startsWith('headers') ? 'url: "https://x", ' : ''
    const parsed = parseConfigText(`mcp: [{ name: docs, ${transport}${url}${fields} }]`)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain(
      `${key}: put the secret in an environment variable, e.g. '\${${variable}}'`,
    )
    expect(parsed.message).not.toContain(value)
  })

  it('accepts literal values that do not look like secrets', () => {
    const parsed = parseConfigText(
      'mcp: [{ name: docs, url: "https://x", headers: { X-Project: acme, Authorization: "Bearer ${T}" } }]',
    )
    expect(parsed.ok).toBe(true)
  })

  it('reads the watch block and history', () => {
    const text = [
      'history: false',
      'watch:',
      '  interval: 90s',
      '  settle: 0s',
      '  maxReviewsPerHour: 10',
      '  repos:',
      '    - acme/shop',
      '    - repo: acme/web',
      '      publish: false',
      '      allowExternal: true',
      '      authors: [alice]',
      '      labels: [phada]',
      '      baseBranches: [main]',
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        history: false,
        watch: {
          interval: '90s',
          settle: '0s',
          maxReviewsPerHour: 10,
          repos: [
            'acme/shop',
            {
              repo: 'acme/web',
              publish: false,
              allowExternal: true,
              authors: ['alice'],
              labels: ['phada'],
              baseBranches: ['main'],
            },
          ],
        },
      },
    })
  })

  it.each([
    [
      'an interval under 60s',
      'watch:\n  interval: 30s\n  repos: [a/b]',
      'watch.interval: must be at least 60s',
    ],
    [
      'a duration without a unit',
      'watch:\n  settle: "5"\n  repos: [a/b]',
      'watch.settle: use a duration like 90s, 5m or 1h',
    ],
    ['no repositories', 'watch:\n  repos: []', 'watch.repos'],
    [
      'a repository listed twice',
      'watch:\n  repos: [A/b, a/B]',
      'watch.repos: a/b is listed twice',
    ],
    [
      'zero reviews per hour',
      'watch:\n  maxReviewsPerHour: 0\n  repos: [a/b]',
      'watch.maxReviewsPerHour',
    ],
  ])('refuses %s', (_case, text, message) => {
    const parsed = parseConfigText(text)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain(message)
  })
})

describe('review block', () => {
  it('reads the review prompt and skills', () => {
    const text = [
      'review:',
      '  prompt:',
      '    file: .phada/review.md',
      '    mode: replace',
      '  skills:',
      '    - phada',
      '    - superpowers:requesting-code-review',
      '    - name: security-review',
      '      paths: ["src/auth/**"]',
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        review: {
          prompt: { file: '.phada/review.md', mode: 'replace' },
          skills: [
            'phada',
            'superpowers:requesting-code-review',
            { name: 'security-review', paths: ['src/auth/**'] },
          ],
        },
      },
    })
  })

  it.each([
    [
      'an unknown prompt mode',
      'review:\n  prompt:\n    file: a.md\n    mode: merge',
      'review.prompt.mode',
    ],
    ['a skill name with a space', 'review:\n  skills: ["a b"]', 'review.skills.0'],
    [
      'a skill object name with a space',
      'review:\n  skills:\n    - name: "a b"',
      'review.skills.0.name',
    ],
    [
      'an exception in skill paths',
      'review:\n  skills:\n    - name: a\n      paths: ["!x"]',
      'review.skills.0.paths.0',
    ],
  ])('rejects %s and names the key', (_case, text, path) => {
    const parsed = parseConfigText(text)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(new RegExp(`^${path.replaceAll('.', '\\.')}`))
  })
})

describe('review block for native skills', () => {
  it('reads the skill mode, commands, readDirs and timeout', () => {
    const text = [
      'review:',
      '  skills:',
      '    - code-review:code-review',
      '    - name: my-plugin:review',
      '      mode: text',
      '    - claude:security-review',
      '  commands: ["npm test", "make lint"]',
      '  readDirs: ["~/review-rules"]',
      '  timeout: 30m',
    ].join('\n')

    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        review: {
          skills: [
            'code-review:code-review',
            { name: 'my-plugin:review', mode: 'text' },
            'claude:security-review',
          ],
          commands: ['npm test', 'make lint'],
          readDirs: ['~/review-rules'],
          timeout: '30m',
        },
      },
    })
  })

  it.each(['read-only', 'all'])('reads commands: %s', (policy) => {
    expect(parseConfigText(`review:\n  commands: ${policy}`)).toEqual({
      ok: true,
      config: { review: { commands: policy } },
    })
  })

  it.each([
    ['an unknown commands mode', 'review:\n  commands: some', 'review.commands'],
    ['a command with a wildcard', 'review:\n  commands: ["rm *"]', 'review.commands'],
    ['a command with a comma', 'review:\n  commands: ["npm test, make"]', 'review.commands'],
    ['a timeout under a minute', 'review:\n  timeout: 10s', 'review.timeout'],
    ['a timeout over two hours', 'review:\n  timeout: 3h', 'review.timeout'],
    [
      'an unknown skill mode',
      'review:\n  skills:\n    - name: a\n      mode: fast',
      'review.skills.0',
    ],
  ])('rejects %s and names the key', (_case, text, path) => {
    const parsed = parseConfigText(text)

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain(path)
  })
})
