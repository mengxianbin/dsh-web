# Agent Note: 聚合包的退役插件登记改由清单生成

Status: implemented

## Problem

家族聚合包的故障隔离壳（`packages/dsh-web-all/src/shell.ts`）会跳过老 profile 里插件已退役的残留行：不挂载、不 import、不记账，于是一次正常退役不会进入 degraded 账本。这个跳过靠一份退役包名清单，而清单曾是壳旁边手写的字面量。手写清单会漂移。2026-09-23 移除 dsh-doctor 与 dsh-tool-describe-image 时删掉了两个包却没动它，于是仍带这两条行的 profile 穿过守卫落到 `await import(spec)`：包在工作区里已不存在，import 失败，`recordDegraded(spec, 'import', error)` 把一次有意退役变成 `GET /api/dsh-web-all/degraded` 上一条永久的「插件损坏」记录。后来的 model-capabilities 移除碰巧改了那份字面量，而这正是手工副本的失败方式：只有人记得时才对。

两个缺口让这种情况活了下来。没有测试覆盖本文要说的那个方向，即 shell-metadata 家族对 dependencies 与退役登记；既有的 children-consistency 只覆盖 patch 行对 `src/client/children.specifiers.json`。而 `node scripts/aggregate.mjs --check` 只逐文件比对期望内容，看不见某个 shell-metadata 家族目录或语言文件背后已经没有清单条目——`pruneShellMetadata` 只在写模式删它们。

## Decision

`packages/dsh-web-all/aggregate.yml` 新增 `retiredPlugins` 段：每个退役家族一条单行 JSON flow mapping，`{"family": "<tombstone 子路径>", "plugin": "<真实包名>"}`，风格与 `rows:` / `shellNotes:` 一致。清单是该列表的唯一事实源。

`scripts/aggregate.mjs` 解析该段、fail closed 校验，并生成 `packages/dsh-web-all/src/retired-plugins.generated.ts`，与它已经拥有的 client-children 模块并列。生成模块导出 `RETIRED_FAMILIES`（子路径到包名，按 family 排序）与 `RETIRED_PLUGINS`（全部包名，排序，由 `RETIRED_FAMILIES` 派生）。校验拒绝非字符串或空字段、不匹配 `^[a-z0-9-]+` 的 family、尚不在 tombstones 段里的 family、重复的 family 或包名，以及同时是本聚合依赖的插件。每一条都是报错而非告警，因为任意一条都会产出一个要么让启动崩溃、要么静默吞掉在役插件的壳。

`src/shell.ts` 从生成模块导入 `RETIRED_PLUGINS`，包进和过去由字面量构造的同一个 `Set`。守卫在 `apply()` 里的位置与语义不变。

校验方向补齐在三处：`scripts/aggregate.test.mjs` 钉住清单形状（每个 family 都是 tombstone、没有 plugin 是依赖、生成模块与清单逐条一致、issue 点名的两个包都在）；`packages/dsh-web-all/tests/retired-plugins.spec.ts` 钉住针对生成文件的运行时契约；`aggregate.mjs --check` 现在把清单不拥有的 shell-metadata 条目报为漂移，于是丢了行却留着目录与导出的家族会让门禁红，而不是绿。

## shell-metadata 家族恰好只有两个来源

`shell-metadata/<family>/` 是生成的展示元数据，其中每个目录要么由依赖承载（壳包装行经 `config.plugin`，直挂行经自己的 `name`），要么登记为退役。测试按两个方向断言这个相等关系：既没有承载行也没有登记条目的家族报错，而承载行或登记条目找不到目录也报错。正是这一点让两个事实成为一个事实。tombstone 不是残留物——它正是让老 profile 的 `@linxin666/dsh-web-all/<family>` 行仍可解析的那个导出，所以只有在 family 仍留在 `tombstones:` 里时条目才能退役，顺序反过来生成器直接拒绝。

## Alternatives considered

- 直接删掉五个退役 shell-metadata 目录与它们那二十条导出：否决。老 profile 命名这些子路径的行在插件代码运行之前就解析导出，删掉它把一次安静的空操作变成启动期的 `ERR_PACKAGE_PATH_NOT_EXPORTED`——对每个升级后没改过 profile 的用户都是启动级故障。tombstone 是兼容面而非死重，2026-09-23 的移除记录里已记过同样的否决。
- 继续手写 `RETIRED_PLUGINS` 字面量，只补两个缺失的包名：否决。事实（哪些家族已退役、各自曾是哪个包）本来就住在 tombstones 旁边的清单里；壳旁的第二份副本是一份已经漂移过一次的副本，修好今天的漂移并不能阻止明天的。从同一段生成模块让漂移在结构上不可能，而不是靠人记得。
- 只用测试校验登记、不教 `--check` 认识多余 shell-metadata：否决。只校验一个方向而由写模式修剪另一个方向的门禁会一直是绿的，缺失的测试与缺失的检查当初正是这样共存的。

## Consequences

新增一个退役家族是三次清单编辑（一条 `tombstones`、一条 `retiredPlugins`、一行 `shellNotes`）加一次生成器运行；壳不再需要人工编辑。`src/retired-plugins.generated.ts` 是两个壳入口产物的构建输入，所以过期的副本由 `pnpm aggregate:check` 与已提交的 lib 指纹发现，而不是由一次报出假 degraded 的启动发现。模块很小且在渲染期冻结，因此壳在运行时依然不依赖清单。

门禁现在会把清单不拥有的 shell-metadata 目录报为 check 漂移。这是有意的耦合：展示元数据、子路径导出与退役登记是同一份家族清单的三个视图，任一单独移动都会红。将来某个聚合包若只带 shell 元数据而不带壳包则不受影响——登记模块与多余项检查都限定在壳真正所属的那个包上。
