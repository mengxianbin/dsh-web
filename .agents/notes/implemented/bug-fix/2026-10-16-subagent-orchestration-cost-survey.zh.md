# Agent Note: 子代理编排成本排查与无上限的级联扇出

Status: implemented

## Problem

「使用子代理会把 CPU 和内存顶上去」这件事，最显眼的嫌疑人早就被实测过了。此前那轮梯度测量（[多代理 GUI 卡顿，2026-08-23](../../../../docs/archive/perf-measurement-multi-agent-gui-lag-20260823.md)）给的是子代理**产出**的负载定价——worktree 安装、vitest、tsc——结论是内存压力与 swap 抖动，不是插件代码。没人定过价的是另一侧：**编排与观测**这么多子会话本身的开销，它随会话数增长，而不是随会话里的工作量增长。那正是 teammate 密集的工作流即使每个 teammate 都在空转也要付出的成本。

## Decision

`HostExecutionRunner.inspect` 里的会话历史重扫是本仓唯一被实测证实的扇出成本，已在拥有该备忘的决策记录中修复：[history 头部探测备忘](2026-08-26-inspect-head-probe-memo.md)。

其余被测过的部分一律不改，各自理由记在下面。本文唯一留下的缺口——run group 的无节奏扇出——已在它自己的记录里关闭：[run 启动准入](2026-10-16-task-board-run-launch-admission.md) 给「一次动作同时向 DSH 索要多少个会话」定了界，而没有改变 run group 开启什么。

## Measurements

**级联扇出无上限。** 驱动真实入口（`TaskBoardHostService.apply({ kind: 'run' })`）对着计数网关跑，得到的是确定性计数而不是计时：

| 子任务数 | `session/create` 调用数 | 同刻并发创建峰值 |
| --- | --- | --- |
| 3 | 4 | 4 |
| 40 | 41 | 41 |

链路是 `core/subtask.ts:190-198`（`cascadeTargets` 只限深度，从不限宽度）→ `host-ledger.ts:1291-1302`（一次提交里为每个成员各开一条 execution）→ `host-service.ts:1031-1039`（`dispatchRuns` 在循环里启动，没有 `await`）→ `:1051-1055`（`scheduleLaunch` 是 `void this.launch(...)`，发射即忘）。本包内没有任何兜底，运行时也不提供：`@deepseek-ai/dsh-subagent` 只声明递归深度（`maxDepth`）而没有扇出宽度，宿主 settings schema 里根本没有 subagents 键。唯一的约束是[多代理资源纪律](../../../../docs/multi-agent-resources.md)里写下来的那条。

**每 tick 的账本扫描是二次方，但定价远低于阈值。** `host-ledger.ts:1365-1387` 每 tick 每张卡调一次 `settleCascade`，而 `settleCascade` 自身是 O(tasks)，合计 O(G·M²·E)；实测 `finalizeReadyRuns` 在 416 张卡时 0.196 ms、1216 张时 1.763 ms（M ×2.92，耗时 ×9.0）。`reconcileExecutions`（`host-service.ts:770`）另加每条未完结执行一次线性 `getTask` 查找。1216 张卡时整个 tick 是 1.956 ms，按 5 秒节奏约合单核的 0.035%。

**git-graph 与 worktree 数量无关。** `runPoll` 迭代的是 SSE 订阅者，从不迭代仓库列表：每个 30 秒轮每订阅者 5 次 spawn 与 7 次 stat，在 K=1、8、32 个 worktree 下完全一致，且只触碰被订阅的那个仓库。比平坦曲线更重要的是灵敏度对照——把逐仓库扫描注入同一套 harness，同一个测量在 K=8 与 32 时变成 13 与 37 次 spawn，所以这个阴性是真阴性，不是仪器盲区。

**会话层两个包没有周期性路径。** 两个自动策略都取默认值时，janitor 的 tick 做零次遍历、零次 readdir/stat/readFile；打开它们则每 tick 恰好一次扫描。`dsh-usage` 的桶键是 日 → provider → model，没有 session 维度，`sessionRoutes` 是 `WeakMap`。唯一按会话只增不减的结构是 98 KB / 1211 项的 map。

