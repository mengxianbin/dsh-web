# Agent Note: 把看板卡片席位收进共享的插件卡助手

Status: implemented

## Problem

`packages/dsh-task-board/src/client/board-card-seat.ts`（102 行）是 `shared/client/settings/plugin-card-seat.ts` 中 `installPluginCard` 的第二份实现。两段 reconcile 循环是同一份代码——经 `familyGroupLoaded` 选席位、重入闩锁、在 `slots/changed` 时先释放再重注册、拒绝注册时的告警——只有一处不同：看板那份会把 `children` 声明转发给两个席位注册分支。

包装模块自己的文件头写明了意图："it should collapse back into the shared helper once that helper accepts children"。它只有一个调用点，`packages/dsh-task-board/src/client/index.ts:241`，在那里注册看板的设置卡并声明 `children: { 'task-board.settings.section': { kind: 'list', scope: 'root' } }`——即 provider 渲染进去的席位，由[扩展契约](../../implemented/architecture/2026-09-30-task-board-extension-contract.md)声明、由 `TaskBoardSettingsCard.tsx:519` 消费。

席位的决策记录同样已与已发布事实脱节。[席位记录](../../implemented/bug-fix/2026-09-17-family-plugin-card-seat-follows-the-loaded-group.md)仍把 `settings.plugin.item` 写成官方 keyed 席位，而该席位已在 0.1.6-alpha.2 cohort 中被移除——助手今天回退到 `plugins.bundle.config`，见 [cohort 记录](../../implemented/architecture/2026-09-17-sdk-cohort-0.1.6-alpha.2.md)——它也仍把 `doctor` 与 `tool-describe-image` 列在"共同改变席位行为的五个包"里，而这两者已于 2026-09-23 离开家族。

代价不只是重复的行数。由于看板入口从不调用 `installPluginCard`，该包内同步副本自己没有任何调用方，于是家族的席位决策被维护在两处，改一处必须手工对照另一处。

## Decision

共享的 `PluginCardSeat` 增加可选的 `children: Record<string, unknown>` 字段，并以助手已用于 `order`、`label`、`inject` 的条件展开形式在两个席位注册分支转发。`packages/dsh-task-board/src/client/board-card-seat.ts` 已删除，`packages/dsh-task-board/src/client/index.ts` 改为经 `installPluginCard` 注册它的设置卡，并为 `task-board.settings.section` 保留同样的 `children` 声明。

席位选择、重入闩锁、`slots/changed` 对账与拒绝告警都归共享助手，因此家族里"卡片如何选席位"只剩一份实现，而看板包内那份同步副本终于有了调用方。

双语[席位记录](../bug-fix/2026-09-17-family-plugin-card-seat-follows-the-loaded-group.md)已刷新：它写的官方 keyed 席位是 `plugins.bundle.config`（0.1.6-alpha.2 cohort 移除了 `settings.plugin.item`），共享该决策的包就是 manifest 里列出的那三个。

## Context & Efficiency Impact

没有运行时、wire 或配置变化：看板卡片在 `dsh-web-settings` 已加载时仍注册进家族列表席位，否则注册进 `plugins.bundle.config`，仍然声明 provider 席位，也仍然在家族组后加载时迁移。该改动删除 102 行手写代码与一个模块，换来共享源中的一个可选字段与三份重新生成的副本。

收益是"家族卡片如何选席位"只剩一份实现，而且正是另外两个消费方与席位 spec 已经在验证的那一份。

## Evidence

