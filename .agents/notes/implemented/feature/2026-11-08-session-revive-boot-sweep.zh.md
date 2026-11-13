# Agent Note: dsh-session-revive boot sweep (restart revival at activation, zero quota)

Status: implemented

## Problem

[2026-11-03 session-revive 笔记](2026-11-03-session-revive.zh.md) 落下的是
错误路径复活账，但它只能对 `turn/end` 事件作出反应。Host 重启会把进行中的
会话掐死，而 `interrupted` closer 只在会话下次 resume 时才追加（设计档
`content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2 条3，harness
`agent-loop` 的 `resumeWith`）：干坐着的被掐会话一个事件都不发，监听永远
等不到，会话就一直死着。2026-11-08 裁定翻转了设计——重启要自动复活，并且
重启这一次不算额度——所以激活时需要一次对孤儿轮的主动扫描，且这批复活不消耗
4h x 4 额度，同时仍受断路器、错峰、300k 水位与同因探针约束。

## Decision

- **激活期 boot sweep**，实现在 `src/sweep.ts`，在 `src/index.ts` 里状态
  路由之后以 fire-and-forget 挂出（插件既有的 `AbortController` 在卸载时
  取消它）。每次激活落一行 `boot-sweep` 汇总计数；任何失败都落响亮的
  `boot-sweep-failed` 行并停掉该路径——未确认的会话绝不 nudge（fail
  closed）。
- **两级预筛、只用既有缝、零 harness 改动**：tier 1 读
  `sessionController.list({ includeArchived: false, trimHeavyProjections: true })`
  行上由 harness 维护的 `turnBoundary` 投影——`openTurnStartSeq` 为数字即
  「最后一次 `turn/start` 到检查点刷写时仍未遇到 `turn/end`」，`null` 证明
  该轮已闭合，缺位即无可用检查点；tier 2（无投影缓存记录）不走预筛、直接
  原始读。本机语料实测（2026-11-08）：1803 份转录中 1627 份带缓存记录；
  扫描时点的 20 个孤儿轮里，有记录的 15/15 全部被预筛命中、0 漏 0 误，
  无记录的 5 个走 tier 2（176 个会话 / 80MB / 全解码约 4 秒，后台跑）。
- **任何 nudge 之前先原始确认**：`sessionPersistence.open(id, 'read')` →
  `handle.read()` 给出未平衡事件流，在这里前向配平（`turn/start` 开、
  `turn/end` 合）。这是唯一能区分「未闭合 turn」与「已提交 interrupted
  closer」的来源；读取同时把最后一条 `assistant/message` 的 usage
  （`inputTokens + cacheReadTokens`）折进 `policy.recordUsage`，让 300k
  水位真正约束 sweep 复活。读完后的 `isAttached` 复查保证 sweep 途中被人
  打开的会话不会被二次驱动。
- **归因是结构事实、不是启发式**：所有进程内停轮都会提交 `turn/end`（人为
  中止 → `aborted`、目标 block → `blocked`、fork → `forked`、失败 →
  `error`、resume → `interrupted`），所以冷会话的原始日志尾部停在 turn
  中间只可能由进程中途死亡造成——即重启。不引入任何时间窗（参数零改）。
- **`RevivalPolicy.onBootSweep`**（`src/policy.ts`）走错误路径的闸、只去掉
  额度罐：tripped 与断路器检查、撞墙挂起（过期挂起与错误路径同样放行）、
  300k 水位、全局错峰槽决定 `plannedAt`；写 `lastRevivalAt` 武装断路器，
  sweep 复活 10 分钟内再死会经正常路径跳闸。它不盖额度戳、不碰
  `counters`，停靠走 `sweepSkip` 而非 `skipRecord`，所以 status 的
  `counters`/`quota` 逐字节不变（拍板⑪ status 零增）——决策行本身就是留证。
  `BOOT_SWEEP_CODE = 'boot-sweep'` 让 nudge 保持朴素「继续」，并让同因探针
  照样看不到它（与 `ROUTE_SWITCH_CODE` 同款隔离）。
- **启动就绪是重试出来的、不是赌出来的**：listing 报错、或整份 listing 里
  还没有任何行带 `turnBoundary` 时，在固定尝试预算内（6 次 x 1 秒，属管线
  搭建而非裁定参数）等待重试，之后响亮放弃。

## Alternatives considered

- **订阅 `interrupted` closer / 等 `session/event`**：否——closer 只在
  resume-load 时追加，干坐的被掐会话什么都不发，订阅永远不触发；这是设计档
  §4.2 条3 的结构事实，至今成立。
- **用 `lastPromptAt > lastTurnOutcome` 预筛**：否，不作主信号——该折叠只在
  `turn/end` 上推进，看不见未闭合轮本身，且与 `turnBoundary` 共享同一个
  write-behind 窗口、还多出一类误报；`turnBoundary` 正是 harness 自己
  「summary 行读出 interrupted mid-turn」的客户端可见信号。
- **激活时全量 raw 扫全语料**：否，不作 boot 主路径——离线实测 1803 份转录
  仅尾帧解码就 19.5 秒，全解码更重；投影预筛把 raw 读收敛到候选（约 21 个
  筛中 + 176 个无检查点行）。
- **用 `sessionQuery.readSession`（已平衡）确认**：否——它的合成 closer 与
  已提交的形状完全相同（同出 `interruptedTurnClosers`），分不出「从未
  resume」与「已 resume」；持久层读是未平衡的，能分。
- **给孤儿唤醒加时间窗**：否——没裁过时间窗（参数零改），设计文本对扫孤儿
  轮无修饰限定，加窗就是新增裁定值、须重跑统计；首启的历史积压是一次性
  成本，且已受水位、断路器与错峰约束。
- **sweep 停靠走 `skipRecord`**：否——它会动 `counters` 与 `skipReasons`，
  破坏 status 零增行为判据；`sweepSkip` 让裁定账逐字节不变。

## Consequences

- 装上后的首次激活会把历史积压整批错峰唤醒（实测约 20 个孤儿，含 9/10 月
  遗留）；之后每次 boot 只见上次以来新掐的孤儿。README 写明这点，避免把
  批量唤醒误当 bug。
- 预筛信任投影检查点，而检查点按 write-behind 窗口滞后日志
  （`writeIntervalMs: 5000` / `writeEveryEvents: 200`；只在创建、
  `turn/end`、会话处置三点强制刷）：硬杀重启若落在孤儿 `turn/start` 后的
  该窗口内，该孤儿当次激活筛不出来；优雅重启在会话处置时强制刷检、能筛出。
  因为被筛中的候选一律再经原始确认，这种滞后只可能漏、绝不会误复活已闭合
  会话。
- sweep 决策对 status 账本设计上不可见：重启后验证读 `boot-sweep` 汇总与
  `code: "boot-sweep"` 决策行，不读计数器。本包原决策的错误路径账完全不变。
- 无投影缓存记录的会话在每次激活都会被 raw 读一次，直到它跑过一次 live 拿到
  记录；完全没有投影缓存的部署会在列表尝试预算用尽后退化为全量 raw 扫。

## Testing

`tests/sweep.spec.ts`（10 个测试）锁定预筛分类、原始尾部配平（含已提交
`interrupted` closer 读作闭合），以及经假依赖面的编排：只读候选、listing
拒绝时重试、无投影时退化、列表放弃、缺持久层缝时 fail closed、附着竞态
跳过、预中止静默退出、单会话读失败不弃整轮。`tests/policy.spec.ts` 增至
34 个测试，boot-sweep 组覆盖 revive 与停靠两种情况下 `counters`/`quota`
逐字节不变、断路器武装加跳闸加停用后再入、整个 4h x 4 罐留给错误路径、
300k 水位停靠、错峰间距、撞墙挂起的保持与过期放行。三门（typecheck、
vitest 62 通过、build）全绿；没有任何测试触碰真实会话生命周期，沙箱规则
未被触发。
