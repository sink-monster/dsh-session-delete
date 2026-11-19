/**
 * End-to-end check of the reveal handoff with the REAL process launcher:
 * opens a temp folder through the plugin's own code path, then reads the
 * Explorer window titles to prove a folder window actually appeared.
 */
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apply } from '../index.js'

const run = promisify(execFile)
const folder = join(tmpdir(), `session-delete-reveal-${Date.now()}`)
await mkdir(folder, { recursive: true })

const routes = new Map()
const ctx = {
  effect(fn) { return fn() },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
  connection: { requestRejection: () => undefined },
  sessionPersistence: { async stat() { return { location: { kind: 'jsonl', path: join(folder, 'session.v4.jsonl.zstd') } } } },
  agents: { get: () => undefined },
  get: () => undefined,
  emit() {},
}
apply(ctx)   // real launcher, no internals override

const req = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'x' })) },
  resume() {},
}
const res = {
  statusCode: 0, body: '', headers: {},
  setHeader(k, v) { this.headers[k] = v },
  end(text) { this.body = text ?? '' },
}
await routes.get('/session-delete/reveal')(req, res)
console.log('reveal status:', res.statusCode, res.body)

// Give Explorer time to create its window, then read window titles.
await new Promise(resolve => setTimeout(resolve, 2000))
const script = "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle"
let titles = []
try {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 15000 })
  titles = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
} catch (error) {
  console.log('title query failed:', error.message)
}

const leaf = folder.split('\\').pop()
const match = titles.filter(title => title.includes(leaf))
console.log('explorer windows:', titles.filter(t => /explorer|文件|会话/i.test(t) || t.includes(leaf)))
console.log(match.length > 0 ? `WINDOW OPENED: ${match.join(' | ')}` : 'NO MATCHING WINDOW TITLE FOUND')
await rm(folder, { recursive: true, force: true })
process.exit(match.length > 0 ? 0 : 1)
