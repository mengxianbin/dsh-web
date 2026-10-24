# dsh-session-dispatch

[English](README.md) | 中文

DSH Web 的纯 REST 会话派发：`POST /api/session-dispatch` 通过 Host 自身的会话服务
创建钉住指定工作区的会话并排入首条提示词，响应 `{ ok: true, sessionId }`。派发可
携带不透明的 `taskRef`，在快账（`$DSH_HOME/dispatch-bindings.json`）中持久记录
任务到会话的绑定；该 taskRef 仍有活会话时同样的派发被 `409` 拒绝，
`GET /api/session-dispatch/bindings` 提供带实时活性的账面条目。仅 Host 侧——本包
不声明 `dsh.client` 面，浏览器花名册中不出现任何条目。

## 动机

程序化派发过去要经独立 CDP Chrome 驱动 Web UI（悬停工作区行、DOM 点击「新建会
话」、向输入框注入任务书、点击发送）。该通道每次派发都要拉起一个浏览器，且布局
一变即碎。本插件用一次回环围栏内的 POST 取代它：无浏览器、无 cookie 铸造、无
UI 耦合。

## 安装

本地 link 安装（本包不发布 npm）：

```powershell
dsh plugin --profile <name> add link:<repo>/packages/dsh-session-dispatch
```

单条 bundle 行（`session-dispatch`）挂载 Host 路由。重启 Host（或依赖 live
patch reload）后激活。

## API

所有路由仅回环可达（RFC 5735 127/8、`::1`、IPv4-mapped，加同源标记）；远程
socket 一律 `403`。

### `POST /api/session-dispatch`

请求体（JSON，至多 1 MiB）：

| 字段 | 类型 | 必填 | 含义 |
|------|------|------|------|
| `workspaceId` | string | 是 | 新会话加入的工作区（钉住工作目录） |
| `prompt` | string | 是 | 首条用户消息，与输入框发送同语义排队 |
| `title` | string | 否 | 会话标题，经 rename 命令应用 |
| `mode` | string | 否 | 传给会话创建的 agent 预设 id |
| `permission` | string | 否 | `read-only`、`workspace-write`、`danger-full-access` 三者之一；提示词前用 `/permission` 钉定 |
| `taskRef` | string | 否 | 调用方自选的不透明任务引用（推荐形如 `<板路径>#<条目锚>`）；记录绑定并拦截重派 |

响应：`200 { ok, sessionId }`、`400` 请求体非法或 Host 命令被拒、`403` 非回
环、`404` 工作区不存在、`405` 方法错误、`409 { ok, taskRef, sessionId }`
（该 taskRef 仍有活会话；死绑定——会话已归档或已删除——不拦截）。门到落账
整段按 taskRef 在进程内逐个执行：同一 taskRef 并发双派恰一 `200` 一 `409`；
快账并发追加相互排队、不丢行。不带 `taskRef` 的派发行为与此前完全一致。
绑定写入失败时响应 `200` 但附 `bindingRecorded: false`：会话已活，派发本身
并未失败。

### `GET /api/session-dispatch/health`

重启核验用存活探针：`200 { ok: true, service: "dsh-session-dispatch" }`。

### `GET /api/session-dispatch/bindings`

快账：`200 { ok: true, bindings: [...] }`，每条绑定（`taskRef`、`sessionId`、
`workspaceId`、`title`、`createdAt`）附实时 `alive` 布尔值（该会话在某个工作区
的 `sessionIds` 中且不在 `archivedSessionIds` 中）。快账是运行占用传感器，不是
任务账本——git 板唯一权威。

## 结构

- `src/index.ts`——插件入口：注入 `webServer`、`sessionController`、
  `workspaceRegistry`，注册派发、健康与绑定三条路由。
- `src/host/routes.ts`——请求体校验、`taskRef`/绑定契约与路由工厂。
- `src/host/bindings.ts`——快账：`$DSH_HOME` 下的原子绑定持久化、实时活性查
  询、损坏账本 fail-open 重建。
- `src/host/loopback.ts`、`src/host/http.ts`、`src/dsh-home.ts`、
  `src/mount-once.ts`——仓内共享 host 模块的生成副本（改 `shared/host/*` 后运行
  `node scripts/sync-shared.mjs`）。

## 许可证

Apache-2.0
