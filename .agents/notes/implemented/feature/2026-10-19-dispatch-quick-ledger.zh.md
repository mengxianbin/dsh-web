# Agent Note: dsh-session-dispatch 快账（taskRef 绑定 + 409 拒重派 + bindings 端点）

Status: implemented

## Problem

批量派发为每个任务创建一个会话，但没有任何持久记录说明哪个会话在执行哪个任务。任务板（git）与 dsh 运行时（workspace store）是两本靠人脑同步的账：派发会话中断后，已派任务即被遗忘；同一任务二次派发会静默地把工作劈成两半。最直观的修法——把 `session-xxxx` 回写进 git 板——在 worktree 隔离下不可行：多笔相互隔离的看板会话看不到彼此的 git 更新，板面永远无法充当实时占用账。真正需要的是一份机器本地的任务到会话绑定台账，附实时活性视图，外加一道拦截「会话仍活着就拒绝重派」的门。

## Decision

- **`POST /api/session-dispatch` 接受可选 `taskRef`**（不透明字符串，推荐形如 `<板路径>#<条目锚>`，至多 2000 字符）。携带它的派发在首条提示词排队后把 `{ taskRef, sessionId, workspaceId, title?, createdAt }` 记入 `$DSH_HOME/dispatch-bindings.json`。不带 `taskRef` 的派发行为与此前完全一致（向后兼容）。
- **409 拒重派门**：创建会话前，带 `taskRef` 的派发先查台账中该 taskRef 是否有仍活着的绑定；有则回答 `409 { ok, taskRef, sessionId }` 并点名既有会话。活性读 `$DSH_HOME/storages/workspace.json`（会话在某个工作区的 `sessionIds` 中且不在 `global.archivedSessionIds` 中即为活），因此归档会话即解除拦截，无需任何台账清理。
- **`GET /api/session-dispatch/bindings`** 提供全量台账，每条附实时 `alive` 布尔值。死绑定保留不删：台账记录发生过什么，死绑定的含义由调用方裁决。
- **台账处处 fail-open**：workspace store 读不通时放开 409 门而不是卡死派发；损坏的台账文件被隔离为 `<path>.corrupt-<epoch>`（留痕）并重建为空；绑定写入失败时回答 `200` 附 `bindingRecorded: false`，而不是把一次成功的派发变成错误。每次写入都走唯一临时文件 + fsync + rename，与 dsh-session-archive 的 ledger 同构。
- **台账是占用传感器，不是账本**。它落本地磁盘、绝不入仓；git 板唯一权威。这一边界句已逐字落在 m-note `dsh-session-dispatch` skill 的 2026-10-18 政策块旁。

## Alternatives considered

- 把 `[/] 🔗 session-xxxx` 回写进 git 任务板作为绑定账：否决——worktree 隔离的看板会话看不到彼此的提交，恰恰在并发最要紧时板面显示过期占用（这是 charter 初版思路，设计 v3 推翻）。板面仍可作为人类便利携带此类标注，但机器门不能依赖它。
- 把绑定存进 workspace store（与 `sessionIds` 同处）：否决——该 store 是 Host 拥有的 schema，扩展它会让本插件耦合其内部形态并牵连会话持久化机制。台账是插件私有，对 workspace store 只做结构化只读。
- 会话归档时事件驱动删除绑定：否决——归档插件跑在另一个进程，Host 随时可能被杀；事件删除会在漏事件时泄漏活绑定。因此活性在读取时从权威 store 现算，台账自愈。
- 绑定写入失败返回 500：否决——会话已创建且提示词已排队；台账的磁盘抖动不应让调用方误判派发失败而重试出重复会话。

## Consequences

- 409 响应体兼作回收句柄：执意重派的调度方可读出既有 `sessionId`，先归档或接管再派。
- 绑定只增不减（每个已派 taskRef 一行），每次记录全文件重写。在批量派发量级（几十到几百行）可忽略；若真无界增长，封顶或压实逻辑应落在 `FileBindingStore`。
- 活性计算把台账新鲜度系于 workspace store 的磁盘状态；Host 归档时更新该 store，传播延迟即一次读取。

## Testing

`tests/routes.spec.ts` 覆盖路由契约（taskRef 校验、绑定记录形态、409 带既有 sessionId、死亡后重派、无 taskRef 向后兼容、门 fail-open 与写入失败）。`tests/bindings.spec.ts` 以真实临时目录覆盖存储层（持久记录、活/死/归档语义、最新活者胜、损坏台账隔离留痕、workspace store 读不通 fail-open、原子写卫生）。46 个用例，加 `pnpm typecheck`、`pnpm build`、`pnpm sync-shared:check`、`pnpm docs:check` 全绿。
