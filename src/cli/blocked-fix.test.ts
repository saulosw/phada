import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { blockedFix, blockedFixer } from './blocked-fix.js'

const context = { external: false, configPath: '/home/u/.config/phada/config.yml' }
const fix = (tool: string, input: string, extra: Partial<typeof context> = {}) =>
  blockedFix({ tool, input }, { ...context, ...extra })

describe('blockedFix', () => {
  it('allows the command in your own config', () => {
    expect(fix('Bash', 'npm test -- --run')).toBe(
      'allow it with review.commands: ["npm test"] in /home/u/.config/phada/config.yml',
    )
  })

  it.each([
    ['cd sub && npm test', 'npm test'],
    ['npm test | tee out.txt', 'npm test'],
    ['git diff && make lint', 'make lint'],
    ['./scripts/check.sh --fast', './scripts/check.sh'],
    ['FOO=1 npm run build', 'npm run'],
    ['cd /tmp/x/repo; cat /tmp/x/a.diff; git ls-files; gh pr view 2', 'cd", "cat'],
  ])('suggests the denied part of a compound command: %s', (command, prefix) => {
    expect(fix('Bash', command)).toContain(`review.commands: ["${prefix}"]`)
  })

  it('allows a folder for a read outside the checkout', () => {
    expect(fix('Read', '/home/u/rules/a.md')).toBe(
      'allow it with review.readDirs: ["/home/u/rules"] in /home/u/.config/phada/config.yml',
    )
    expect(fix('Grep', '/home/u/rules')).toBe(
      'allow it with review.readDirs: ["/home/u/rules"] in /home/u/.config/phada/config.yml',
    )
  })

  it('says an outside author always runs read-only', () => {
    expect(fix('Bash', 'npm test', { external: true })).toBe(
      'this pull request is from an outside author: the skill always runs read-only',
    )
  })

  it('says writes and the web are never allowed', () => {
    for (const tool of ['Write', 'Edit', 'WebFetch', 'WebSearch']) {
      expect(fix(tool, 'x')).toBe('Phada never lets a skill write files or use the web')
    }
  })
})

describe('blockedFixer', () => {
  it('reads the author and the config folder', () => {
    const fixer = blockedFixer({
      pullRequest: { ...pullRequestFixture(), private: false, association: 'NONE' },
      env: { PHADA_CONFIG_HOME: '/cfg' },
      home: '/home/u',
    })

    expect(fixer({ tool: 'Bash', input: 'npm test' })).toContain('outside author')
    const own = blockedFixer({
      pullRequest: pullRequestFixture(),
      env: { PHADA_CONFIG_HOME: '/cfg' },
      home: '/home/u',
    })
    expect(own({ tool: 'Bash', input: 'npm test' })).toContain('in /cfg/config.yml')
  })
})

describe('blockedFix with your command list', () => {
  const listed = { external: false, configPath: '/cfg/config.yml', policy: ['npm test'] }

  it.each([
    ['cd sub && npm test', '"cd"'],
    ['npm test | tee out.txt', '"tee"'],
  ])('suggests only what your list does not allow: %s', (command, expected) => {
    expect(blockedFix({ tool: 'Bash', input: command }, listed)).toBe(
      `allow it with review.commands: [${expected}] in /cfg/config.yml`,
    )
  })

  it('reads the list from your config', () => {
    const fixer = blockedFixer({
      pullRequest: pullRequestFixture(),
      env: { PHADA_CONFIG_HOME: '/cfg' },
      home: '/home/u',
      review: { commands: { policy: ['npm test'], origin: 'user:config.yml' } },
    })

    expect(fixer({ tool: 'Bash', input: 'npm test && make lint' })).toContain('["make lint"]')
  })

  it('names a tool a native skill cannot use', () => {
    expect(blockedFix({ tool: 'mcp__other__x', input: '{}' }, listed)).toBe(
      'this tool is not available to a native skill',
    )
  })
})
