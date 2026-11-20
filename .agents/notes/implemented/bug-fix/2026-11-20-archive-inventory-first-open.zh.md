# Agent Note: Archive panel first open — prewarm, honest loading state, real refresh

Status: implemented

## Problem

DSH 重启后第一次打开会话归档管理（已归档会话列表）会在空列表上卡好多秒，刷新按钮也经常毫无变化：

1. 整响应库存缓存（`inventory-response-cache.ts`）开机即冷，第一次打开要内联付掉整整 11–35 秒的重建——而列表区这段时间一直渲染「没有会话」（`arch.empty`），因为 loading 状态从未区分「还在加载」和「加载完了但确实是空的」。
2. 刷新就是一个普通 `GET /inventory`。15 分钟 TTL 内服务端原样返回保留字节（`x-dsh-inventory-cache: hit`），TTL 外 stale-while-revalidate 也是先吐保留字节。再加上每会话 projcache 文件 memo（`projcacheFiles`）自身没有 TTL——某趟构建之后才落盘的标题，在下一次变更清掉 memo 之前永远不可见。普通刷新因此永远捡不到迟到的标题。

没有存活 projcache 文件的空白无标题会话（236 行，其中 230 行在备份归档下）是数据真相，不是本 bug：刷新变不出标题。范围裁定（用户，2026-11-20）：只修代码，备份标题文件不动。

## Decision

在 `@linxin666/dsh-session-archive` 里三处协同改动：

1. **开机预热。** `ArchiveService.start()` 挂一个后台尝试（`PREWARM_DELAY_MS` = 5 秒，让开机追赶 tick 先拿到事件循环；`sessionController` feed 面还没起来时按 `PREWARM_RETRY_MS` = 1 秒重试，上限 `PREWARM_MAX_ATTEMPTS` = 30），调用新增的 `InventoryResponseCache.prewarm()`——已有快照或已有构建在飞时是无操作，否则在没有读者等待的情况下 `kick()`。就绪门必须存在：feed 缺席时跑全量构建会把纯磁盘快照（每行都带 `unreadable`）缓存一整个 TTL 窗口，比不预热更糟。`stop()` 清掉定时器。
2. **诚实的加载态。** 卡片空态分支在 `status === 'loading'` 时渲染 `arch.loading`，其余情况才渲染 `arch.empty`；`setStatus` 保留 inventory，刷新期间已上屏的行不会消失。
3. **真刷新。** `GET /inventory?fresh=1`（解析方式同 `seal-check` 的 `recheck`）路由到新增的 `ArchiveService.inventoryFresh()`：清掉无 TTL 的 `projcacheFiles` memo 和两个 2 秒索引 memo，然后等待 `InventoryResponseCache.rebuild()`——`invalidate()`（丢弃代数、中止在飞构建），再 `kick()` 并等这一次构建。发起者付重建的钱；期间到达的其他读者仍立即拿到保留字节，所以 taskbot 的 10 秒轮询永远不会排在点击后面。客户端刷新按钮走 `controller.load({ fresh: true })` → `api.inventory({ fresh: true })`，超时 45 秒（路由以构建自身的 30 秒中止为准收尾，客户端必须活得更久才能看到服务端错误）；首载和批处理后的自动重载保持普通读。

## Testing

- `inventory-response-cache.spec.ts`：prewarm 在没有任何读者时落一次后台构建、首读是对它的 hit；已有快照时 prewarm 是无操作、与在飞构建合流而不是另起一次；`rebuild()` 返回新字节（绝不是保留体）且窗口随行，并发读在它等待期间仍拿保留字节，刷新中途被失效中止时换代重试且被中止的尝试不计数。服务级：start 在任何读者发问前就发出一次构建（假时钟），feed 面门把构建推迟到面应答之后，迟到标题只经 `inventoryFresh()` 可见、普通读永远看不到。
- `routes.spec.ts`：`?fresh=1` 返回含迟到标题的重建文档（头 `miss`），它之前的普通读保持窗口（`hit`，标题仍缺），其后的普通读 hit 到重建字节。
- `controller.spec.ts`：fresh 加载等待期间旧行不下屏、向 api 传 `{ fresh: true }`、重建载荷落地后换入。
- `card-loading.spec.tsx`（新增，jsdom）：首载在飞时显示 `arch.loading` 而非 `arch.empty`；落地后零行显示 `arch.empty`；刷新按钮请求 `{ fresh: true }` 并显示 `arch.refreshing`；刷新等待期间行永不闪空。
- 包级门：`pnpm --filter @linxin666/dsh-session-archive test` 全绿（332 个测试）；`tsdown` 重建落进 profile 硬链接的 `lib/`（`index.js`、`client.js` 的 sha256 仓内 == profile）。

## Alternatives considered

- **恢复 230 个备份标题文件**让无标题行长出标题。被范围裁定否决（2026-11-20）：这些会话在存活存储里本来就没有标题，刷新变不出来；为改列表门面去改写备份归档，会破坏备份赖以存在的历史记录。
- **拆掉响应缓存、每次读都重建。** 否决：一次重建 11–35 秒，而 taskbot 每 10 分钟轮询一次、超时只有 10 秒——拆掉缓存等于把每轮轮询变成 fail-closed，正是这个缓存当初要防的事故。
- **每次 GET 都清 `projcacheFiles`，或给它一个短 TTL。** 否决：每趟构建都要重读每会话 projcache 文件——正是 memo 要省掉的大头成本——而它防的陈旧窗口只有点刷新的人在乎。memo 维持「变更时清 + `inventoryFresh()` 显式清」。
- **点击时改成失效后吐保留字节，而不是 `rebuild()`。** 否决：那会用用户正要求绕开的字节回答点击——即观察到的「刷新没效果」。发起刷新的读者必须等新构建，其他人继续用窗口。
- **start() 无条件预热、不加就绪门。** 否决：feed 面挂载前跑构建会把纯磁盘快照缓存一整个 TTL 窗口；重试到面应答只花一个定时器，就消掉了这个失效模式。
- **批处理后的自动重载也走 fresh。** 缓办：那会让每批操作都以内联 10–35 秒重建收尾。刷新按钮已能确定性救回列表，批处理对话框也已逐条报告结果；普通重载维持原样——窗口已失效，后台重建照常落在其后。

## Consequences

- 预热赶在点击之前落地时，重启后的首次打开是 hit；点击更早时会与预热的构建合流，而不是另起一次。
- 刷新点击是唯一刻意付重建的读（上限为路由的 30 秒中止，以可重试错误呈现）；并发 taskbot 轮询保持亚毫秒读。
- 迟到标题在刷新时可见，而不是等到下一次变更；真正无标题的会话照旧显示为无标题，设计使然。
- 预热的降级是显式的：30 次尝试（feed 面始终不应答）后放弃，首次打开回到内联付费，和从前一样。
- `x-dsh-inventory-cache` 词表不变——显式 fresh 重建报 `miss`、`age` 为 0，因为这次读付钱拿到了新字节。
