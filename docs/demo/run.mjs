import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const IMAGE = 'phada-demo-vhs'
const PULL_REQUEST = 'saulosw/phada-demo#1'
const root = resolve(import.meta.dirname, '../..')
const token = githubToken()

const MEDIA = {
  review: { command: 'vhs docs/demo/review.tape', delayMs: 4000, frames: 'review.txt' },
  app: { command: 'vhs docs/demo/app.tape', delayMs: 6000, frames: 'app.txt' },
  png: {
    command: `phada review ${PULL_REQUEST} --dry-run --format json > /demo/review.json && node docs/demo/render.mjs /demo/review.json docs/demo/review.png`,
    delayMs: 0,
  },
}
const chosen = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(MEDIA)

run('npm', ['run', 'build'])
run('docker', ['build', '--quiet', '--tag', IMAGE, join(root, 'docs/demo')])
for (const name of chosen) {
  const media = MEDIA[name]
  if (media === undefined)
    throw new Error(`Unknown media ${name}: ${Object.keys(MEDIA).join(', ')}`)
  record(name, media.command, media.delayMs)
  if (media.frames !== undefined) checkFrames(name, join(root, 'docs/demo', media.frames))
}

function checkFrames(name, path) {
  const text = readFileSync(path, 'utf8')
  rmSync(path)
  if ([token, '/home/', '/tmp/', '/demo/'].some((leak) => text.includes(leak))) {
    rmSync(join(root, `docs/demo/${name}.gif`), { force: true })
    throw new Error(`docs/demo/${name}.gif showed a local path or the token and was removed`)
  }
}

function record(name, command, delayMs) {
  const home = mkdtempSync(join(tmpdir(), `phada-demo-${name}-`))
  mkdirSync(join(home, 'config'))
  writeFileSync(join(home, 'config/config.yml'), 'provider: claude\nlanguage: en\n')
  try {
    run(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '--volume',
        `${root}:/phada`,
        '--volume',
        `${home}:/demo`,
        '--workdir',
        '/phada',
        '--env',
        'HOME=/demo',
        '--env',
        'GITHUB_TOKEN',
        '--env',
        'PHADA_CONFIG_HOME=/demo/config',
        '--env',
        'PHADA_CACHE_HOME=/demo/cache',
        '--env',
        'PHADA_DATA_HOME=/demo/data',
        '--env',
        'PHADA_DEMO_RECORDING=/phada/docs/demo/recording',
        '--env',
        'PHADA_DEMO_STATE=/demo/replay-state',
        '--env',
        `PHADA_DEMO_DELAY_MS=${delayMs}`,
        '--env',
        'PATH=/phada/docs/demo/bin:/phada/docs/demo/replay:/usr/local/bin:/usr/bin:/bin',
        '--entrypoint',
        'sh',
        IMAGE,
        '-c',
        command,
      ],
      { ...process.env, GITHUB_TOKEN: token },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env })
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed with exit code ${result.status}`)
  }
}

function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  if (token.status === 0 && token.stdout.trim() !== '') return token.stdout.trim()
  const status = spawnSync('gh', ['auth', 'status', '--show-token'], { encoding: 'utf8' })
  const match = /Token: (\S+)/.exec(`${status.stdout}${status.stderr}`)
  if (match !== null) return match[1]
  throw new Error('Set GITHUB_TOKEN or log in with gh auth login')
}
