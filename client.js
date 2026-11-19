/**
 * Browser half of dsh-session-delete.
 *
 * Registers one Session context-menu contribution with the shared
 * `ctx.contextMenus` registry — the shipped extension point for new Session
 * actions — plus the two glyphs those rows show. Every Host call travels over
 * the plugin's own same-origin routes (see `index.js`); the route spellings are
 * the document-relative form the browser addresses, exactly like the shipped
 * open-in-app client.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'session-delete';

    // Route spellings duplicated from index.js (Host half). Keep both in sync.
    const REVEAL_ROUTE = 'session-delete/reveal';
    const DELETE_ROUTE = 'session-delete/delete';

    const zh = {
      reveal: '打开会话存储路径',
      revealFailed: '无法打开会话存储路径',
      revealed: '已打开会话存储路径：{path}',
      delete: '删除会话',
      deleteConfirm: '确认删除（不可恢复）',
      deleteFailed: '删除失败，请稍后重试',
      deleted: '已删除会话「{title}」及其存储文件',
      refusedRunning: '会话正在运行（有进行中的回合），先中止或等它结束再删除',
      refusedBusy: '会话日志仍被占用，先关闭该会话的标签再试一次',
      notStored: '该会话尚未写入磁盘，没有可操作的存储路径',
    };

    const en = {
      reveal: 'Open session storage location',
      revealFailed: 'Could not open the session storage location',
      revealed: 'Opened the session storage location: {path}',
      delete: 'Delete session',
      deleteConfirm: 'Delete permanently',
      deleteFailed: 'Delete failed, try again later',
      deleted: 'Deleted “{title}” and its stored files',
      refusedRunning: 'This session has a turn in progress; stop it or wait before deleting',
      refusedBusy: 'This session’s log is still in use; close its tab and try again',
      notStored: 'This session has nothing on disk yet',
    };

    /** 16px stroke glyph base, inheriting the menu's text color. */
    function glyph(children) {
      return function Glyph() {
        return h('svg', {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        }, ...children);
      };
    }

    const FolderIcon = glyph([
      h('path', {
        key: 'body',
        d: 'M2.25 5.1c0-.6.5-1.1 1.1-1.1h2.3l1.2 1.5h4.9c.6 0 1.1.5 1.1 1.1v5.2c0 .6-.5 1.1-1.1 1.1H3.35c-.6 0-1.1-.5-1.1-1.1z',
      }),
    ]);

    const TrashIcon = glyph([
      h('path', { key: 'lid', d: 'M2.8 4.6h10.4' }),
      h('path', { key: 'handle', d: 'M6.3 4.5V3.3c0-.4.3-.7.7-.7h2c.4 0 .7.3.7.7v1.2' }),
      h('path', { key: 'body', d: 'M4.3 4.7l.5 7.6c0 .7.6 1.3 1.3 1.3h3.8c.7 0 1.3-.6 1.3-1.3l.5-7.6' }),
    ]);

    /**
     * POST one small JSON body to a Host route.
     * @param route - document-relative route spelling.
     * @param body - request payload.
     * @returns the parsed JSON reply.
     */
    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // A non-JSON reply carries no reason; the status stands in for it.
        payload = {};
      }
      if (!response.ok) {
        const error = new Error(typeof payload.reason === 'string' ? payload.reason : `HTTP ${response.status}`);
        error.reason = typeof payload.reason === 'string' ? payload.reason : undefined;
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    return {
      inject: ['contextMenus', 'sessions', 'locale', 'slots'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-delete.folder' }, FolderIcon);
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'session-delete.trash' }, TrashIcon);
        }), 'session-delete: menu glyphs');

        /**
         * Run one menu action and turn refusals the user can act on into text.
         * @param route - Host route to call.
         * @param sessionId - captured Session.
         * @param onSuccess - receives the Host reply.
         */
        const call = async (route, sessionId, onSuccess) => {
          try {
            onSuccess(await post(route, { sessionId }));
          } catch (error) {
            // Each refusal names the one action that fixes it; anything else
            // surfaces through the action's own failureLabel.
            if (error.reason === 'running') {
              ctx.contextMenus.notify(t('refusedRunning'), false);
              return;
            }
            if (error.reason === 'busy') {
              ctx.contextMenus.notify(t('refusedBusy'), false);
              return;
            }
            if (error.reason === 'not-stored') {
              ctx.contextMenus.notify(t('notStored'), false);
              return;
            }
            throw error;
          }
        };

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-delete.session',
          target: 'session',
          order: 900,
          observe: () => [ctx.sessions.list, ctx.locale],
          resolve: ({ sessionId }) => {
            const row = ctx.sessions.list.getSnapshot().byId[sessionId];
            if (row === undefined || row === null) return [];
            return [
              {
                id: 'reveal',
                label: t('reveal'),
                icon: { key: 'session-delete.folder' },
                separatorBefore: true,
                failureLabel: t('revealFailed'),
                run: () => call(REVEAL_ROUTE, sessionId, (reply) => {
                  ctx.contextMenus.notify(t('revealed', { path: reply.path }), true);
                }),
              },
              {
                id: 'delete',
                label: t('delete'),
                icon: { key: 'session-delete.trash' },
                danger: true,
                failureLabel: t('deleteFailed'),
                children: [{
                  id: 'confirm',
                  label: t('deleteConfirm'),
                  danger: true,
                  failureLabel: t('deleteFailed'),
                  run: () => call(DELETE_ROUTE, sessionId, () => {
                    ctx.contextMenus.notify(t('deleted', { title: row.displayTitle }), true);
                  }),
                }],
              },
            ];
          },
        }), 'session-delete: session menu');
      },
    };
  },
});
