# Agent Note: 把四个单消费方共享模块合并回各自的消费方

Status: implemented

## Problem

`shared/` 是家族的跨包事实源：`scripts/sync-shared.mjs` 把每个模块作为生成文件复制进各消费包，副本一旦与源漂移，`pnpm test:scripts` 就会失败。现在有四个清单条目的消费方只剩一个。

| 共享源 | 行数 | 唯一的消费方副本 |
| --- | --- | --- |
| `shared/host/poll-guard.ts` | 108 | `packages/dsh-git-graph/src/host/poll-guard.ts` |
| `shared/host/git-runner.ts` | 123 | `packages/dsh-git-graph/src/host/git-runner.ts` |
| `shared/client/sse-leader.ts` | 121 | `packages/dsh-git-graph/src/client/sse-leader.ts` |
| `shared/host/legacy-migration.ts` | 63 | `packages/dsh-plugin-manager/src/host/legacy-migration.ts` |

这四者都被维护了两遍——一份共享源加一份逐字节相同、只多一行头注释的生成副本——每次改动都要跑一次同步，并由漂移门禁为一个消费方守着第二份拷贝。

它们原本的第二个消费方是在更早的移除中被删掉的，当时清单条目只是缩小而没有被退役。[移除 aionui-panel](../../implemented/simplification/2026-08-28-remove-dsh-aionui-panel.md) 删掉了该面板持有的 poll-guard、git-runner 与 sse-leader 副本，`b6fea32d` 把 git-runner 的 targets 从两项改写成一项；[移除 dsh-doctor](../../implemented/simplification/2026-09-23-remove-dsh-doctor-and-describe-image.md) 则连同整包删掉了 `packages/dsh-doctor/src/agent/legacy-migration.ts`。

没有任何卫星仓持有这四个模块，因此它们都不是本仓发布给卫星的规范定义。而这正是[死共享产物记录](../../implemented/simplification/2026-09-26-dead-shared-artifacts-removed.md)在删掉消费方副本后仍保留 `shared/host/run-guarded.ts` 的理由，此处并不适用。

Doctor 的移除还留下了四处对已删消费方的描述，如今已与已发布事实相矛盾：

- `shared/host/legacy-migration.ts` 及其生成副本仍称该映射"由插件管理器更新任务与 Doctor 预检启动器共用，以免彼此漂移"。
- [旧聚合包自动迁移记录](../../implemented/feature/2026-08-24-automatic-legacy-aggregate-migration.md)仍把 Doctor Launcher 当作启动路径的实现，并称该映射"同步进两个消费方"。
- `docs/publish-prep.md` 仍把 Doctor 迁移及其受限 `cmd.exe` shim 描述为冻结契约的一部分。
- `docs/architecture.md` 仍列出一个 `shared/client/` 已不再持有的 `sidebar-entry` 客户端模块，`packages/AGENTS.md` 也仍把 poll-guard 列为家族共享模块。

## Decision

这四个模块现在各自只有一个家。`packages/dsh-git-graph/src/host/poll-guard.ts`、`packages/dsh-git-graph/src/host/git-runner.ts`、`packages/dsh-git-graph/src/client/sse-leader.ts` 与 `packages/dsh-plugin-manager/src/host/legacy-migration.ts` 是去掉生成头注释的手写源文件；`shared/host/poll-guard.ts`、`shared/host/git-runner.ts`、`shared/host/legacy-migration.ts` 与 `shared/client/sse-leader.ts` 已删除，`scripts/sync-shared.mjs` 不再持有它们的条目，清单因此是 18 个源，门禁断言 106 份副本（客户端 43、宿主 46）。

三份 spec 随模块搬迁——poll-guard 与 git-runner 进入 `packages/dsh-git-graph/tests/`，legacy-migration 进入 `packages/dsh-plugin-manager/tests/`——相对导入改写为 `../src/host/`，`scripts/test-standards-baseline.json` 中它们的键换成新路径并保留原有计数。没有任何调用点改动导入。

比消费方活得更久的那些描述已修复：模块头注释、双语[旧聚合包自动迁移记录](../feature/2026-08-24-automatic-legacy-aggregate-migration.md)、`docs/publish-prep.md`，以及 `docs/architecture.md` 与 `packages/AGENTS.md` 的共享层段落；后者还写下了本次改动确立的规则：只有一个消费方的模块归该包所有，不进 `shared/`。

## Context & Efficiency Impact

没有提示词、schema 或运行时成本：四个模块的导出、消费方与行为都不变，wire、配置与持久格式也没有变化。该改动删除四个文件（415 行）、四个生成头与四个清单条目，清单从 22 个源降为 18 个。

收益在维护路径上。今天修改 poll-guard、git-runner、sse-leader 或 legacy-migration 的人要先写共享源，再跑 `node scripts/sync-shared.mjs`，而漂移门禁会永远守着第二份拷贝。改动之后 `shared/` 只包含至少两个消费方的模块，"这个为什么是共享的"可以直接从目录树回答，而不必去读清单。

