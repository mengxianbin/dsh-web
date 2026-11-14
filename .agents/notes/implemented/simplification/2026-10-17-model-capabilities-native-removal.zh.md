# Agent Note: 移除 dsh-model-capabilities

Status: implemented

完全取代 [自定义 pi-ai 供应商的逐模型能力声明](../feature/2026-09-08-model-capabilities-plugin.md)：它所引入的包已从源码树与聚合包中删除。特性记录保留，作为该能力当初为何如此构建的记载；本记录拥有移除决策及移除所明知放弃的内容。

## Problem

SDK 0.2.1-rc.2 cohort 使 `dsh-model-capabilities` 成为重复实现。官方 Models 页现在原生编辑该包赖以存在的两个字段——自定义 pi-ai 供应商的逐模型输入类型与推理等级——于是该包的 provider-card 面板在同一个 `llm-pi-ai` 设置文档之上重新实现了一个原生编辑器。保留它意味着家族要在一个官方命名空间上维护第二个编辑器，keyed-cell 认领协议与整数组写入路径成为永久的重复成本。该包的第二项能力——带归档的供应商停用/启用——没有原生替代，只存在于本家族。已明确询问用户，用户选择整包退场而不是迁移切换能力，并接受归档/切换能力离开产品。

## Decision

整个包 `packages/dsh-model-capabilities`（`@linxin666/dsh-client-ui-model-capabilities`）被删除：源码、测试、README 三件套、`cordis.patch.yml`、构建配置、聚合 `patchFrom`/`deps` 条目与 `web-ui-model-capabilities` cordis 行、i18n 审计包条目、`dsh-i18n` 中其命名空间的 ru 字典，以及 publish-prep 包表行（家族发布包从 17 个减为 16 个）。没有任何能力逻辑被迁移到新宿主：逐模型输入/推理编辑让位给原生 Models 页编辑器；供应商停用/启用归档让位给官方 Remove-provider 按钮——它执行与该插件相同的 `unset llm-pi-ai.providers.<route>`，但不做任何归档。

一条兼容接缝保留下来：聚合保留 `model-capabilities` tombstone——`./model-capabilities` shell 子路径导出仍可解析到共享 shell 重导出，并携带生成的 `shell-metadata/model-capabilities/locale/{en,zh}.json` 与共享 `icon.svg` 目标，因此记录了 `@linxin666/dsh-web-all/model-capabilities` 行的既有 profile 可以继续 import，不会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。没有任何东西被挂载：tombstone 是惰性兼容行，与已退场的 `dsh-perf`、`describe-image`、`doctor` 家族同一模式。

## Alternatives considered

- **把该包保留为原生编辑器之上的薄皮。** 否决：原生编辑器覆盖了该包赖以存在的两个字段，面板将成为同一设置文档上的第二个编辑器，而 keyed-cell 认领机制（冲突提示、重试闩、footer 兜底）会继续消耗表面却零增量能力。
- **删除能力面板，但把供应商停用/启用归档迁到另一个家族包。** 被所有者否决：切换能力是该包的差异点而非附属载荷，退场它是用户明确做出的产品决策，而不是一个靠搬家就能保住的实现细节。迁入别包还会把 `llm-pi-ai.providers.<route>` unset 加归档编排偷偷塞进一个既不拥有 Models 页也不拥有供应商命名空间的包。
- **继续发布该包但不挂载。** 否决：一个不挂载的已发布包仍背负 README、registry listing 与更新检查噪音，而其能力已由原生页面提供；家族刚按决定缩减发布集——休眠包是两种坏处兼得。
- **随包一起移除 tombstone 导出。** 否决：既有 profile 记录的是 `@linxin666/dsh-web-all/model-capabilities`；删掉该导出会让每个这样的 profile 在启动时遭遇模块解析错误。tombstone 只花一条 exports 条目和两个生成的 locale 文件，正是既有的退场模式。

## Consequences

- 自定义 pi-ai 模型的输入类型与推理等级改由原生 Models 页编辑器提供；能力不退化，而是换了属主。Models 页的文案与行为从此归官方。
- 停用供应商现在是官方 Remove-provider 写入且不留归档：被移除路由的配置无法再从家族表面恢复，路由重新出现时从空配置开始。这正是用户明确接受退场的能力。
- 家族不再认领 `settings.models.provider-card` keyed cell，家族插件不可能再在那里冲突；认领协议（点名占用者的拒绝、卸载后重试）随唯一使用它的包一起退场。
- 聚合发布 16 个家族包；`scripts/verify-version.mjs`、publish-prep 表、i18n 审计包清单与聚合一致性测试都去掉第十七个。
- `shell-metadata/` 树与 `./<family>/icon`、`./<family>/locale/<lang>.json` 导出是本移除与 0.2.1-rc.2 cohort 适配共有的新生成产物；`model-capabilities` 子路径是第一个纯以 tombstone 保留的条目。
- 行 id 有意不立 tombstone。经插件管理器的逐行开关记录过 `web-ui-model-capabilities` 的 profile 会带着一条指向无人声明 id 的覆盖，loader 每次启动都会为此告警但照常组合；改由插件管理器的更新路径清理这条失效覆盖，而不是让聚合包永久声明一条什么都不挂载的行（[失效行覆盖清理](../bug-fix/2026-10-17-plugin-manager-orphan-row-override-pruning.zh.md)）。

## Testing

- 包目录已从工作树消失（`git status` 显示整树被删除），且除 tombstone 导出条目外，没有任何家族清单、profile fixture 或脚本引用 `@linxin666/dsh-client-ui-model-capabilities`。
- `packages/dsh-web-all/tests/shell-subpath.spec.ts` 钉住 tombstone：`exports['./model-capabilities']` 解析到 `./lib/shells/shell.js`，其 `icon`/`locale` 键均可解析。
- `packages/dsh-web-all/tests/children-consistency.spec.ts` 与 `pnpm aggregate:check` 证明聚合可在无此包的情况下重新生成并保留 tombstone 元数据。
- 移除改动的仓库门禁：`pnpm typecheck`、`pnpm test`、`pnpm aggregate:check`、`pnpm docs:check`（README 对与 publish-prep 已更新）、`pnpm i18n:check`（ru 字典与审计清单已更新）、`pnpm test:scripts`。
- 在 0.2.1-rc.2 宿主重启后原生 Models 页编辑器的现场 GUI 核验仍由维护者负责；移除本身由构造保证（原生编辑器是官方表面）加 cohort 适配的挂载冒烟来验证。
