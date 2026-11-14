# Agent Note: dsh-session-dispatch 409 门与快账追加进程内串行化

Status: implemented

## Problem

[快账](../feature/2026-10-19-dispatch-quick-ledger.md)的 409 门是无串行化的 check-then-act：`POST /api/session-dispatch` 先等 `findAlive(taskRef)`，再创建会话，再落绑定——同一 taskRef 的两个并发派发可以在任一方落账之前都读到「无活会话」，双双过门，把任务劈成两半。存储层的写入同构：`FileBindingStore.record` 读文档、推一行、重写文件，同一进程里两个竞速追加都会读到旧文档，后到的 rename 会静默丢掉先到的行。台账机器本地、是传感器而非账本（单 Host 进程、板面裁定的低并发量级），因此闭合手段必须相称：进程内串行化，仅此而已。

## Decision

- **门段经 per-taskRef 进程内 FIFO 执行。** `makeDispatchRoute` 把从 `findAlive` 起、经创建会话/提示词、直到台账追加的整段收进一个 `proceed()`，由 `createGateQueue()` 排队执行——每个 taskRef 同时只有一个在途派发。败者的 `findAlive` 由此读到胜者的绑定，回答 `409 { ok, taskRef, sessionId }` 并点名胜者会话。不带 `taskRef` 或未组装 store 的派发不入队，不同 taskRef 的派发互不等待。
- **台账追加走自己的进程内 FIFO。** `FileBindingStore.record` 把读-改-写循环串在 `appendTail` 上（私有 `append`），竞速追加按到达顺序保全每一行。读侧（`findAlive`、`list`）不入队：`writeJsonAtomic` 的 rename 保证其只见旧文档或新文档、绝不见半成品。
- **范围有意限定在进程内。** 单一 Host 进程拥有这些路由与存储（mount-once、link 安装），因此不引入文件锁、外部队列或跨进程协议。两条队列都抗拒绝：失败的段不毒化链，空闲的 taskRef 键随后删除。

## Testing

`tests/routes.spec.ts` 新增同 taskRef 双并发用例：两个在途 POST 恰好一 `200` 一 `409`，409 点名胜者 `sessionId`，且只创建一次会话、只落一行（create 故意等一个 tick，未串行化时两者都会过门）。`tests/bindings.spec.ts` 新增竞速追加用例：三个并发 `record` 后磁盘上三行按序全在。包内 46 个用例，包级 `pnpm typecheck` 绿。

## Alternatives considered

- 所有 taskRef 派发共用一条全局队列：否决——批量派发对不同 taskRef 并行落地，它们在门上从不互相竞速，跨 taskRef 串行是纯耦合零收益；队列按 taskRef 分键，正是竞速的精确范围。
- 给 `dispatch-bindings.json` 上文件锁（或任何跨进程锁）：否决——对单写者进程是过度设计，超出板面「进程内串行化」裁定；没有硬证据表明曾有第二个进程写台账。
- 过门时预留 taskRef（会话尚不存在先落绑定）：否决——它改变台账语义（预留后失败的派发会拿一条从未可用的绑定拦重派），而排队在不动语义的前提下闭合同一窗口。
- 只给 `findAlive` 上锁：否决——只串行化检查、把动作留在锁外，TOCTOU 窗口依然在；队列必须从检查贯穿到追加。

## Consequences

- 并发重复派发现在要等完胜者的建会话周期才收到 409：只有败者请求多付延迟，顺序派发行为不变。
- 串行化只存在于单进程内；若将来有第二个进程对同一 `$DSH_HOME` 挂载本插件，门会重新打开，届时须重读本 note。
- 队列按路由/存储实例各持一份：生产只组装一次，测试各持自己的，并行测试文件从不共链。
