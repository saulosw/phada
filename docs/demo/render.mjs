import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const [reviewPath, outputPath] = process.argv.slice(2)
const token = process.env.GITHUB_TOKEN
if (reviewPath === undefined || outputPath === undefined || token === undefined) {
  process.stderr.write('usage: GITHUB_TOKEN=… node render.mjs <review.json> <output.png>\n')
  process.exit(2)
}

const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
const { repo: repository, number } = review.pullRequest
const files = await github(`/repos/${repository}/pulls/${number}/files`)
const html = page(
  await markdown(review.publication.body),
  await Promise.all(review.publication.comments.map(comment)),
)
const htmlPath = join(mkdtempSync(join(tmpdir(), 'phada-render-')), 'review.html')
writeFileSync(htmlPath, html)
writeFileSync(outputPath, await screenshot(`file://${htmlPath}`))

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`)
  return path === '/markdown' ? response.text() : response.json()
}

function markdown(text) {
  return github('/markdown', {
    method: 'POST',
    body: JSON.stringify({ text, mode: 'gfm', context: repository }),
  })
}

async function comment({ path, startLine, line, body }) {
  const lines = newLines(files.find((file) => file.filename === path)?.patch ?? '')
  const first = startLine ?? line
  const suggestions = []
  const text = body.replace(/```suggestion\n([\s\S]*?)```/g, (_, code) => {
    suggestions.push(code.replace(/\n$/, ''))
    return `PHADA-SUGGESTION-${suggestions.length - 1}`
  })
  const rendered = (await markdown(text)).replace(
    /<p[^>]*>PHADA-SUGGESTION-(\d+)<\/p>/g,
    (_, index) => suggestion(lines, first, line, suggestions[Number(index)]),
  )
  const context = [...lines.entries()].filter(([number]) => number > line - 4 && number <= line)
  return `<section class="thread">
  <header>${escape(path)}</header>
  <table class="diff">${context
    .map(
      ([number, code]) =>
        `<tr class="${number >= first ? 'picked' : ''}"><td class="num">${number}</td><td><pre>${escape(code)}</pre></td></tr>`,
    )
    .join('')}</table>
  <div class="comment markdown-body">${rendered}</div>
</section>`
}

function suggestion(lines, first, last, code) {
  const removed = []
  for (let number = first; number <= last; number++) removed.push(lines.get(number) ?? '')
  const row = (kind, text) => `<tr class="${kind}"><td><pre>${escape(text)}</pre></td></tr>`
  return `<div class="suggestion"><header>Suggested change</header><table>${removed
    .map((text) => row('del', `- ${text}`))
    .join('')}${code
    .split('\n')
    .map((text) => row('add', `+ ${text}`))
    .join('')}</table></div>`
}

function newLines(patch) {
  const lines = new Map()
  let number = 0
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text)
    if (hunk !== null) number = Number(hunk[1])
    else if (text.startsWith('-')) continue
    else lines.set(number++, text.slice(1))
  }
  return lines
}

function escape(text) {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

function page(body, threads) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 24px; width: 860px; background: #fff; color: #1f2328;
  font: 14px/1.5 -apple-system, "Segoe UI", "Liberation Sans", "DejaVu Sans", sans-serif; }
.box { border: 1px solid #d1d9e0; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
.box > header, .thread > header { background: #f6f8fa; border-bottom: 1px solid #d1d9e0;
  padding: 8px 16px; font-weight: 600; }
.markdown-body { padding: 16px; }
.markdown-body h2 { font-size: 20px; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid #d1d9e0; }
.markdown-body h3 { font-size: 16px; margin: 16px 0 8px; }
.markdown-body p { margin: 0 0 12px; }
.markdown-body code { background: #eff1f3; border-radius: 6px; padding: 2px 5px; font-size: 85%;
  font-family: "DejaVu Sans Mono", monospace; }
.markdown-body pre { background: #f6f8fa; border-radius: 6px; padding: 12px; }
.markdown-body table { border-collapse: collapse; margin: 8px 0; }
.markdown-body td, .markdown-body th { border: 1px solid #d1d9e0; padding: 4px 10px; }
.markdown-body sub { color: #59636e; }
.thread { border: 1px solid #d1d9e0; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
.thread > header { font-family: "DejaVu Sans Mono", monospace; font-size: 12px; }
table.diff { width: 100%; border-collapse: collapse; border-bottom: 1px solid #d1d9e0; }
table.diff td { padding: 0 8px; } table.diff pre, .suggestion pre { margin: 0;
  font: 12px/20px "DejaVu Sans Mono", monospace; white-space: pre-wrap; padding: 0; background: none; border-radius: 0; }
table.diff .num { width: 40px; color: #59636e; text-align: right; font: 12px/20px "DejaVu Sans Mono", monospace; }
table.diff tr.picked { background: #fff8c5; }
.suggestion { border: 1px solid #d1d9e0; border-radius: 6px; margin: 0 0 12px; overflow: hidden; }
.suggestion header { background: #f6f8fa; border-bottom: 1px solid #d1d9e0; padding: 6px 12px; font-size: 12px; font-weight: 600; }
.suggestion table { width: 100%; border-collapse: collapse; }
.suggestion td { padding: 0 12px; border: 0; }
.suggestion tr.del { background: #ffebe9; } .suggestion tr.add { background: #dafbe1; }
</style></head><body>
<div class="box"><header>Review</header><div class="markdown-body">${body}</div></div>
${threads.join('\n')}
</body></html>`
}

async function screenshot(url) {
  const port = 9222
  const browser = spawn(
    'chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  try {
    const target = await pageTarget(port)
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
    let id = 0
    const pending = new Map()
    const events = new Map()
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id !== undefined) pending.get(message.id)?.(message.result)
      else events.get(message.method)?.()
    })
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        pending.set(++id, resolve)
        socket.send(JSON.stringify({ id, method, params }))
      })
    await send('Page.enable')
    const loaded = new Promise((resolve) => events.set('Page.loadEventFired', resolve))
    await send('Page.navigate', { url })
    await loaded
    const { cssContentSize } = await send('Page.getLayoutMetrics')
    await send('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(cssContentSize.width),
      height: Math.ceil(cssContentSize.height),
      deviceScaleFactor: 2,
      mobile: false,
    })
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    socket.close()
    return Buffer.from(data, 'base64')
  } finally {
    browser.kill()
  }
}

async function pageTarget(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find((candidate) => candidate.type === 'page')
      if (target !== undefined) return target
    } catch {}
    await wait(200)
  }
  throw new Error('Chromium did not start')
}
