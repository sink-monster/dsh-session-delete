/**
 * Host half of dsh-session-delete.
 *
 * Two routes on the composition's `webServer` serve the Session context-menu
 * actions the browser half registers:
 *
 * - `POST /session-delete/reveal` resolves the Session's own on-disk storage
 *   directory through `sessionPersistence.stat()` and opens it in the desktop
 *   file manager.
 * - `POST /session-delete/delete` removes that directory after proving no turn
 *   is running for the Session, prunes stale Workspace registry references,
 *   and broadcasts `api-session/removed` so the sidebar drops the row at once.
 *
 * Security has one home, here: every route asks the composition's `connection`
 * service for a rejection first (`requestRejection`), whose Host/Origin fence
 * defeats DNS rebinding and cross-site calls and whose browser authentication
 * gates every caller before any path is resolved or removed. On top of that
 * fence each route validates its body at the wire: an `application/json` media
 * type, an 8 KiB ceiling, and one non-empty string `sessionId`.
 *
 * Deletion is deliberately narrow: the target directory must be named
 * `session-*` and hold nothing but Session log files, so a mis-resolved path
 * can never take unrelated data with it. A Session with a running turn is
 * refused; a Session that is merely still open (its Agent idle) is deletable,
 * and a log file another handle keeps locked reports `busy` instead of a
 * generic failure.
 */

import { spawn } from 'node:child_process'
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Cordis function-plugin name. */
export const name = 'session-delete'

/** Required Host services: the route carrier, the trust fence, storage facts, and live Agents. */
export const inject = ['webServer', 'connection', 'sessionPersistence', 'agents']

/** Absolute route path: open the Session's storage directory on the Host desktop. */
const REVEAL_PATH = '/session-delete/reveal'

/** Absolute route path: remove the Session's storage directory. */
const DELETE_PATH = '/session-delete/delete'

/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 8 * 1024

/** A Session-owned log file: `session.v4.jsonl.zstd`, `session.jsonl`, and peers. */
const SESSION_FILE = /^session(\.[A-Za-z0-9._-]+)?\.jsonl(\.zstd)?$/

/** The POSIX write-lease file the persistence backend leaves beside the log. */
const LEASE_FILE = 'session.lock'

/** Every Session-owned directory is named `session-<id>` by the persistence backend. */
const SESSION_DIRECTORY_PREFIX = 'session-'

/**
 * How long a launcher may stay alive before the handoff counts as accepted.
 * Explorer delegates to the already-running desktop process and exits within
 * milliseconds; a launcher that outlives this window has done its job.
 */
const LAUNCH_WATCH_MS = 3000

/** Whether one directory entry belongs to the Session's own storage. */
function isSessionEntry(entry) {
  return entry.isFile() && (entry.name === LEASE_FILE || SESSION_FILE.test(entry.name))
}

/** Whether a filesystem failure means another handle still holds the file. */
function isBusyError(error) {
  const code = error?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

/**
 * Encode one Windows path the way Explorer expects it as a single argv element.
 *
 * Explorer receives a file URI, not a filesystem path, and treats `,` and `=`
 * as parts of its own `/select,` syntax, so both stay percent-encoded. Escapes
 * of non-ASCII characters are decoded back to their bytes first, which keeps
 * non-Latin directory names readable to the shell that receives them.
 * @param path - absolute Windows path.
 * @returns the encoded target Explorer accepts.
 */
function explorerTarget(path) {
  const href = pathToFileURL(path, { windows: true }).href
  try {
    return href
      .replace(/(?:%[89A-F][0-9A-F])+/gi, escaped => decodeURIComponent(escaped))
      .replaceAll(',', '%2C')
      .replaceAll('=', '%3D')
  } catch {
    // A malformed escape sequence keeps the fully percent-encoded form, which
    // Explorer still resolves.
    return href
  }
}

/**
 * Build the platform launcher for one directory.
 * @param spawnImpl - child_process.spawn-compatible launcher (injectable for tests).
 * @param platform - Node platform id (injectable for tests).
 * @returns a function that resolves after the launcher accepted the handoff.
 */
function makeOpenDirectory(spawnImpl, platform) {
  return function openDirectory(directory) {
    const [command, args, delegatedExitAccepted] = platform === 'win32'
      // SW_HIDE would hide Explorer's folder window, not just a console window,
      // so the launcher must stay visible. Explorer exits 1 after handing the
      // request to the already-running desktop process: that is success.
      ? ['explorer.exe', [explorerTarget(directory)], true]
      : platform === 'darwin'
        ? ['open', [directory], false]
        : ['xdg-open', [directory], false]

    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      let stderr = ''
      const settle = (failure) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (failure === null) resolve()
        else reject(failure)
      }
      let child
      try {
        child = spawnImpl(command, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: false,
        })
      } catch (error) {
        settle(error)
        return
      }
      // A launcher still alive after the watch window counts as a handoff; this
      // bounds how long a success waits, never how long the window may live.
      timer = setTimeout(() => settle(null), LAUNCH_WATCH_MS)
      child.stderr?.setEncoding?.('utf8')
      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < 2000) stderr += String(chunk)
      })
      child.once('error', error => settle(error))
      child.once('close', (code) => {
        if (code === 0) return settle(null)
        if (delegatedExitAccepted && code === 1) return settle(null)
        const reason = stderr.trim() === ''
          ? `${command} exited with code ${String(code)}`
          : `${command} exited with code ${String(code)}: ${stderr.trim()}`
        settle(new Error(reason))
      })
    })
  }
}

