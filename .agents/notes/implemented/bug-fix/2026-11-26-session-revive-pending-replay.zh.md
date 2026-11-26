# Agent Note: dsh-session-revive 复活决策跨重启重放 + boot sweep 纳入 closed-error 会话

Status: implemented

## Problem

2026-11-26 事故，活动日志里的一条链：11:21:20 检出 `TRANSPORT` 死亡
（ba0d8ab6），裁定账判 `revive`（额度 1/4）；v2 门因路由探针红
（11:21:23、11:23:33）把决策推迟为 `probe-pending`。11:25:39 UI 重启。
这条推迟的决策只活在 `SessionState.pending`——进程内存——随进程蒸发。
11:26:20 的 boot sweep 筛出 `rows:6, candidates:3, revived:3`，但该会话
已被自己的 error 轮收口，而 sweep 判据只有「未闭合 turn」，它从未进候选。
11:30:51 探针转绿时已无 pending 可放行，11:32:20 有人工键入 `continue`。
两层缺口：

1. pending 复活决策是纯内存态——任何 UI 重启即丢；
2. boot sweep 只筛未闭合 turn——已由可复活 error 收口的会话对它不可见，
   而事件驱动的 detect 从不重放旧错误。

## Decision

设计先行（仓规 #5）：两条规则先落
`content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2（规则一、
规则二，及额度边界句「拍板⑪ 零额只免 boot sweep 计数」），再动代码。

规则一——pending 持久化：

- 新增 `src/pending-state.ts`：`readPendingEntries` 是激活时的唯一一次读
  （文件缺失 = 干净空读；解析/形状/越界任一失败 = fail-closed 结果，壳层
  据此「跳过全部重放」并落一行响亮日志）；`RevivePendingWriter` 是
  change-only 原子写（temp+rename），种子就取自那次读——重放后的账本
  逐字节复现、零写入。文件有界（`PENDING_MAX_ENTRIES`）：越界账本 =
  损坏，越界快照也拒写（可读的旧账本胜过写坏的新账本）。
- `v2-machine` 增 `pendingSnapshot()`——恰好是 `releaseDue` 输入集
  （plannedAt/code/channel/route/cooldownUntil；route 缺省回退
  `currentRoute`，与放行本身同源）——与 `restorePending()`：幂等重放，
  live-wins（已有 pending 或 attempt 在飞绝不覆盖），首核先查 gate
  （v2 每个入口一律 fail-closed），`channel` 与 `nextChannel` 一并复原，
  attempt 记录的通道证据不漂。
- 壳层接线：读 → 重放 → 响亮 `pending-replay`（带计数）或
  `pending-replay-skipped`（`read-failed` / `first-gate`）行；读失败或
  首核红时**根本不建 writer**——读不动/未重放的账本原样留给下一次启动，
  绝不被空账本覆盖。`applyV2` 与 `offDisposed` 双点 change-only 同步
  （处置清 pending 走不到 applyV2 路径）。

规则二——closed-error 纳入 sweep：

- `classifySweepRow`：检查点判 closed 但 `lastTurnOutcome` 投影读
  `kind === 'error'` 的行重进候选面（该投影在 `trimHeavyProjections` 下
  保留，零额外 IO）；其余 closer 与投影缺失维持 `closed`。
- `scanOpenTurn` 折 `lastError`（code/message）：只在日志**末轮**
  `turn/end` 为 error 时盖章，后到的非 error closer 清除——raw 尾部
  永远作准。
- `runBootSweep` 的 closed 分支只有在 `lastError` 在场 **且** 可选依赖
  `reviveClass` 已绑定 **且** 其回答 true 时才 decide；其余一律维持
  `confirmedClosed`（未绑定分类器 = fail-closed）。随后走既有
  attached 检查 → seedRoute → `decide` 链与零额 `onBootSweep` 通道——
  summary detail 键集不变（该处是 `toEqual` 断言）。
- `RevivalPolicy.revivable(code)` 是唯一生效分类的只读查询：自学习
  sticky 除名先否决，再走 `classOf`（准入优先于裁定/配置名单）。它不喂
  学习、不计额度。壳层先绑 `refineFailureCode(code, message)`，sweep 确认
  与线上 `turn/end` 路径对同一码永不分歧。

## Alternatives considered

- **回读 `session-revive-v2-state.json` 当重放源。** 那是单向双边导出契约
  （字段集不得 widen、inbox 单在消费），且字段集不是 `releaseDue` 输入集
  （无 plannedAt、无 channel）。设计 §4.2 规则一原文把这一手列为打回反例；
  拒。
- **整机状态持久化**（strikes、stopped、relay、波与断路计数）。拍板⑪
  「重启清零 = 新窗」与 §4.2 条1 已裁其重启清零，持久化会把额度戳复活过
  裁定划的界。持久化面只留 releaseDue 输入集。
- **重放时重新裁决**（把错误再喂一次 `policy.onError`）。那会重跑准入、
  重复计额度；重放要执行的是死进程**已做出**的决策（重启零额）。拒。
- **投影筛查直接作准**（免 raw 确认）。检查点按 write-behind 窗口滞后，
  过期投影可能放行 raw 尾部并非 error 的会话；raw 读保持权威，投影只扩
  候选面。
- **`reviveClass` 设为必填。** 会一次性逼改所有既有绑定与测试；可选 +
  fail-closed 让旧绑定照常编译，同时未分类的尾部绝不 decide。

## Consequences

- 推迟决策挺过宿主重启：重放 → 探针 → 放行，**恰好一个** attempt。两条
  重进通道（pending 重放与规则二 sweep）汇于单一 pending 槽位加
  attempt-in-flight 守卫，组合不双推——夹具把次数钉死。
- closed-error 会话重新进入 boot sweep；closed 非 error 轮、撞墙类与已
  除名码维持 `confirmedClosed`，筛查判 closed 的行连读都不读（已记载的
  write-behind 残余不变：滞后只可能漏、不会误复活）。
- 额度边界写进设计：重放与 closed-error 重检都骑重启触发的零额面；
  非重启的事件驱动 error 线照旧计 4h×4。
- 账本损坏降级为每次启动一行响亮 `pending-replay-skipped`（等人修文件）
  ——绝不静默丢数据、绝不覆盖读不动的旧状态（宁漏不误复活）。
- README：安全模型条目原称「不写文件、无外网」——自 v2 探针门起已过期
  ——现改为点名 `<dsh-home>` 本地账本与路由探针；内存态限制条目注明
  pending 是唯一持久化例外；双语重新配对（`verify-docs.mjs --write`）。
- 构建出的 `lib/index.js` 保持与已安装 profile 副本的硬链；运行中的
  宿主只在重启后拾起变更（仓规：agent 不重启服务）。

## Testing

包级三门全绿：`pnpm typecheck`（主 + test 两配置）、`pnpm vitest run`
16 文件 / 231 测试（新增：`pending-state.spec` 13——读端 fail-closed 矩阵、
change-only/种子/重试/越界写端、全环回；`restart-replay.spec` 两态夹具；
`sweep.spec` 规则二 +8；`v2-machine.spec` pending/重放 +9）、`pnpm build`。

验收夹具正态复刻事故形态——error 收口会话 + pending defer——模拟重载
（新机、单次账本读、幂等重放），对 closed-error 行跑 boot sweep，再探针
转绿：跨重启恰好一个 `v2-attempt`，detect → decision → attempt 链全在。
反态：closed `completed` 轮零读、零决。