- `shared/client/settings/plugin-card-seat.ts:131-191`（`installPluginCard`）与 `packages/dsh-task-board/src/client/board-card-seat.ts:49-102`（`installBoardCard`）是同一段 reconcile 循环；唯一的结构差异是看板第 75、82 行的 `children: seat.children`。
- 合并意图写在该包装自己的文件头（`board-card-seat.ts:5-10`）。
- 调用点：`installBoardCard` 只出现在它的声明、`packages/dsh-task-board/src/client/index.ts:36`（导入）与 `:241`（调用）。`installPluginCard` 的在线调用方是 `packages/dsh-remote-web-ui/src/client/index.ts:313` 与 `packages/dsh-liangshen/src/client/index.ts:202`，另有专门的 spec `packages/dsh-remote-web-ui/tests/plugin-card-seat.spec.ts:62-114`。
- 在 `packages/dsh-task-board/src` 中搜索 `plugin-card-seat`，只命中该包装的导入：包内没有别处读它的同步副本。
- 子席位是在用的：`packages/dsh-task-board/src/client/index.ts:110` 声明 `task-board.settings.section`，`packages/dsh-task-board/src/client/TaskBoardSettingsCard.tsx:519` 经 `renderSlot` 渲染它，`packages/dsh-task-board-github/src/client/index.ts:63` 向它注册。
- 在 `implemented`、`rejected` 与 `archived` 记录中搜索 `board-card-seat`、`installBoardCard` 与 `installPluginCard`，没有依赖该包装存在的决定；拥有席位契约的记录要求保留子席位声明，而共享助手保留了它。
- 席位记录本身的文字即可见其漂移：`2026-09-17-family-plugin-card-seat-follows-the-loaded-group.md` 在 Decision 中写着已被移除的席位键，在 Consequences 中数出五个消费包，而 `shared/client/settings/plugin-card-seat.ts:45` 导出的是 `plugins.bundle.config`，同步清单也只列了三个包副本。

## Alternatives considered

- **保留包装，把看板卡片当成特例。** 否决：真正的特殊之处只是一个可选字段，其余部分是每次共享席位决策变化都必须手工同步的拷贝。
- **把 `children` 设为共享类型的必填字段。** 否决：dsh-remote-web-ui 与 dsh-liangshen 都不声明子席位，必填字段会迫使两个调用点填入空声明，白白改动它们的注册。
- **在共享源中新增第二个导出安装器，而不是扩展已有的那个。** 否决：同一套席位决策上的两个安装器，恰好会重新制造本提案要消除的漂移，副本还会变多。
- **让看板自带席位常量而不使用家族助手。** 否决：席位键与家族组探测是所有家族卡片必须共用的一份决策；逐包复制正是"卡片落进错误席位"的来源。
- **同时合并看板其余本地席位助手**（settings-entry-form 绑定与 task-board-github 卡片）。暂缓：它们今天没有共享对应物，为它们新建一个反而要加清单条目，是增加义务而不是消除义务。

## Testing

- `node scripts/sync-shared.mjs --check` 通过，三份消费方副本都带有可选的 `children` 字段。
- `packages/dsh-task-board/src/client/board-card-seat.ts` 不再存在，`packages/dsh-task-board/src/client/index.ts` 经 `installPluginCard` 注册卡片，并保留同样的 `children` 声明。
- 看板设置卡在家族组已加载时仍注册进 `web-ui.plugin.item`、否则注册进 `plugins.bundle.config`，仍声明 `task-board.settings.section`，也仍在家族组后于看板加载时迁移席位；`packages/dsh-remote-web-ui/tests/plugin-card-seat.spec.ts` 保持绿色。
- `dsh-task-board` 与另外两个消费方的 `pnpm typecheck` 与 `pnpm test` 通过，浏览器 bundle 的 react / 仅类型导入规则不变。
- 由于 `dsh-web-all` 会内联子插件的 client 源码并提交 `lib/`，需要重建聚合包并重录指纹（`pnpm build`、`pnpm libs:write`、`pnpm libs:check`）。
- 席位记录所写的官方席位键与真正回退到的一致，且只列仍然发布该决策的三个包；其余事实与它的 alternatives 保持不动。

## Risks

- 共享类型对三个消费方都变宽了。某个不该声明子席位的卡片只能选择不填该字段，没有任何机制强制这一点。
- 看板卡片失去了包内逃生口：未来某个 cohort 若改动官方席位键，看板会与另外两个消费方一起变，而不能再独立处理。这正是本意，但确实是一处真实耦合。
- 若某次注册收到 `children: undefined`，就绝不能发出该字段；条件展开正是让官方 keyed 席位的载荷与今天逐字节相同的原因，草率改写成普通属性会改变注册对象。
- 聚合 bundle 只有重建后才正确，因此跳过 `pnpm build` 的改动会让页面继续跑旧的卡片注册。
