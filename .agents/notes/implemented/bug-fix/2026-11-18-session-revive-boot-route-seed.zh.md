# Agent Note: dsh-session-revive 从存档日志播种 boot 路由

Status: implemented

## Problem

[v2 探针门上线](../feature/2026-11-17-session-revive-v2-probe-statemachine.md)
之后，每次 boot sweep 都是零 nudge：2026-11-17 17:45 与 2026-11-18 01:42
两次重启，全部候选都停在 `v2-gate defer route-unknown`（两份活跃日志均为
`nudge-sent=0`、`model/selection=0`），而 v2 之前的同款 sweep 每次发 9 条。
后来转绿的三个会话，是人在网页里手敲 `continue` 唤醒的，不是插件干的。

门要一条线路（route）才肯放行本身没错——探针必须知道敲哪个端点——错在它读的
那份线路状态活不过它依赖的事件：

1. `ReviveV2Machine` 的 `state.route` 与 `currentRoute` 只在内存里，宿主重启
   即清零。
2. 唯一的活体进账是 `model/selection` 事件（`machine.setRoute`）。它只在
   **主动改选**时追加（`AgentModel.select` 同值不写），而停摆会话——恰恰是
   boot sweep 要复活的那批——永远不会产生它。auto-route 只写「在飞集合」，
   重启后该集合是空的。
3. 存档日志里线路明明躺着：2026-11-18 三个候选每个都有 4–8 条
   `request/header`（含 `config.provider/config.model`）。sweep 正是读这些事件
   确认孤儿轮、折叠 `contextTokens` 的——只是没顺手折叠线路。
4. 没有线路时 `releaseDue` 与 `routesNeedingProbe` 都对会话 `continue`，
   1Hz wake 轮询在一个永远不会变的决策上空转：永久 fail-closed 死锁，且健康
   文件五事实始终 `ok:true`，所有健康面不可见。

设计文档（`content/tech/ai/dsh/session-revival-v2-alert-inbox-1116.md` §五）
只写了「探针对象 = 当前 `model/selection` 的 provider baseURL」，通篇没有
「没有该事件时怎么办」的条款——冷启动场景从未被设计。

## Decision

线路证据从 sweep 本来就在读的日志里折叠，且落在决策之前：

- `scanOpenTurn` 在 `open`/`contextTokens` 之外折叠 `route`：取尚未被匹配的
  `request/header` 退役的最新 `model/selection`，否则取最后一条 header 的
  config——与宿主 `modelSelection` 投影同一折法（`pending ?? lastUsed`）。
- `BootSweepDeps.seedRoute`（可选）在确认孤儿、且未被 attach 之后、`decide`
  之前立即调用；`ReviveV2Machine.seedRoute` 落库且**不覆盖**机器已持有的证据。

于是决策从 `route-unknown` 改判 `probe-pending`，立即探针轮开跑，探绿后按各自
错峰的 `plannedAt` 逐条放行。

另有一条独立规则堵住由此产生的反抱团边角：探针若在多个 `plannedAt` 都过期之后
才转绿，整批会在同一 tick 放行。`planNudgeDelay`（v2-timers）把每次发送重新
锚定在「上一次发送的真实触发时间 + 配置的 `staggerMs`」上，保证连续 nudge 永远
间隔不小于裁定错峰，同时孤立的一条 nudge 绝不被拖延。锚点住在外壳
（`lastNudgeAt`），规则是纯函数，测试可钉。

## Alternatives considered

- **mount 时用配置默认线路播种 `currentRoute`（选项 B）**：最省事，但这是猜：
  实际跑在别家 provider 的会话会被按错端点探针、按错线路放行，且错线路会被当
  成证据记下来。输给了准确性。
- **boot 决策豁免探针门（选项 C）**：恢复 v2 之前每次重启发一批 nudge 的行为，
  包括推进欠费墙的端点——恰是 v2 门要挡的那堵墙。判为倒退，否决。
- **`releaseDue` 单趟只放一条 + 重盖时间戳**：改的是所有放行路径依赖的状态机
  语义，还要一个机器并不拥有的错峰常量（`staggerMs` 属于 policy）。发送侧锚点
  用一个纯函数覆盖全部路径，不动状态机。
- **决策时改读投影缓存拿线路**（不读原始日志）：sweep 已经在流式读原始事件，
  为同样的事实再开一条 seam 读第二遍，纯属重复 I/O。

## Consequences

- 有线路证据的 boot 决策走通 线路 -> 探针 -> 错峰放行；凡日志里有请求或选型
  记录的会话，这类死锁即被关闭。
- 完全没有线路证据的会话（从未发过请求）仍停 `route-unknown`——确实无物可探
  的地方保留 fail-closed。
- `currentRoute` 仍只来自 `model/selection`；本改动只加每会话播种，不削弱该
  频道。
- 即便延迟批次放行时计划已过期，nudge 发送现在也保证最小间隔（2026-11-12
  反抱团裁定），复用配置的 `staggerMs`（下限 10s）。
- 构建出的 `lib/index.js` 与已安装 profile 副本硬链接未断；运行中的宿主只在
  重启后拾取本改动（仓规：agent 不自行重启服务）。

## Testing

包级三门全绿：`pnpm typecheck`（主 + 测试两份配置）、`pnpm vitest run`
12 文件 / 162 例（新增 7 例：`sweep.spec` 的线路折叠与「先播种后决策」次序、
`v2-machine.spec` 的播种-探针-放行链与首证据优先、`v2-timers.spec` 的批量错峰）、
`pnpm build`。
