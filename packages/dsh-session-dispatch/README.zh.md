# dsh-session-dispatch

[English](README.md) | 中文

DSH Web 的纯 REST 会话派发：`POST /api/session-dispatch` 通过 Host 自身的会话服务
创建钉住指定工作区的会话并排入首条提示词，响应 `{ ok: true, sessionId }`。仅
Host 侧——本包不声明 `dsh.client` 面，浏览器花名册中不出现任何条目。

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

响应：`200 { ok, sessionId }`、`400` 请求体非法或 Host 命令被拒、`403` 非回
环、`404` 工作区不存在、`405` 方法错误。

### `GET /api/session-dispatch/health`

重启核验用存活探针：`200 { ok: true, service: "dsh-session-dispatch" }`。

## 结构

- `src/index.ts`——插件入口：注入 `webServer`、`sessionController`、
  `workspaceRegistry`，注册两条路由。
- `src/host/routes.ts`——请求体校验与两个路由工厂。
- `src/host/loopback.ts`、`src/host/http.ts`、`src/mount-once.ts`——仓内共享
  host 模块的生成副本（改 `shared/host/*` 后运行 `node
  scripts/sync-shared.mjs`）。

## 许可证

Apache-2.0
