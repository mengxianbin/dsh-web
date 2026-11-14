# Agent Note: 任务看板可选的会话复用（Issue #1419）

Status: implemented

## Problem

此前每次执行都会新建一个 DSH 会话，于是高频 cron 任务（例如周期性 review 检查）
每触发一次就多出一个对话。侧边栏很快堆满几乎同名的会话，用户只能手动归档，而
任务自身的 Prompt 与钉住的执行目标每次都完全相同。看板需要一种按任务选择「让
周期性任务留在同一个对话里」的手段，同时不牺牲既有「一次执行一个会话」契约的
安全性质。

## Decision

- `TaskRecord.reuseSession?: boolean`（缺省/false 即历史行为）是按任务的
  选择项，可在创建、复制或任务详情的执行设置里开启。用 `false` 表示关闭，
  避免依赖 `undefined` 能否在 JSON 序列化中存活。
- `src/core/session-reuse.ts` 用纯函数 `reusableSessionId(task, idleSessionIds)`
  独占裁定整条规则。复用必须同时满足：任务已开启、最近一次执行带有 session id
  且已结算、该 session 在上次名册中存在且空闲。名册未知（`session/list` 不可用）
  时一律不复用——新建会话永远安全，向看不到的会话投递 Prompt 则不安全。
- `TaskBoardHostService.reuseSessionFor` 为本次启动读取最新名册，把候选值传给
  `HostExecutionRunner.launch`。
- `HostExecutionRunner.launch(task, { reuseSessionId })` 在该会话中继续：不调用
  `session/create`、不调用 `session/rename`（会话标题与历史保持不变），通过共享的
  `pinAndPrompt` 重新应用钉住的权限与模型以保证执行契约仍然成立，再入队 Prompt。
  当被复用的会话是持久化冷会话（在 `session/list` 中空闲可见但尚未进入内存
  `ctx.agents`）时，`src/index.ts` 的 `resolveExecutionAgent` 在
  `ctx.commands.execute` 执行 `/permission` 或 `/goal` 前先经
  `sessionController.resolveAgent(sessionId)` 唤醒其 live Agent（issue #1861），
  与 `session/selectModel`、`session/prompt` 的冷会话激活路径一致。失败仍以
  `SessionLaunchError` 抛出，并携带被复用的 session id。
- 线上与存储：`create`/`update` 接受布尔值，`null`/`false` 清除，其他类型直接
  拒绝；账本形状检查拒绝非布尔行，解析器把持久化的 `false` 归一化回缺省。
- 同一次改动中更新了 zh/en 的 `exec.reuseSession` / `exec.reuseSessionHint`、
  ru 镜像、中英 README 与包级 AGENTS.md 的执行规则。

## Testing

- `tests/session-reuse.spec.ts`：开启与否、名册未知、会话运行中/已消失、
  最近执行为打开状态或无 session、以及复用链跟随最近一次执行。
- `tests/host-runner.spec.ts`：复用路径对网关只发出 `agentPresets/list`、权限
  命令与既有会话上的 `session/prompt`；复用 Prompt 失败时报告该 session id。
- `tests/host-apply.spec.ts`：`resolveExecutionAgent` 对热会话直接返回 live
  Agent，对冷复用会话在执行 `/permission` 前经 `sessionController.resolveAgent`
  唤醒，并在冷会话无法恢复时透出控制器原因。
- `tests/protocol.spec.ts` 与 `tests/store.spec.ts`：线上接受/拒绝与账本归一化。
- `tests/task-detail-edit.spec.tsx`：开关渲染、以 `{ reuseSession: true }` 开启、
  以 `{ reuseSession: false }` 清除。
- 本次改动运行的门禁：包内 typecheck 与 test、`pnpm i18n:check`、
  `pnpm docs:check`。

## Alternatives considered

- 只要上一会话仍存在就复用：否决。用户正在其中对话的会话会收到排队的任务
  Prompt，执行结算逻辑会与用户自己的轮次竞争；要求名册显示空闲才能避免这一点。
- 要求被复用会话已在内存 `ctx.agents` 中否则回退新建会话：否决（issue #1861）。
  DSH 重启或无人值守的 cron 触发时，上一会话在持久化层（`session/list`）中空闲
  可见，但没有浏览器标签页调用 `session/follow` 将其提升进 `ctx.agents`；若因
  冷态而回退新建会话，每次重启后定时任务都会丢失原对话。经
  `sessionController.resolveAgent` 恢复冷会话即可保留对话并复用官方预设与模型
  选择恢复逻辑。
- 复用时不重新应用钉子：否决。首次运行后修改过权限或模型的任务会静默沿用旧值，
  破坏看板文档承诺的 fail-closed 执行契约。
- 滚动轮换策略（每 N 次 / 每 N 天 / 上下文压力时新建会话）：暂缓。上下文压力
  在当前网关面上对 Host 不可观测，而本 issue 的主要诉求就是这个选项本身；后续
  可在此字段之上再加一个轮换计数器。
- 独立的「会话组」实体：否决。任务上的一个布尔值即可，账本 schema、线上协议与
  UI 形状都不需要变动。

## Consequences

- 周期性任务可以只占一个对话，侧边栏不再每触发一次就多一个会话。
- 复用按设计是尽力而为：会话正忙或不可见时新建会话，而不是延迟或阻塞运行；
  这在执行历史中可见（出现新的 session id）。
- 被复用的会话保留原标题，且每次复用都会重新应用钉住的权限与模型。
