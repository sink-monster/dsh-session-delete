# dsh-session-delete

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

From a local checkout, through the Plugins page (**Add plugin** → the package directory), or
from git:

```sh
dsh plugin add github:sink-monster/dsh-session-delete
```

After publishing to npm:

```sh
dsh plugin add dsh-session-delete
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

`market/index.json` is a [format 1 plugin market index](../../) entry that lists this bundle
for DSH's Discover tab; `test/verify-index.mjs` validates it with the validator shipped in
DSH (it needs a DSH installation, so CI runs the other two suites only).

Both behaviour suites run in CI on Node 20 and 22 (`.github/workflows/check.yml`).

## 中文说明

在左侧会话列表的右键菜单里增加两项：**打开会话存储路径**（在本机文件管理器中打开该会话自己的日志目录，
并提示绝对路径）和 **删除会话 → 确认删除（不可恢复）**（删除该会话的磁盘存储目录，侧边栏立即移除该行；
会话仍在运行时拒绝删除，标签占用日志时会提示先关闭标签）。删除是永久操作，没有回收站。

## License

MIT.
