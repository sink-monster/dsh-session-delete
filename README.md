# dsh-session-delete

English | [中文](README.zh-CN.md)

Adds two rows to every Session context menu in the DeepSeek Harness sidebar — the menu a
right-click on a Session row, or its `…` button, opens.

| Action | What it does |
| --- | --- |
| **Open session storage location** | Opens the Session's own storage directory in the desktop file manager and reports the absolute path. |
| **Delete session** → **Delete permanently** | Removes the Session's storage directory from disk and drops its row from the sidebar immediately. |

## Requirements

- DeepSeek Harness `>=0.2.2-rc.5 <0.3.0`.
- A desktop Host with a file manager for the open action (Windows Explorer, macOS Finder, or `xdg-open`).

## Install

**From the Plugins page (recommended).** Plugins → **Add plugin**, then point it at this
package: a local checkout directory, or the Git address

```
github:sink-monster/dsh-session-delete
```

**From a downloaded archive.** Grab the ZIP from the
[releases page](https://github.com/sink-monster/dsh-session-delete/releases), unpack it, then
Plugins → **Add plugin** → the unpacked directory.

**From a shell.** The CLI forwards its arguments to pnpm inside the profile directory:

```sh
dsh plugin --profile desktop add github:sink-monster/dsh-session-delete
```

`desktop` is the profile name (`web` for `dsh web`, `tui` for the TUI); use whichever profile
should get the plugin. The command installs the dependency — the profile also keeps an
explicit bundle list, so confirm the bundle is enabled in Plugins afterwards.

**From an npm release** (once published):

```sh
dsh plugin --profile desktop add dsh-session-delete
```

The bundle inserts one Host row (`session-delete`) and one Web client module. The Host half
serves two same-origin routes (`/session-delete/reveal`, `/session-delete/delete`) behind the
composition's connection trust fence; the client half registers the menu rows through
`ctx.contextMenus`.

## What it touches

The open action resolves the Session's directory through the Host's Session persistence
service, so it always points at the real log directory:

```
<DSH home>/sessions/<--recorded-cwd-->--/session-<id>/
```

The delete action removes exactly that directory — and only when its name starts with
`session-` and it contains nothing but Session log files — then clears stale Workspace
registry references and announces the removal so the sidebar follows without a reload.
It refuses while the Session has a **turn in progress**; a Session that is merely still
open (the state left behind after switching conversations) is deletable, and a log another
handle keeps locked reports that its tab is in use instead of failing generically.

## Limitations

- Deletion is permanent: no trash, no undo.
- The open action needs an interactive desktop session; a headless Host, or a Windows
  service session, reports a failure instead of claiming success.
- Search indexes reconcile themselves against the persistence backend, so a deleted
  Session disappears from search on the next reconcile.

## Development

No runtime dependencies; only Node built-ins.

```sh
npm run check   # node --check on both halves
npm test        # host + client behaviour tests and the market-index format check
```

`test/reveal-live.mjs` additionally opens a real file-manager window to prove the handoff;
run it manually on a desktop session (`node test/reveal-live.mjs`).

`market/index.json` is a format 1 plugin market index entry for this bundle: host it anywhere
over HTTPS (GitHub Pages works) and add that URL under Plugins → Experimental plugins →
Custom plugin indexes, and the bundle appears in Discover. Keep `icon.svg` beside it — the
entry's `icon` resolves against the index URL. `test/verify-index.mjs` validates the file
with the validator shipped in DSH (it needs a DSH installation, so CI runs the other two
suites only).

Both behaviour suites run in CI on Node 20 and 22 (`.github/workflows/check.yml`).

## License

Released under the [MIT License](LICENSE).