**客户端受已渲染行数约束，不受会话数约束。** 聚合 shim 的每轮 frame 扫描在侧栏 0 行时 0.59 ms、832 行时 1.00 ms，上界是每帧一次（≤60 次/秒）——实测最坏情况约单核 6%，所以[插件变更合并成本](2026-09-11-combined-plugin-mutation-cost.md)那条否决继续成立，只是定价被刷新了。官方会话列表 store 是另一回事，也不属于本仓：一个已提交的会话事件会驱动 `handleControlFrame` → `notifier.markDirty()`，每次 `markDirty` 重建整份快照（遍历全部 summaries 与 projection stores 是 O(N)），且该路径落在 `projectionStore(sessionId)` 上，**不要求该会话已被 retain 或渲染**。因此 N 个后台 teammate 会以 step 粒度逐回合让整表失效。本仓侧的乘数落在一个卫星仓：`dsh-pet` 订阅该列表，并在每次失效时发一次 HTTP RPC。下面这点读自本机安装的 0.2.0-rc.2 包、而非实测：那次投影在每次失效时为每个会话分配一个全新的行对象，且 `set()` 无条件通知，所以增长的是分配 churn 而不是常驻内存。每个会话还会为客户端根的整个生命周期保留一个常驻投影 store，这把客户端内存按在**会话目录数**上——832 个会话时不到 1 MB——而不是按并发子代理数。

## Alternatives considered

**在本次排查里就地给级联扇出加上限。** 此处按「产品决策而非修复」延后：形态（拒绝、排队、还是按可配置宽度串行）会改变「一个 run group 开启它整棵子树」这一可观察承诺，因此该由用户来答，而不是由 agent 拍板。它随后被定为分批排队，并实现在 [run 启动准入](2026-10-16-task-board-run-launch-admission.md) 中；「拒绝」这一形态仍按上面的理由保持否决。

**新增 `maxConcurrent` 子代理设置。** 否决：本仓并不拥有子代理注册表（它在宿主侧），自造一个局部节流只会让写下来的纪律与真正的机制互相矛盾。

**把备忘扩展到 goal 运行。** goal 执行每个轮询都重走历史（实测每 tick 12 页），因为找到 `turn/end` 会删除备忘，而 `goalVerdict` 对 active 目标返回 pending。暂时否决：它需要在一个已结算的会话上增加第二种记忆，并改变判定所依据的材料，而 goal 运行在全局开关与卡片两级都默认关闭。

**在同一轮里顺手修掉二次方结算。** 按比例否决：1216 张卡时 1.76 ms 排不上风险，而级联结算被多条约束要求保持保守。

**把 shim 扫描按新增子树收窄。** 按与原始否决相同的证据否决：成本随 frame 大小而不是随 `:not([data-dsh-part])` 过滤走，侧栏子树范围的扫描只能从 1.0 ms 里收回约 0.03 ms。

## Consequences

inspect 的修复去掉了唯一真正随 teammate 数量增长的扇出成本。其余随会话增长的部分，要么在实测规模下可忽略，要么在本仓之外。任务看板仍然为一张卡片开启整棵子树，但不再在同一个 tick 里向 DSH 索要每一个会话：[run 启动准入](2026-10-16-task-board-run-launch-admission.md) 给这股突发定了节奏，那份计数过的复现如今守的是一个修复，而不是在描述一个开放隐患。二次方结算同样有具名的回归条件：按实测斜率，卡片数进入数千时它会落在每 tick 约 30 ms。

## Testing

`pnpm --filter @linxin666/dsh-client-ui-task-board typecheck` 与 `test`（1101 过 / 1 跳过）覆盖修好的 runner，外加拥有该备忘的那条决策记录中记下的聚焦回归。探针都是进程内的，已删除；客户端 harness 在仓库之外，未提交。
