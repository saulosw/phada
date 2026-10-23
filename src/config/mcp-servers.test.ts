import { describe, expect, it } from 'vitest'
import { ConfigError } from './errors.js'
import { NO_MCP, resolveMcp, userMcp } from './mcp-servers.js'
import type { ConfigLayer } from './types.js'

const layer = (kind: ConfigLayer['kind'], config: ConfigLayer['config']): ConfigLayer => ({
  kind,
  dir: '',
  configLabel: `${kind}:config.yml`,
  config,
})

describe('userMcp', () => {
  it('joins the MCP servers of the user layers once, the repository layer first', () => {
    expect(
      userMcp([
        layer('user', { mcp: ['linear', 'notion'] }),
        layer('user-repo', { mcp: ['notion', 'jira'] }),
        layer('repo-root', { mcp: ['evil'] }),
      ]),
    ).toEqual(['notion', 'jira', 'linear'])
  })

  it('user-repo entry replaces a user entry with the same name', () => {
    expect(
      userMcp([
        layer('user', { mcp: ['tickets', 'linear'] }),
        layer('user-repo', { mcp: [{ name: 'tickets', command: 'node', args: ['t.js'] }] }),
      ]),
    ).toEqual([{ name: 'tickets', command: 'node', args: ['t.js'] }, 'linear'])
  })
})

describe('resolveMcp', () => {
  it('splits named servers from declared ones', () => {
    expect(resolveMcp(['linear', { name: 'claude.ai Linear', tools: ['get_issue'] }], {})).toEqual({
      names: [{ name: 'linear' }, { name: 'claude.ai Linear', tools: ['get_issue'] }],
      declared: [],
    })
  })

  it('expands variables whole and inside text in env, headers, args and url', () => {
    const env = { TOKEN: 's3cret', HOST: 'mcp.acme.dev', DIR: '/opt/t' }
    expect(
      resolveMcp(
        [
          {
            name: 'tickets',
            command: 'node',
            args: ['${DIR}/server.js'],
            env: { TICKETS_TOKEN: '${TOKEN}' },
            description: 'Tickets',
            tools: ['get_ticket'],
          },
          {
            name: 'docs',
            url: 'https://${HOST}/mcp',
            headers: { Authorization: 'Bearer ${TOKEN}' },
          },
        ],
        env,
      ),
    ).toEqual({
      names: [],
      declared: [
        {
          name: 'tickets',
          transport: {
            kind: 'stdio',
            command: 'node',
            args: ['/opt/t/server.js'],
            env: { TICKETS_TOKEN: 's3cret' },
          },
          description: 'Tickets',
          tools: ['get_ticket'],
        },
        {
          name: 'docs',
          transport: {
            kind: 'http',
            url: 'https://mcp.acme.dev/mcp',
            headers: { Authorization: 'Bearer s3cret' },
          },
        },
      ],
    })
  })

  it('fails naming the server and the variable when a variable is not set', () => {
    const resolve = () =>
      resolveMcp(
        [{ name: 'tickets', command: 'node', env: { A: '${PRESENT}', B: '${MISSING}' } }],
        { PRESENT: 'value-that-must-not-leak', MISSING: '' },
      )
    expect(resolve).toThrow(ConfigError)
    expect(resolve).toThrow('mcp server tickets: MISSING is not set.')
    try {
      resolve()
    } catch (error) {
      expect(String(error)).not.toContain('value-that-must-not-leak')
    }
  })

  it('has an empty value for no servers', () => {
    expect(resolveMcp([], {})).toEqual(NO_MCP)
  })
})
