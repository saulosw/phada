import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface PackResult {
  filename: string
  files: { path: string }[]
}

const TIMEOUT_MS = 120_000
const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go'].map(
  (name) => `dist/grammars/tree-sitter-${name}.wasm`,
)
const PACKAGED_FILE =
  /^(dist\/.+\.js|dist\/grammars\/tree-sitter-(typescript|tsx|javascript|python|go)\.wasm|package\.json|README\.md|LICENSE)$/

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
  for (const file of [
    'dist/bin.js',
    'dist/investigation/mcp/mcp-bridge.js',
    'dist/tui/open-app.js',
    'README.md',
    'LICENSE',
    ...GRAMMARS,
  ]) {
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
  const indexHelp = spawnSync(phada, ['index', '--help'], { encoding: 'utf8', timeout: TIMEOUT_MS })
  check(indexHelp.status === 0 && indexHelp.stdout.startsWith('Usage: phada index'), 'index --help')
  check(!indexHelp.stderr.includes('ExperimentalWarning'), 'index --help prints a warning')
  const builtInPrompt = spawnSync(phada, ['prompt', '--default'], {
    encoding: 'utf8',
    env: withoutGitHub(),
    timeout: TIMEOUT_MS,
  })
  check(
    builtInPrompt.status === 0 && builtInPrompt.stdout.includes('You are a senior engineer'),
    `phada prompt --default: exit ${builtInPrompt.status}, ${builtInPrompt.stderr}`,
  )

  const noToken = spawnSync(phada, ['review', 'acme/shop#1'], {
    encoding: 'utf8',
    env: withoutGitHub(),
    timeout: TIMEOUT_MS,
  })
  check(
    noToken.status === 1 &&
      noToken.stderr.startsWith('phada: No GitHub token found.') &&
      noToken.stderr.includes('gh auth login'),
    `phada review without a token: exit ${noToken.status}, ${noToken.stderr}`,
  )
  const noCommand = spawnSync(phada, [], { encoding: 'utf8', timeout: TIMEOUT_MS })
  check(
    noCommand.status === 2 &&
      noCommand.stderr ===
        'phada: Missing the command, e.g. phada review owner/repo#123. Run with --help for usage.\n',
    `phada with no command outside a terminal: exit ${noCommand.status}, ${noCommand.stderr}`,
  )
  const setup = spawnSync(phada, ['setup'], { encoding: 'utf8', timeout: TIMEOUT_MS })
  check(
    setup.status === 2 &&
      setup.stderr ===
        'phada: phada setup needs an interactive terminal. Run with --help for usage.\n',
    `phada setup outside a terminal: exit ${setup.status}, ${setup.stderr}`,
  )
  const appEntry = join(dir, 'node_modules', 'phada', 'dist', 'tui', 'open-app.js')
  const tui = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { openApp } = await import(${JSON.stringify(pathToFileURL(appEntry).href)}); process.stdout.write(typeof openApp)`,
    ],
    { encoding: 'utf8', timeout: TIMEOUT_MS },
  )
  check(
    tui.status === 0 && tui.stdout === 'function',
    `the app entry from the package: exit ${tui.status}, ${tui.stdout}${tui.stderr}`,
  )
  const queue = spawnSync(phada, ['mcp'], {
    encoding: 'utf8',
    env: {
      ...withoutGitHub(),
      PHADA_CONFIG_HOME: join(dir, 'config'),
      PHADA_DATA_HOME: join(dir, 'data'),
    },
    input: [
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      '',
    ].join('\n'),
    timeout: TIMEOUT_MS,
  })
  check(
    queue.status === 0 && queue.stdout.includes('"review_pull_request"'),
    `phada mcp over stdio: exit ${queue.status}, ${queue.stdout}${queue.stderr}`,
  )
  const server = join(dir, 'node_modules', 'phada', 'dist', 'investigation', 'mcp', 'mcp-server.js')
  const mcp = spawnSync(process.execPath, ['--input-type=module', '-e', mcpRoundTrip(server)], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  })
  check(
    mcp.status === 0 && mcp.stdout.trim() === '{"jsonrpc":"2.0","id":1,"result":{}}',
    `MCP bridge round trip: exit ${mcp.status}, ${mcp.stdout}${mcp.stderr}`,
  )
  const extractor = join(dir, 'node_modules', 'phada', 'dist', 'repo-map', 'extract.js')
  const extracted = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', extraction(extractor)],
    { encoding: 'utf8', timeout: TIMEOUT_MS },
  )
  check(
    extracted.status === 0 && extracted.stdout.trim() === 'f,a,F',
    `extraction with the packaged grammars: exit ${extracted.status}, ${extracted.stdout}${extracted.stderr}`,
  )
  const graph = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--no-warnings',
      '-e',
      graphQuery(join(dir, 'node_modules', 'phada', 'dist'), dir),
    ],
    { encoding: 'utf8', timeout: TIMEOUT_MS },
  )
  check(
    graph.status === 0 && graph.stdout.trim() === 'b.ts:2 calls',
    `repository graph from the package: exit ${graph.status}, ${graph.stdout}${graph.stderr}`,
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

function extraction(extractorModule: string): string {
  return `
import { pathToFileURL } from 'node:url'
const { createExtractor } = await import(pathToFileURL(${JSON.stringify(extractorModule)}).href)
const extractor = createExtractor()
const ts = await extractor.extract('typescript', 'export function f(a) { g(a) }')
const go = await extractor.extract('go', 'package p\\nfunc F() {}')
process.stdout.write([...ts.symbols, ...go.symbols].map((symbol) => symbol.name).join(','))
`
}

function graphQuery(distDir: string, workDir: string): string {
  const module = (path: string) => JSON.stringify(join(distDir, path))
  return `
import { pathToFileURL } from 'node:url'
const load = (path) => import(pathToFileURL(path).href)
const { createExtractor } = await load(${module('repo-map/extract.js')})
const { openIndexStore } = await load(${module('store/index-store.js')})
const { openRepositoryGraph } = await load(${module('graph/repository-graph.js')})
const files = { 'a.ts': 'export function f() {}\\n', 'b.ts': "import { f } from './a'\\nf()\\n" }
const extractor = createExtractor()
const store = await openIndexStore(${JSON.stringify(join(workDir, 'graph.sqlite'))})
const commitFiles = []
for (const [path, text] of Object.entries(files)) {
  const oid = path.padEnd(40, '0')
  store.saveBlob({ oid, language: 'typescript', bytes: text.length, status: 'indexed', map: await extractor.extract('typescript', text) })
  commitFiles.push({ path, oid, language: 'typescript', status: 'indexed' })
}
store.saveCommit({ sha: 'c'.repeat(40), ref: 'HEAD', durationMs: 1, files: commitFiles })
const graph = await openRepositoryGraph({ reader: store.reader('c'.repeat(40)), readText: async (path) => files[path] })
process.stdout.write(graph.callers({ name: 'f' }).sites.map((site) => site.path + ':' + site.line + ' ' + site.kind).join(','))
store.close()
`
}

function withoutGitHub(): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN: _github, GH_TOKEN: _gh, ...env } = process.env
  return { ...env, PATH: dirname(process.execPath), GH_CONFIG_DIR: join(dir, 'gh') }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