## Evidence

- 清单里的单一 targets：`scripts/sync-shared.mjs` 第 78-84 行（poll-guard）、101-105 行（git-runner）、118-124 行（legacy-migration）、162-166 行（sse-leader）各自都是只含一个路径的 `targets` 数组。
- 消费方：`packages/dsh-git-graph/src/host/routes.ts:19`、`packages/dsh-git-graph/src/host/git-service.ts:15`、`packages/dsh-git-graph/src/client/api.ts:8` 与 `packages/dsh-plugin-manager/src/host/routes.ts:18`。
- 以 `poll-guard|git-runner|legacy-migration|sse-leader` 在 `packages`（`*.ts`、`*.tsx`）中搜索得到 11 行：四份副本、它们的生成头，以及上面四个导入点。没有任何其他包提到这四个模块。
- 同一搜索在 `shared` 中命中四个源与三份 spec（101、135、34 行）；在 `scripts` 中只命中 `sync-shared.mjs` 与 poll-guard、git-runner 的两个基线键。
- 在 `satellites/` 中按四个模块名逐一搜索均无结果；卫星持有的唯一共享宿主模块是 `run-guarded`。
- 历史：`b6fea32d`（"refactor: remove retired dsh-skins package and dsh-aionui-panel host archive"）把 git-runner 的 targets 改写为 dsh-git-graph 单一路径；`ef637f65`（"feat(aggregate)!: remove dsh-doctor and dsh-tool-describe-image from the family"）删掉了 Doctor 的 targets。

## Alternatives considered

- **保留这四个条目，把"共享模块只有一个家、家在 shared/"当作不变量。** 否决：这些副本各自只有一个读者，四个模块都不是卫星契约，而本仓已经在[死共享产物记录](../../implemented/simplification/2026-09-26-dead-shared-artifacts-removed.md)中移除过消费方已消失的共享产物。保留它们等于为每个模块继续维持一次同步、一个生成头与一条漂移断言。
- **搬迁模块但删掉 spec，而不是搬 spec。** 否决：poll-guard 的计时纪律与 git-runner 的子进程管道合计有 11 个真实用例，随模块搬迁可以零成本保留这部分覆盖。
- **不再复制，改为发布一个共享运行时包供各插件依赖。** 该方向已被[共享配对信任栅栏](../../implemented/simplification/2026-08-26-shared-pair-access-fence.md)对整个家族否决：各包必须能在不依赖 workspace 内部依赖链的前提下独立发布；本提案不重新讨论该决定。
- **把清单条目的 source 直接指向消费方副本，使源与目标同一个文件。** 否决：自我复制是空操作，条目、生成头规则与计数注释都还在，却什么也没有断言。
- **同时合并其余未同步的重复文件**（四份 `css-modules.d.ts` 变体与四对重复的 `vitest.config.ts`）。暂缓：它们是 5 到 32 行的逐包配置，重复既不影响阅读也不增加维护，为这几行引入一个共享目的地反而是新增机制。

## Testing

- `node scripts/sync-shared.mjs --check` 与 `pnpm test:scripts` 按新计数（106 份副本、43 份客户端、46 份宿主）通过，且 `shared/` 不再包含 `host/poll-guard.ts`、`host/git-runner.ts`、`host/legacy-migration.ts` 与 `client/sse-leader.ts`。
- `shared`、`dsh-git-graph` 与 `dsh-plugin-manager` 的 `pnpm typecheck` 与 `pnpm test` 通过；三份搬迁后的 spec 在新包的 vitest 工程中运行且用例数不变（4、7、3），`pnpm test:standards` 接受改写后的基线键。
- 四个模块对同样的导入方导出同样的符号；没有调用点改动。
- `pnpm docs:check`、`pnpm i18n:check` 与 `pnpm emoji:check` 通过，且模块头注释、双语迁移记录、`docs/publish-prep.md`、`docs/architecture.md` 与 `packages/AGENTS.md` 不再描述已移除的 Doctor 消费方或 `sidebar-entry` 共享模块。

## Risks

- 这四个模块未来若出现第二个消费方，必须把它们重新提取回 `shared/` 并添加清单条目。这正是死共享产物记录所偏好的信号，但这份工作今天并不存在。
- 三份 spec 换了包：`pnpm --filter dsh-git-graph test` 与 `pnpm --filter dsh-plugin-manager test` 现在承载它们，而 shared 套件在 `shared/` 重构时再也看不到它们。
- `scripts/sync-shared.test.mjs` 的计数与理由注释是手工维护的；若改动落地却不重写注释，未来读者可能以为某条目从未被审查过而把它加回来。
- 把 legacy-migration 的 spec 搬到它唯一的消费方旁边，意味着它只在该迁移继续发布时存在。若所有者日后彻底退役旧聚合包迁移（它的启动期那一半已随 dsh-doctor 离开），映射、消费方代码与这份 spec 应当一起离开。
