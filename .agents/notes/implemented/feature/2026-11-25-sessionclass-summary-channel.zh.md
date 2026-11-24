# Agent Note: 会话分类走上列表通道（sessionClass 摘要投影）

Status: implemented

## 问题

悬停卡的会话类型行（hover-sessionclass-1121）经页面级懒加载单例读 `GET /api/session-dispatch/attention`：第一次悬停触发请求后才出现，且一次失败就把缓存永久定格为缺席——这一行可能整页生命周期消失，而它旁边的会话 id（随 `SessionSummary` 下发）首帧就在。每次刷新都重演等待。分类本身从无疑问：注意力账本（见[会话身份三值化](2026-10-29-sessionclass-triclass.zh.md)）存着全部已记录分类，端点 3.6–28 ms 即应答（2026-11-25 实测，818 类，45 817 B）。问题在通道——为一个列表本来就携带的事实，另开一条懒加载的每页拉取。

## 决策

- **经新 `sessionClass` 投影把分类折入 `SessionSummary`**（dispatch `src/host/class-projection.ts`）：记录类型 `plugin:session-dispatch/attention` 载 `{ class }`，单元状态 `SessionClass | null`（init `null`、后记录覆盖、坏载荷跳过、恒等视图），`wire.summary` 默认 true，使该值与会话 id 并肩走列表的投影列。
- **两个写入方、一个事实源（账本文件）**：每次账本写入触发新的 `onClassSettled` 缝——`syncById` 在存储里解析 id 并向活会话追加（`stateOf` 去重；冷会话不动作）。每次启动一次：启动 pass 落定且投影单元挂载后，回填 pass 遍历 `classes()`：存储命中即按上法同步；冷会话在 `cachedSnapshot` 已带该值时零 I/O 跳过，否则一次写打开追加（仅当日志缺该记录）加 `coldSnapshot` 刷新检查点。检查点刷新是必需的：`staleCheckpointKeys` 刻意跳过缺席行，新键永远不会触发控制器的冷修复，只写日志的回填会让所有存量会话永远空白。逐会话 fail-open、会话间让步；先挂载后回填的顺序保证重折看见已注册单元。
- **archive 悬停行读列表快照**：`SessionClassLine` 接标准 `useSessions` 钩子，选 `byId[sessionId].projectionValues.sessionClass` 并收窄到三值——无拉取、无 effect、安静缺席不变。行/列表/钩子类型在客户端文件里结构化重述，因为本包把 host 与 client 编进同一个 tsc 程序，ui-session / api-session-controller 客户端的 `sessions` Context 合并会与宿主 `dsh-session` 合并相撞（包内注释记录了刻意不导入；git-graph 的 `import type {}` 技巧需要拆分程序）。
- **`GET /api/session-dispatch/attention` 保留**为诊断读面：退役的只是客户端拉取层——归档身份表读账本文件，不读该端点。

## 备选与否决理由

- **保留拉取、列表加载时预取**（A 案）：否决——为列表本就传输的事实保留第二条通道，一次坏响应仍会永久定格为缺席，还给每次页面加载加一个往返。
- **保留悬停时拉取、只把缓存做厚**（B 案）：与 A 一并否决——结构性缺口（类型不在列表通道上）仍在，而这正是抱怨本身。
- **改由列表冷修复触发检查点、不回填**：否决——`staleCheckpointKeys` 按契约跳过缺席行（「缺席键不欠任何东西」），新键永远不会被 cue；该回写由回填承担。
- **在 archive 包导入真实 `SessionListState`**：否决——单 host+client tsc 程序在 `sessions` Context 合并上相撞；结构化重述携带同一运行时值，零导入边。

## 后果

- 安装后首次启动对每个已记录会话做一次全读 + 重折（数百个；数秒到一分钟，异步、让步、fail-open）。回填中途拉到的行在下一次列表对账时取到分类；此后每次启动走零 I/O 快速路径。
- 每个存量会话恰好多一条追加快记录——快速路径与日志扫描保证后续启动不再追加，日志中的分类恒为账本当前值。
- 端点继续服务（对其他读方零回归）；任何失败都降级为「行缺席」，绝不出现横幅或重试环。
- 首次悬停延迟彻底消失：该行从行本就持有的同一份快照渲染，类型与 id 同时到达。

## 测试

`packages/dsh-session-dispatch`：新增 `tests/class-projection.spec.ts`（18 例：折叠纯度——init/后覆盖/同引用/坏载荷跳过/wire schema——外加快速路径跳过、追加 + flush + 重折顺序、仅刷检查点、重折抛错仍 close、服务缺席、活存储同步、非三值丢弃，以及挂载/去重/存储探测行为），`tests/attention.spec.ts` 增 5 例 `onClassSettled`（只在写入时触发、declare、pending 重试、非成员静默、抛错缝）——170/170。`packages/dsh-session-archive`：`tests/session-class-hover.spec.tsx` 围绕 `useSessions` 桩重写（注册保留，三值渲染，记录/行/钩子缺席，非三值），删除 `src/client/session-class.ts`——343/343。两包 `typecheck` 通过；收口时五门全绿（2026-11-25）。
