/**
 * Behavioural harness for the Browser half of dsh-session-delete.
 * Loads the real client bundle through a fake module loader and asserts the
 * registered menu contribution and both action callbacks.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const failures = []
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(name)
  }
}

// --- fake module loader + React -------------------------------------------
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec },
  },
}
const createElement = (type, props, ...children) => ({ type, props, children })
await import('../client.js')

check('module registers under the package id', loaded?.id === 'dsh-session-delete', loaded?.id)
const plugin = loaded.factory(() => ({ createElement }))
check('factory returns services + apply', Array.isArray(plugin.inject) && typeof plugin.apply === 'function')
check('declares contextMenus / sessions / locale / slots',
  ['contextMenus', 'sessions', 'locale', 'slots'].every(name => plugin.inject.includes(name)),
  JSON.stringify(plugin.inject))

// --- fake client context ---------------------------------------------------
let activeLocale = 'zh'
const dictionaries = {}
const contributions = []
const glyphs = []
const notices = []
let listRows = { s1: { id: 's1', displayTitle: '示例会话', running: false } }

const ctx = {
  effect(fn) { return fn() },
  locale: {
    register(ns, dicts) {
      dictionaries[ns] = { ...(dictionaries[ns] ?? {}), ...dicts }
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const template = dictionaries[ns]?.[activeLocale]?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  },
  slots: {
    inject(key, callback) {
      if (key !== 'contextMenu.icon') return () => {}
      for (const registration of callback()) glyphs.push(registration)
      return () => {}
    },
    register(registration, component) {
      return { registration, component }
    },
  },
  contextMenus: {
    register(contribution) { contributions.push(contribution); return () => {} },
    notify(text, success) { notices.push({ text, success }) },
  },
  sessions: {
    list: { getSnapshot: () => ({ byId: listRows }), subscribe: () => () => {} },
  },
}

plugin.apply(ctx)

check('one Session menu contribution registered', contributions.length === 1)
const contribution = contributions[0]
check('targets the session menu', contribution?.target === 'session', contribution?.target)
check('sits after open-in-app ordering', contribution?.order === 900, String(contribution?.order))
check('two glyphs registered', glyphs.length === 2 && glyphs.every(g => g?.registration?.name === 'contextMenu.icon'),
  JSON.stringify(glyphs.map(g => g?.registration?.key)))
check('glyphs render an svg', glyphs.every(g => g.component().type === 'svg'))

// --- resolve: zh ----------------------------------------------------------
const actions = contribution.resolve({ sessionId: 's1', displayTitle: '示例会话' }, new AbortController().signal)
check('two actions offered', actions.length === 2, JSON.stringify(actions.map(a => a.id)))
const [revealAction, deleteAction] = actions
check('reveal label (zh)', revealAction.label === '打开会话存储路径', revealAction.label)
check('reveal icon key', revealAction.icon?.key === 'session-delete.folder', JSON.stringify(revealAction.icon))
check('reveal failure label (zh)', revealAction.failureLabel === '无法打开会话存储路径', revealAction.failureLabel)
check('delete label (zh)', deleteAction.label === '删除会话', deleteAction.label)
check('delete is danger / not disabled while idle', deleteAction.danger === true && deleteAction.disabled !== true,
  JSON.stringify({ danger: deleteAction.danger, disabled: deleteAction.disabled }))
check('delete needs a confirmation step', deleteAction.children?.length === 1 && deleteAction.children[0].label === '确认删除（不可恢复）',
  JSON.stringify(deleteAction.children?.map(c => c.label)))

// running session stays clickable: the Host explains the refusal
listRows = { s1: { id: 's1', displayTitle: '示例会话', running: true } }
const busy = contribution.resolve({ sessionId: 's1' }, new AbortController().signal)
check('running session keeps the row clickable', busy[1].disabled !== true && busy[1].children[0].disabled !== true,
  JSON.stringify({ parent: busy[1].disabled, child: busy[1].children[0].disabled }))
listRows = { s1: { id: 's1', displayTitle: '示例会话', running: false } }

// unknown row offers nothing
check('unknown session offers no action',
  contribution.resolve({ sessionId: 'ghost' }, new AbortController().signal).length === 0)

// --- resolve: en ----------------------------------------------------------
activeLocale = 'en'
const english = contribution.resolve({ sessionId: 's1' }, new AbortController().signal)
check('reveal label (en)', english[0].label === 'Open session storage location', english[0].label)
check('delete label (en)', english[1].label === 'Delete session', english[1].label)
activeLocale = 'zh'

// --- run: success paths ---------------------------------------------------
const calls = []
globalThis.fetch = async (route, init) => {
  calls.push({ route, init })
  return {
    ok: true,
    status: 200,
    async json() { return { ok: true, path: 'C:\\Users\\Administrator\\.dsh\\sessions\\--proj--\\session-s1' } },
  }
}

await revealAction.run()
check('reveal posts the document-relative route with the session id',
  calls[0]?.route === 'session-delete/reveal' && JSON.parse(calls[0].init.body).sessionId === 's1',
  JSON.stringify(calls[0]))
check('reveal notifies the opened path',
  notices.at(-1)?.success === true && notices.at(-1)?.text.includes('C:\\Users\\Administrator'),
  JSON.stringify(notices.at(-1)))

await deleteAction.children[0].run()
check('delete posts the document-relative route',
  calls.at(-1)?.route === 'session-delete/delete' && JSON.parse(calls.at(-1).init.body).sessionId === 's1',
  JSON.stringify(calls.at(-1)))
check('delete notifies the deleted title',
  notices.at(-1)?.success === true && notices.at(-1)?.text.includes('示例会话'),
  JSON.stringify(notices.at(-1)))

// --- run: refusals --------------------------------------------------------
globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  async json() { return { reason: 'running' } },
})
notices.length = 0
await deleteAction.children[0].run()
check('409 running is explained, not thrown',
  notices.length === 1 && notices[0].text.includes('正在运行') && notices[0].success === false,
  JSON.stringify(notices))

globalThis.fetch = async () => ({ ok: false, status: 409, async json() { return { reason: 'busy' } } })
notices.length = 0
await deleteAction.children[0].run()
check('409 busy is explained, not thrown',
  notices.length === 1 && notices[0].text.includes('占用'),
  JSON.stringify(notices))

globalThis.fetch = async () => ({ ok: false, status: 409, async json() { return { reason: 'not-stored' } } })
notices.length = 0
await revealAction.run()
check('409 not-stored is explained, not thrown',
  notices.length === 1 && notices[0].text.includes('尚未写入磁盘'),
  JSON.stringify(notices))

globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return { reason: 'open-failed' } } })
notices.length = 0
let revealThrew = false
await revealAction.run().catch(() => { revealThrew = true })
check('a failed open rejects so failureLabel shows', revealThrew === true && notices.length === 0)

globalThis.fetch = async () => ({ ok: false, status: 500, async json() { return { reason: 'delete-failed' } } })
notices.length = 0
let threw = false
await deleteAction.children[0].run().catch(() => { threw = true })
check('unexpected failure rejects so failureLabel shows', threw === true)

// --- copy of the host route spellings ------------------------------------
const hostSource = await readFile(join(import.meta.dirname, '..', 'index.js'), 'utf8')
const clientSource = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
check('route spellings match the Host half',
  hostSource.includes("'/session-delete/reveal'") && hostSource.includes("'/session-delete/delete'")
  && clientSource.includes("'session-delete/reveal'") && clientSource.includes("'session-delete/delete'"))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
