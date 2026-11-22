# Agent Note: Seal worker 拒绝记录其基础设施成因，而非 decode-fail

Status: implemented

## Problem

`createSealStateSync` 的 turn/end 计算把被拒绝的 worker 降级为 `UNKNOWN` 记录，而每一种拒绝——worker 脚本缺失、30 秒预算耗尽、worker 崩溃——都被盖上 `detail: 'decode-fail'`。`decode-fail` 是契约 C1 词表里「分析读不出转录」的码，于是这类记录断言了一个转录并不支持的数据结论。2026-11-14 的事故把这个谎坐实：一次 profile 安装抹掉了 `lib/host/seal-compute-worker.js`（05:39–14:59），该窗口内每次 turn/end 都拒绝并记下 `UNKNOWN/decode-fail`，而 `seal-check` 端点——它进程内计算、不走 worker——对同一批会话回答 `DONE`。记录是 append-only，于是一直到下一次 turn/end 覆写之前，这些假行持续在本可归档的会话上压灯。

## Decision

被拒绝的 worker 计算现在会点名自己的基础设施成因。`computeSealInWorker` 以携带机器 `detail` 的 `SealComputeError` 拒绝：`worker-missing`（模块旁无脚本）、`worker-timeout`（30 秒预算）、`worker-error`（崩溃、无结果，或注入的 seam 抛出）。turn/end 的 catch 读取该 detail——任何未标记的降级为 `worker-error`——并仍然盖 `verdict: 'UNKNOWN'`。`decode-fail` 从此只有 worker 自己返回的解码失败才能触达，那才是 C1 词表被定义出来要断言的结论。

裁定的失败语义未动：UNKNOWN 仍然盖行，relay 门保持 fail-closed，投影 schema 本就接受开放字符串 detail。

## Alternatives considered

被拒绝的计算什么都不记——否决：既有记录会留存，而它可能是一条陈旧的 `DONE`，正是 UNKNOWN 盖章要防的 fail-dark 方向，且行为会因「是否已有记录」而分叉。

把 `UNKNOWN` 记录从投影 fold 里丢掉、让 C1 拉取快照透出——否决：那会让 Host 判定不再压制 C1，即 `seal-light-host-state-ruling-1110` 的「Host 压 C1」语义，属简报待裁，不属一次修复。

所有拒绝统一成一个不加区分的 `worker-fail`——否决：那三种成因恰是未来事故必须分开的根因三候选，而记录是唯一能留存下来把它们分开的凭证。

## Consequences

记录对「什么坏了」保持真实：未来一次 worker 故障留下的将是 `worker-missing`/`worker-timeout` 行而非 `decode-fail`，于是日志里的 `decode-fail` 意味着转录确实没解出来。既有假行是 append-only、此处不改写——它们在 worker 回场后的下一次 turn/end 转正（2026-11-14 实测：worker 文件恢复后有会话从 `UNKNOWN/decode-fail` 翻为 `DONE/sentinel-ok`）。

`detail` 经 `SealLight` 的 detail switch 渲染，该 switch 带 `default` 分支，因此新码不画 detail 行、不改灯色；灯色读的是 verdict。

## Testing

`tests/seal-state.spec.ts`（12 例）：计算抛出那例现在期望 `UNKNOWN/worker-error`，另新增一例钉住分界——worker 返回 `decode-fail` 就记 `decode-fail`，计算以 `worker-missing` 拒绝就记 `worker-missing`。包 `vitest run`（24 文件 251/251）与 `typecheck`（tsgo 双配置）全过。