/** JSON response (no-store: paths and deletions are live facts). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res) {
  res.statusCode = 405
  res.setHeader('allow', 'POST')
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one request body at the wire.
 * @param req - the incoming request.
 * @returns the Session id, or null when the body is unusable.
 */
async function readSessionId(req) {
  const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') return null
  const text = await readBoundedBody(req)
  if (text === null) return null
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON body is exactly the null case.
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { sessionId } = body
  if (typeof sessionId !== 'string') return null
  const trimmed = sessionId.trim()
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null
}

/**
 * Register the reveal and delete routes behind the connection trust fence.
 * @param ctx - Host context.
 * @param config - optional `internals` overrides for tests (`spawn`, `platform`).
 */
export function apply(ctx, config = {}) {
  const internals = config?.internals ?? {}
  const openDirectory = makeOpenDirectory(internals.spawn ?? spawn, internals.platform ?? process.platform)
  const removeFile = internals.rm ?? rm

  /**
   * Resolve one Session's own storage directory.
   * @param sessionId - Session identity.
   * @returns the directory and log file, or null when nothing is stored yet.
   */
  const storageOf = async (sessionId) => {
    const snapshot = await ctx.sessionPersistence.stat(sessionId)
    const location = snapshot?.location
    if (!location || typeof location.path !== 'string' || location.path.length === 0) return null
    return { directory: dirname(location.path), file: location.path }
  }

  /**
   * Answer an untrusted/unauthenticated request.
   * @returns true when the request was already rejected.
   */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** Shared admission: trust fence, method, and one validated Session id. */
  const admit = async (req, res) => {
    if (rejected(req, res)) return null
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res)
      return null
    }
    const sessionId = await readSessionId(req)
    if (sessionId === null) {
      sendJson(res, 400, { reason: 'bad-request' })
      return null
    }
    return sessionId
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REVEAL_PATH,
    handler: async (req, res) => {
      const sessionId = await admit(req, res)
      if (sessionId === null) return
      try {
        const storage = await storageOf(sessionId)
        if (storage === null) {
          sendJson(res, 409, { reason: 'not-stored' })
          return
        }
        const directoryStat = await stat(storage.directory).catch(() => null)
        if (directoryStat === null || !directoryStat.isDirectory()) {
          sendJson(res, 409, { reason: 'not-stored' })
          return
        }
        await openDirectory(storage.directory)
        sendJson(res, 200, { ok: true, path: storage.directory, file: storage.file })
      } catch (error) {
        console.warn('[session-delete] reveal failed:', error)
        sendJson(res, 500, { reason: 'open-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'session-delete: reveal route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DELETE_PATH,
    handler: async (req, res) => {
      const sessionId = await admit(req, res)
      if (sessionId === null) return
      try {
        // Only a turn in progress holds the log against removal. A Session that
        // is still open with an idle Agent — the state a sidebar switch leaves
        // behind — stays deletable.
        if (ctx.agents.get(sessionId)?.status === 'running') {
          sendJson(res, 409, { reason: 'running' })
          return
        }
        const storage = await storageOf(sessionId)
        if (storage === null) {
          sendJson(res, 409, { reason: 'not-stored' })
          return
        }
        const directory = storage.directory
        if (!basename(directory).startsWith(SESSION_DIRECTORY_PREFIX)) {
          sendJson(res, 409, { reason: 'unexpected' })
          return
        }
        const entries = await readdir(directory, { withFileTypes: true })
        if (entries.some(entry => !isSessionEntry(entry))) {
          sendJson(res, 409, { reason: 'unexpected' })
          return
        }
        let removed = 0
        for (const entry of entries) {
          try {
            await removeFile(join(directory, entry.name), { force: true })
            removed += 1
          } catch (error) {
            if (isBusyError(error)) {
              // Partially removed storage is reported as-is: the caller retries
              // after closing whatever still holds the log.
              sendJson(res, 409, { reason: 'busy', removedFiles: removed })
              return
            }
            throw error
          }
        }
        await rmdir(directory).catch(() => {})
        // Only succeeds while the per-directory project folder is empty.
        await rmdir(dirname(directory)).catch(() => {})
        // Registry references to a Session that no longer exists are pruned on
        // their next mutation; dropping them here keeps that state tidy. Both
        // calls are tolerant: a missing entry is not an error.
        const registry = ctx.get('workspaceRegistry')
        if (registry !== undefined) {
          try {
            await registry.unarchiveSession(sessionId)
          } catch (error) {
            console.warn('[session-delete] unarchive pruned failed:', error)
          }
          try {
            await registry.unpinSession(sessionId)
          } catch (error) {
            console.warn('[session-delete] unpin pruned failed:', error)
          }
        }
        // The Client list only drops a row on `api-session/removed`; emitting it
        // here makes the sidebar follow the disk without a reload.
        try {
          ctx.emit('api-session/removed', sessionId)
        } catch (error) {
          console.warn('[session-delete] removed broadcast failed:', error)
        }
        sendJson(res, 200, { ok: true, path: directory, removedFiles: removed })
      } catch (error) {
        console.warn('[session-delete] delete failed:', error)
        sendJson(res, 500, { reason: 'delete-failed' })
      }
    },
  }), 'session-delete: delete route')
}
