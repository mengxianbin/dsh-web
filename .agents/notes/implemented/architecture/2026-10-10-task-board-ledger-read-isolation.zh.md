# Agent Note: Task-board board reads hand out an isolated task array

Status: implemented

## Problem

`HostTaskLedger.state()` 服务于每一次任务板读取，而它为此重建了整份账本：任务列表经由 `JSON.parse(JSON.stringify(tasks))` 复制出来，HTTP handler 随后又把这份副本序列化一遍。这次读取并不罕见——`state()` 既服务于 `GET /api/task-board/state` 背后的 `TaskBoardHostService.snapshot()`，也服务于每个 action 响应（`applyRequest` 返回的 `{ state }`），因此一次任务板交互会为这次复制付费多次。在复核窗口实测：400 张卡各带 2 条执行记录（响应 365346 字节）时每次读取 0.43 ms；400 张卡各带 20 条执行记录（1830946 字节）时 2.72 ms——20 是保留历史上限，因为 `EXECUTION_HISTORY_LIMIT` 会把一张卡的执行历史裁到 20 条。该路径没有任何缓存，重复读取与第一次同价。

这次复制是为了守住一条契约：收到任务板读取结果的调用方，不得通过它改写账本。

## Decision

`HostTaskLedger.state()` 交出 `tasksForRead(this.document.tasks)`，而 `tasksForRead` 只做一层复制——`[...tasks]`。隔离边界就是数组本身：调用方可以对自己收到的集合做 splice、sort、push 或清空，都触不到文档。

这一层边界就是契约的全部，因为数组里的记录是稳定值。`HostTaskLedger` 的每一次写入都替换文档数组（`this.document.tasks = ...`，共 30 处赋值），并替换被修改的记录而不是原地改它；本类中没有 `document.tasks[i].field = ...`、没有 `document.tasks.push/splice/sort(`、也没有 `executions.push/splice(`。因此连记录一起复制只会让每次读取重建整份文档，换不到任何消费者依赖的性质。

选定该边界前逐个核对了调用点：6 处 `state()`（`host-ledger.ts` 689、945、1177 用于 action 结果；`host-service.ts` 311 用于 `snapshot()`、425 用于一次 `find`、438-440 用于 action 快照），以及它们构造出的快照的 7 处下游消费者（`host-routes.ts:192` 只做序列化；`agent-tools.ts` 的 321、402、438、485、537、576 做 map、filter 与查找）。没有任何一处写数组或写记录。喂给 SSE 帧的 `summary()` 本来就不复制，未被改动。

## Measured

同一份合成账本上的一次任务板读取，改造前后各 3 个 pass，均在新进程中执行：

| 形状 | 改造前 | 改造后 |
| --- | --- | --- |
| 400 张卡 × 2 条执行记录（365346 B） | 0.43 ms | 约 0.2 ms |
| 400 张卡 × 20 条执行记录（1830946 B） | 2.72 ms | 约 1.1 ms |

复核工作树上的另一次 smoke 窗口复现了同样的形状（ordinary 改造前 1.303 / 0.703 / 0.959 ms，改造后 0.622 / 0.253 / 0.213 ms；tail 改造前 5.884 / 4.597 / 4.352 ms，改造后 1.724 / 1.331 / 1.135 ms），并与恒等返回对照跑出的数值同档——这正是「复制已经消失」而非「只是更便宜」的证据。深拷贝是瞬时分配而非保留物：强制 GC 后 ordinary 形状读取后的堆为改造前 1420824 字节、改造后 1203744 字节，tail 形状两者相等。

## Alternatives considered

- **直接返回账本自己的数组**：否决——它彻底取消了隔离边界。下述守护在它上面失败，而且两半都失败，因为两次读取返回的是同一个数组。
- **`structuredClone(tasks)`**：否决——与它要替换的 JSON 往返同级成本，读取依旧和改造前一样贵。
- **浅拷贝 + 给每条记录 `Object.freeze`**：否决——冻结必须覆盖写路径产生的每一个对象，包括 `repairParentLinks` 与 `retainRecentExecutions` 的重建结果，那是对写路径的行为改动，而本次改动只有包内验证兜底，覆盖不到；它防的是没有任何消费者会做的记录级改写。
- **只在 HTTP 边界复制**：否决——`state()` 在进程内还有路由之外的消费者：agent 工具六次触达该快照，`applyBoardAction` 也从中读一张卡；把复制挪进 handler 只会把这些别名继续指向文档。
- **用 `readonly TaskRecord[]` 收窄类型来替代复制**：本次未采用。它是在编译期让记录级改写不可能发生的正确做法，但 `LedgerState.tasks` 会流入 `TaskBoardSnapshot.tasks`（`protocol.ts`），收窄会溢出本模块。
- **改动 `summary()` 或 SSE 帧**：否决——它们本来就不复制，没有可移除的东西，而帧的行为本身属于「不得移动」的部分。

## Consequences

一次任务板读取交出的新数组，其记录是账本自己的对象。两种形状的响应体与改造前逐字节一致，唯一差异是 `scheduler.lastTickAt`——每个进程在挂载时写进自己调度快照的心跳时间，不属于任务负载。

残留边界被记录而不是被防御：原地改写某条记录的调用方（`state.tasks[0].title = 'x'`）仍会触到账本。本包没有这样的消费者；当需要让它不可能发生时，升级路径是把 `LedgerState.tasks` 与 `TaskBoardSnapshot.tasks` 收窄为 `readonly TaskRecord[]`，那一步留在本模块之外。

读取路径仍然无缓存：重复读取依旧要付 handler 的那次序列化。被去掉的是每次读取都会重复的那次复制。

## Testing

`tests/host-ledger.spec.ts` 中有两条确定性守护，不使用计时器或时间预算。第一条把一次读取返回的数组清空并塞入新卡，断言下一次读取仍然报告账本自己的卡。第二条读取两次，断言两个数组是不同的对象、而其中的卡是同一个对象——每次读取一个新容器，且不重建文档。

三路负对照钉住了守护能失败在什么上。对深拷贝实现，记录同一性守护失败（`expect(second[0]).toBe(first[0])`），而隔离守护通过——深拷贝的隔离强于所需，那正是本次改动去掉的代价。对恒等返回（`return tasks`），两条守护都失败。对最终的 `[...tasks]`，两条都通过。

`pnpm --filter @linxin666/dsh-client-ui-task-board test` 通过 956 个用例中的 955 个（1 个跳过），该包 typecheck 与 build 通过。字节等价证据取自改动后源码的重新构建，该 bundle 的摘要与复核分支上的已提交产物一致。

最接近的既有记录是 [Task-board roster polling stands down on an idle board](../bug-fix/2026-10-06-task-board-idle-roster-poll.md)（拥有宿主侧轮询成本门控）与 [Task-board client render and lineage-gate costs](../bug-fix/2026-09-28-task-board-client-render-and-lineage-costs.md)（拥有浏览器半区的渲染成本）。两者都不拥有账本的读取契约：前者决定名册何时被读，后者决定浏览器重新推导什么，而本条决定一次读取交给调用方的是什么。因此这是一份新记录，而不是对其中任一条的编辑。
