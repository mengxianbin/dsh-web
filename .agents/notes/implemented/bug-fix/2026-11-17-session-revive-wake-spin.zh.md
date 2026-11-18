# Agent Note: dsh-session-revive 止住 v2 wake/probe 定时器自旋

Status: implemented

## Problem

2026-11-17，DSH web 宿主主线程连续数小时打满单核 100%：所有 API 有约 400ms
延迟地板、`/api/session/list` 稳定 4–8 秒、客户端每约 25 秒全量 bootstrap
一轮——这就是「dsh-web 持续重连」的现场。对宿主抓 12 秒 inspector CPU
profile，耗时归到复活 v2 定时器链：

```
listOnTimeout -> applyV2 -> armProbeLoop -> routesNeedingProbe
  -> resolveBaseURL -> readSettingsNamespace -> settings.describe()
     （全量扫 profile 目录：readFileSync/existsSync/lstat/structuredClone）
```

`dsh-config-editor` 单文件占采样 29%、native fs 占 24%，因为每一圈都付一次
完整目录扫描。

外壳重挂逻辑里两个缺陷叠成闭环：

1. **wake deadline 过期 -> `setTimeout(0)` 自旋。** `releaseDue` 只在路由
   已探绿时才释放停靠会话，路由未探时它返回空，`nextWakeAt()` 永远返回一个
   已经过期的 deadline，`armV2Wake` 就以 0ms 无限重挂。
2. **probe 定时器饿死。** `applyV2` 先挂 wake（A）后挂 probe（B），两者都是
   0ms，A 先触发；而每一圈 `armProbeLoop` 都 clear B 再重挂到 A 后面。探针
   一次都没跑过（80 分钟日志 0 条 `v2-probe`），路由永不转绿，缺陷 1 永不
   解除。

当天 01:42 的 boot sweep 留下 4 个 `plannedAt` 已过期的 pending 会话，正是
它把闭环扣上了。

## Decision

三条调度规则放进 `src/v2-timers.ts`，做成纯函数（不挂载插件即可测）；
`src/index.ts` 只负责接线：

- **wake 下限** — `wakeDelayFor(deadline, now)`：未来 deadline 用精确延迟，
  已过期的用 `WAKE_RETRY_FLOOR_MS = 1_000`。过期意味着释放被挡着，定时器
  唯一有用的动作就是 1Hz 轮询，而不是自旋。
- **probe 定时器计划** — `planProbeTimer(pending, targets)`：已有挂起定时器
  就**保留**（绝不重启 60–120s 随机倒计时、绝不清掉即将触发的 0ms 定时器），
  无探针目标才 clear，只有当挂起的定时器本身不是 immediate 时才改成立即
  触发。更紧急的排期仍然优先，所以刚失去缓存的路由会立刻探。
- **settings 读 TTL** — `makeTtlReader(SETTINGS_READ_TTL_MS = 5_000)` 包住
  `makeResolveBaseURL` 里的两个 namespace 读，把 `settings.describe()` 的全量
  扫盘撤出热路径；`undefined` 结果同样入缓存，一次设置层抖动只付一个 TTL，
  而不是每圈一次扫描。

`armWake`（策略波次定时器）是同样的 `Math.max(0, ...)` 形状，但**刻意不动**：
它的 `releaseDue` 总会清空 `wave.held`，`nextWakeAt()` 随即返回 null，定时器
按构造必然终止。

## Alternatives considered

- **所有 wake 延迟统一 `Math.max(FLOOR, delay)`** — 否决：会把合法的近未来
  deadline 也推迟最多 1 秒。只对已经过期的 deadline 加下限。
- **把 `baseURL` 解析从 `routesNeedingProbe` 挪走**（只在 `runProbeRound` 里
  解析）— 更省，但改的是 machine 契约与它的测试；TTL 让本次修复留在外壳内，
  也正是烧 CPU 的地方。
- **只重启或直接禁用插件** — 重启能清空 pending、让一次探针侥幸跑成，但下次
  boot sweep 的时序竞态还会重演；禁用则整个复活账面失效。
- **改用 `settings.get`** — 设置服务没有单 namespace 读（只有 `describe`），
  没有更便宜的读法可切。

## Consequences

- 过期释放改 1Hz 轮询、探针定时器真的会跑，boot sweep 留下的停靠会话在第一次
  探绿后即释放，不再拖垮宿主主线程。
- 设置改动 5 秒内到达路由解析；探针本来 60–120 秒一轮，外部可观察行为不变。
- 循环仍是事件驱动：零停靠会话 = 零定时器（未变）。
- 产物已重建进 `lib/index.js`，已安装的 profile 副本与它**硬链接同 inode**；
  运行中的宿主要等 DSH web 重启才拾取（仓规：agent 不自行重启服务）。
- 明确留作范围外：`@linxin666/dsh-usage` 从凭据路径读同一个 `describe()`，
  但那是每轮一次、不是自旋。

## Testing

`tests/v2-timers.spec.ts` 钉住三条规则：过期 wake 下限、probe 的
keep/clear/arm 计划（含「绝不重启倒计时」「绝不清掉即将触发的定时器」两例）、
TTL 缓存（含缓存 `undefined`）。包级 typecheck、vitest（12 文件 155 例）、
build 三门全绿。

另见：[复活 v2 探针门与状态机](../feature/2026-11-17-session-revive-v2-probe-statemachine.md)。
