# Agent Note: session-send 路由（向既有会话的 queue-only 投递）

Status: implemented

## Problem

程序化派发能创建会话并排入首条提示词，但没有任何通道能对**已在运行**的会话投递消息。跨会话投递——一个会话的产出恰好是另一个会话需要的输入——此前只能靠在 Web 输入框人工打字，或走单条 CDP 注入（布局一变即碎，且无法批量）。调用方需要把输入框的「发送」变成针对既有 sessionId 的普通 REST 调用。

## Decision

- **`POST /api/session-send`**（同包、顶层路径）接收 `{ sessionId, prompt }`，以铸造的 `session-send-<uuid>` requestId 调用 Host 会话控制器的 `prompt`，投递语义固定为 queue：会话忙时消息在当前 turn 跑完后作为独立新 turn 消费，空闲会话直接开 turn（Host 侧 `agent.followup` 语义，2026-10-26 读码确认）。
- **queue-only 是物理属性而非约定**：请求体不暴露投递 mode 字段，`parseSessionSendBody` 丢弃任何调用方自带的 `mode`，路由代码不出现其他投递语义。对进行中 turn 的 steer 被明确排除在范围外。
- **范围止于投递**：无路由/广播/订阅/优先级/已读回执/会话发现寻址（sessionId 由调用方自带）；send 不创建会话、不记录快账绑定——send 不是派发，没有任务占用需要记账。
- **围栏与错误面镜像派发路由**：仅回环（`isLoopbackRequest`）、仅 POST、有界 JSON 请求体（`readBoundedJson`，1 MiB）、prompt 上限 900,000 字符（与派发解析共享 `PROMPT_MAX_CHARS` 常量）、错误映射复用 `statusForError`——`session/*` 类 Host 拒绝（会话不存在、已归档或已 dispose）回 400 并直读错误文本。
- **健康探针复用**：包内既有 `GET /api/session-dispatch/health` 已探活本包，send 路由不新增第二个探针。
- **文件组织沿同族惯例**：send 工厂（`makeSessionSendRoute`）落在 `src/host/routes.ts`，与派发、健康、绑定工厂同居；`src/index.ts` 一并注册；派发聚合 `makeDispatchRoutes` 的路由清单保持不变。

## Alternatives considered

- 在请求体上暴露 Host 的投递 mode（queue/steer）：否决——steer 改写进行中的 turn，是与投递不同且更危险的能力；2026-10-26 裁定本路由仅限 queue 语义，暴露 mode 字段会把「物理封死」降格为口头约定。
- 独立建 `dsh-session-send` 包：否决——回环围栏、有界 JSON 助手、错误映射、会话服务面全都已在本包；为两个小工厂单开一包只会复制一份生成的共享 host 模块副本。
- 投递前先单独查询目标会话是否存在：否决——Host 的 `prompt` 本就先解析 agent，不存在即抛 `session/not-found`；预检与 dispose 竞态，还为同一判定增加第二条代码路径。

## Consequences

- 寻址归调用方：sessionId 过期或未知回 400，会话发现/列表仍是调用方的职责（session-archive 的 inventory 端点承担该需求）。
- 指针纪律——长正文先落 git，send 只带路径 + 一句指令——写在 README 与 m-note，不进代码；900,000 字符上限是天花板，不是预期用法。
- 激活需要重启 Host（或依赖 live patch reload）：链接 bundle 重载后路由才应答。重启核验配方 = `GET /api/session-dispatch/health` + 向沙箱会话真发一条 send。

## Testing

`tests/routes.spec.ts` 新增 session-send 套件：快乐路径（requestId 前缀、sessionId 透传、`mode: 'queue'` 恒定、文本内容）、queue-only 封死（调用方自带 `mode` 永不抵达 prompt 调用）、请求体校验（非对象、缺/空 sessionId、缺/空 prompt、超长 prompt）、非法 JSON、非 POST 回 405、非回环回 403、`session/not-found` 映射 400 且带 Host 错误文本、未映射拒绝映射 500。62 例全绿，另加 `pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`pnpm i18n:check`。
