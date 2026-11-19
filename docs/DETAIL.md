# Session storage tools

Adds two rows to every Session context menu in the left sidebar — the same menu that
right-clicking a Session row or opening its `…` button shows.

## Open session storage location

Opens the Session's own storage directory in the desktop file manager and reports the
absolute path in a toast. The path comes from the Session persistence backend, so it is
the real on-disk location of that Session's log:

```
<DSH home>/sessions/<--recorded-cwd-->--/session-<id>/
```

A Session that has never been written to disk (a brand-new blank conversation) has no
directory yet; the action then reports that there is nothing on disk instead of opening
a wrong folder.

## Delete session

Deletes the Session permanently, after a second confirmation step
(`Delete session › Delete permanently`).

Deletion removes the Session's storage directory from disk and drops its row from the
sidebar immediately, without a page reload. The Session search index reconciles itself
against the persistence backend, so a deleted Session stops appearing in search results
as well.

The action is refused only while the Session has a **turn in progress**. A Session that
is merely still open — the state left behind after switching to another conversation —
is deletable, and its row disappears at once. If another handle still holds the log open,
the action reports that the session's tab is in use and asks for it to be closed; nothing
is reported as deleted while files remain.

Only a directory named `session-*` that contains nothing but Session log files
(`session.v4.jsonl.zstd`, its format peers, and the POSIX `session.lock`) is ever removed,
so a mis-resolved path cannot take unrelated data with it.

## Limitations

- Deletion is permanent; there is no trash and no undo.
- Workspace registry entries that could not be pruned immediately are dropped on the
  registry's next mutation.
- Opening the directory needs a desktop file manager on an interactive Host session. On a
  headless Host, or a Windows service session, the action reports the failure instead of
  claiming success.
