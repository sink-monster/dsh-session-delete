/**
 * Behavioural harness for the Host half of dsh-session-delete.
 * Runs the real handlers against a temp session store; the Cordis services and
 * the process launcher are faked through the plugin's documented internals.
 * Run with: node host.test.mjs
 */
import { EventEmitter } from 'node:events'
import { mkdir, readdir, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const failures = []
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(name)
  }
}

const root = join(tmpdir(), `session-delete-test-${Date.now()}`)
const projectDir = join(root, '--proj--')

/** Fake launcher: records argv and reports one exit code or one spawn failure. */
function makeSpawn({ code = 0, fail = false } = {}) {
  const calls = []
  const impl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.kill = () => {}
    queueMicrotask(() => {
      if (fail) child.emit('error', Object.assign(new Error('spawn explorer.exe ENOENT'), { code: 'ENOENT' }))
      else child.emit('close', code)
    })
    return child
  }
  return { calls, impl }
}

/** Fake Cordis context that records registrations. */
function makeContext({ paths, agents, reject, spawnImpl, rmImpl }) {
  const routes = new Map()
  const emitted = []
  const registryCalls = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    connection: { requestRejection: () => reject },
    sessionPersistence: {
      async stat(id) {
        const path = paths.get(id)
        return path === undefined ? undefined : { location: { kind: 'jsonl', path } }
      },
    },
    agents: { get: id => agents.get(id) },
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        async unarchiveSession(id) { registryCalls.push(['unarchive', id]) },
        async unpinSession(id) { registryCalls.push(['unpin', id]) },
      }
    },
    emit(name, id) { emitted.push([name, id]) },
  }
  apply(ctx, { internals: { spawn: spawnImpl, platform: 'win32', rm: rmImpl } })
  return { ctx, routes, emitted, registryCalls }
}

function makeRequest(method, body, contentType = 'application/json') {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    headers: text === '' ? {} : { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text, 'utf8')
    },
    resume() {},
  }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text ?? '' },
    json() { return JSON.parse(this.body) },
  }
}

async function call(handler, { method = 'POST', body } = {}) {
  const req = makeRequest(method, body)
  const res = makeResponse()
  await handler(req, res)
  return { status: res.statusCode, payload: res.body === '' ? null : res.json() }
}

async function makeSessionDir(id) {
  await mkdir(join(projectDir, `session-${id}`), { recursive: true })
  await writeFile(join(projectDir, `session-${id}`, 'session.v4.jsonl.zstd'), 'log')
  return join(projectDir, `session-${id}`, 'session.v4.jsonl.zstd')
}

const paths = new Map()
paths.set('idle', await makeSessionDir('idle'))
paths.set('running', await makeSessionDir('running'))
paths.set('happy', await makeSessionDir('happy'))
const foreignFile = paths.get('foreign') ?? await makeSessionDir('foreign')
await writeFile(join(projectDir, 'session-foreign', 'notes.txt'), 'keep me')
paths.set('foreign', foreignFile)

const agents = new Map([['running', { status: 'running' }], ['idle', { status: 'idle' }]])
const { routes, emitted, registryCalls } = makeContext({ paths, agents, reject: undefined, spawnImpl: makeSpawn().impl })
const del = routes.get('/session-delete/delete')
const reveal = routes.get('/session-delete/reveal')

console.log(`routes: ${[...routes.keys()].join(', ')}`)
check('two exact routes registered', routes.size === 2)

console.log('\nwire validation')
const methodRes = makeResponse()
await del(makeRequest('GET'), methodRes)
check('GET rejected with 405', methodRes.statusCode === 405 && methodRes.headers.allow === 'POST', `${methodRes.statusCode} ${methodRes.headers.allow}`)
check('non-JSON body rejected with 400', (await call(del, { body: 'sessionId=x' })).status === 400)
check('empty sessionId rejected with 400', (await call(del, { body: { sessionId: '' } })).status === 400)
const missing = await call(del, { body: { sessionId: 'nope' } })
check('missing session rejected with 409 not-stored', missing.status === 409 && missing.payload.reason === 'not-stored')

console.log('\nrunning guard')
const runningResult = await call(del, { body: { sessionId: 'running' } })
check('running turn refused with 409 running', runningResult.status === 409 && runningResult.payload.reason === 'running', JSON.stringify(runningResult.payload))
check('running session log untouched', (await stat(paths.get('running'))).isFile())

console.log('\nidle-but-open session (the sidebar-switch case)')
const idleResult = await call(del, { body: { sessionId: 'idle' } })
check('idle live Agent no longer blocks deletion', idleResult.status === 200 && idleResult.payload.ok === true, JSON.stringify(idleResult.payload))
check('idle session directory removed', (await stat(join(projectDir, 'session-idle')).catch(() => null)) === null)

console.log('\ndelete guards')
const foreignResult = await call(del, { body: { sessionId: 'foreign' } })
check('foreign entry refused with 409 unexpected', foreignResult.status === 409 && foreignResult.payload.reason === 'unexpected', JSON.stringify(foreignResult.payload))
check('foreign entry kept', (await stat(join(projectDir, 'session-foreign', 'notes.txt'))).isFile())

