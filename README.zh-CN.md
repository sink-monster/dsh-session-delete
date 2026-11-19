# dsh-session-delete

[English](README.md) | 中文

在 DeepSeek Harness 左侧会话列表的右键菜单（会话行的右键，或它的 `…` 菜单）里增加两项。

| 操作 | 作用 |
| --- | --- |
| **打开会话存储路径** | 在本机文件管理器中打开该会话自己的存储目录，并提示绝对路径。 |
| **删除会话** → **确认删除（不可恢复）** | 从磁盘删除该会话的存储目录，侧边栏立即移除该行。 |

## 环境要求

- DeepSeek Harness `>=0.2.2-rc.5 <0.3.0`。
- 打开动作需要一个带文件管理器的桌面宿主（Windows 资源管理器 / macOS Finder / `xdg-open`）。

## 安装

用 Plugins 页的 **添加插件**（选择包目录），或从 Git 安装：

```sh
dsh plugin add github:sink-monster/dsh-session-delete
```

发布到 npm 之后：

```sh
dsh plugin add dsh-session-delete
```

bundle 会插入一个宿主行（`session-delete`）和一个 Web 客户端模块。宿主半在组合的 connection 信任栅栏后面
提供两条同源路由（`/session-delete/reveal`、`/session-delete/delete`），客户端半通过 `ctx.contextMenus`
注册菜单项。

## 会碰到什么

打开动作通过宿主的会话持久化服务解析该会话的目录，所以指向的一定是真实的日志目录：

```
<DSH home>/sessions/<--recorded-cwd-->--/session-<id>/
```

删除动作只删这一个目录，且只在目录名以 `session-` 开头、内容全是会话日志文件时才动手；随后清理
Workspace 注册表里的残留引用，并广播移除事件，让侧边栏无需刷新就跟上。

会话有**进行中的回合**时会拒绝删除；只是"还开着但空闲"（切换对话后留下的状态）可以删除；日志被别的句柄
占用时，会明确提示"先关闭该会话的标签"，而不是笼统报错。

## 限制

- 删除是永久操作：没有回收站，不能撤销。
- 打开动作需要交互式桌面会话；无头宿主或 Windows 服务会话会如实报错，而不是假装成功。
- 搜索索引会与持久化后端对账，因此已删除的会话会在下一次对账时从搜索中消失。

## 开发

无运行时依赖，只用 Node 内建模块。

```sh
npm run check   # 对两半分别 node --check
npm test        # 宿主 + 客户端行为测试，以及市场索引格式校验
```

`test/reveal-live.mjs` 会真的打开一个文件管理器窗口以确认交接成功，请在桌面会话里手动运行
（`node test/reveal-live.mjs`）。

`market/index.json` 是格式 1 的插件市场索引条目，用于 DSH 的 Discover 标签页；`test/verify-index.mjs`
用 DSH 随包的校验器验证它（需要本机装有 DSH，因此 CI 只跑另外两套）。

两套行为测试在 CI 里以 Node 20 和 22 运行（`.github/workflows/check.yml`）。

## 许可证

以 [MIT 许可证](LICENSE) 发布。
