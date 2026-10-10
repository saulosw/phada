import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface PackResult {
  filename: string
  files: { path: string }[]
}

const TIMEOUT_MS = 120_000
const PACKAGED_FILE = /^(dist\/.+\.js|package\.json|README\.md|LICENSE)$/

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const dir = mkdtempSync(join(tmpdir(), 'phada-smoke-'))

try {
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dir]).stdout) as [
    PackResult,
  ]
  const unexpected = pack.files
    .map(({ path }) => path)
    .filter((path) => !PACKAGED_FILE.test(path) || path.endsWith('.test.js'))
  check(unexpected.length === 0, `unexpected files in the package: ${unexpected.join(', ')}`)
  for (const file of ['dist/bin.js', 'dist/investigation/mcp-bridge.js', 'README.md', 'LICENSE']) {
    check(
      pack.files.some(({ path }) => path === file),
      `${file} is missing from the package`,
    )
  }

  run('npm', [
    'install',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--prefix',
    dir,
    join(dir, pack.filename),
  ])
  const phada = join(dir, 'node_modules', '.bin', 'phada')

  check(run(phada, ['--version']).stdout === `${version}\n`, `phada --version is not ${version}`)
  check(run(phada, ['--help']).stdout.startsWith('Usage: phada <command>'), 'phada --help')
  check(run(phada, ['review', '--help']).stdout.includes('--min-confidence'), 'review --help')

  const noToken = spawnSync(phada, ['review', 'acme/shop#1'], {
    encoding: 'utf8',
    env: withoutTokens(),
    timeout: TIMEOUT_MS,
  })
  check(
    noToken.status === 1 && noToken.stderr.startsWith('phada: No GitHub token found.'),
    `phada review without a token: exit ${noToken.status}, ${noToken.stderr}`,
  )
  const server = join(dir, 'node_modules', 'phada', 'dist', 'investigation', 'mcp-server.js')
  const mcp = spawnSync(process.execPath, ['--input-type=module', '-e', mcpRoundTrip(server)], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  })
  check(
    mcp.status === 0 && mcp.stdout.trim() === '{"jsonrpc":"2.0","id":1,"result":{}}',
    `MCP bridge round trip: exit ${mcp.status}, ${mcp.stdout}${mcp.stderr}`,
  )
  process.stdout.write(`smoke ok: phada ${version} (${pack.files.length} files)\n`)
} catch (error) {
  process.stderr.write(`smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}

function run(command: string, args: string[]): { stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: TIMEOUT_MS })
  check(
    result.status === 0,
    `${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`}):\n${result.stderr}`,
  )
  return { stdout: result.stdout }
}

function mcpRoundTrip(serverModule: string): string {
  return `
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const { serveMcp } = await import(pathToFileURL(${JSON.stringify(serverModule)}).href)
const toolbox = { definitions: [], call: async () => ({ text: '', isError: false }), touchedPaths: () => [] }
const server = await serveMcp(toolbox, { execArgv: [] })
const child = spawn(server.launch.command, server.launch.args)
child.stdout.once('data', async (data) => {
  process.stdout.write(String(data))
  child.kill()
  await server.close()
})
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\\n')
`
}

function withoutTokens(): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN: _github, GH_TOKEN: _gh, ...env } = process.env
  return env
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