console.log('\ndelete happy path')
const happyResult = await call(del, { body: { sessionId: 'happy' } })
check('delete answers 200', happyResult.status === 200 && happyResult.payload.ok === true, JSON.stringify(happyResult.payload))
check('reports one removed file', happyResult.payload?.removedFiles === 1, JSON.stringify(happyResult.payload))
check('session directory removed', (await stat(join(projectDir, 'session-happy')).catch(() => null)) === null)
check('removed broadcast emitted', emitted.some(([name, id]) => name === 'api-session/removed' && id === 'happy'))
check('registry pruned', registryCalls.length === 4, JSON.stringify(registryCalls))

console.log('\nlocked log (busy)')
const busyPath = await makeSessionDir('busy')
paths.set('busy', busyPath)
const busyCtx = makeContext({
  paths, agents, reject: undefined, spawnImpl: makeSpawn().impl,
  // Another handle keeps the log open: every removal attempt reports EBUSY.
  rmImpl: async () => { throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }) },
})
const busyResult = await call(busyCtx.routes.get('/session-delete/delete'), { body: { sessionId: 'busy' } })
check('locked log reports 409 busy', busyResult.status === 409 && busyResult.payload.reason === 'busy', JSON.stringify(busyResult.payload))
check('busy reply reports no removal', busyResult.payload.removedFiles === 0, JSON.stringify(busyResult.payload))
check('busy path does not broadcast a removal', busyCtx.emitted.length === 0, JSON.stringify(busyCtx.emitted))
check('busy path keeps the log', (await stat(busyPath)).isFile())
await rm(join(projectDir, 'session-busy'), { recursive: true, force: true })

console.log('\nreveal handoff')
const revealSpawn = makeSpawn({ code: 0 })
const revealCtx = makeContext({ paths, agents, reject: undefined, spawnImpl: revealSpawn.impl })
const revealOk = await call(revealCtx.routes.get('/session-delete/reveal'), { body: { sessionId: 'foreign' } })
check('reveal answers 200 with the directory', revealOk.status === 200 && revealOk.payload.path === join(projectDir, 'session-foreign'), JSON.stringify(revealOk.payload))
const call0 = revealSpawn.calls[0]
const launchTarget = Array.isArray(call0.args) ? call0.args[0] : ''
check('launches explorer.exe once', revealSpawn.calls.length === 1 && call0.command === 'explorer.exe', JSON.stringify(revealSpawn.calls))
check('target is an encoded file URI, not a bare path',
  call0.args?.length === 1 && launchTarget.startsWith('file:///') && launchTarget.includes('session-foreign'),
  JSON.stringify(call0.args))
check('Windows targets keep the drive root',
  process.platform !== 'win32' || /^file:\/\/\/[A-Za-z]:\//.test(launchTarget), launchTarget)
check('no %2C/%3D-unsafe characters survive', !/[=]/.test(call0.args[0]))
check('launcher stays visible (windowsHide must not hide Explorer)',
  call0.options.windowsHide === false && call0.options.windowsHide !== true, JSON.stringify(call0.options))

const delegated = makeSpawn({ code: 1 })
const delegatedCtx = makeContext({ paths, agents, reject: undefined, spawnImpl: delegated.impl })
const delegatedResult = await call(delegatedCtx.routes.get('/session-delete/reveal'), { body: { sessionId: 'foreign' } })
check('Explorer exit 1 counts as a delegated handoff', delegatedResult.status === 200, JSON.stringify(delegatedResult.payload))

const failed = makeSpawn({ code: 2 })
const failedCtx = makeContext({ paths, agents, reject: undefined, spawnImpl: failed.impl })
const failedResult = await call(failedCtx.routes.get('/session-delete/reveal'), { body: { sessionId: 'foreign' } })
check('a failed launch is reported, not hidden', failedResult.status === 500 && failedResult.payload.reason === 'open-failed', JSON.stringify(failedResult.payload))

const missingSpawn = makeSpawn({ fail: true })
const missingCtx = makeContext({ paths, agents, reject: undefined, spawnImpl: missingSpawn.impl })
const noLauncher = await call(missingCtx.routes.get('/session-delete/reveal'), { body: { sessionId: 'foreign' } })
check('a missing launcher is reported as open-failed', noLauncher.status === 500 && noLauncher.payload.reason === 'open-failed', JSON.stringify(noLauncher.payload))

check('unknown session answers 409 not-stored', (await call(reveal, { body: { sessionId: 'nope' } })).payload.reason === 'not-stored')

console.log('\ntrust fence')
const fenced = makeContext({ paths: new Map(), agents: new Map(), reject: 403, spawnImpl: makeSpawn().impl })
const fencedRes = makeResponse()
await fenced.routes.get('/session-delete/reveal')(makeRequest('POST', { sessionId: 'x' }), fencedRes)
check('rejected caller answered 403 before any work', fencedRes.statusCode === 403)

await rm(root, { recursive: true, force: true })
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
