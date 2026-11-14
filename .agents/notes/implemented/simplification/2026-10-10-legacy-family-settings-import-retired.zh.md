# Agent Note: 退役 dsh-web-settings 的旧版家族设置导入

Status: implemented

## Problem

`packages/dsh-web-settings/src/legacy-import.ts`（532 行）、它的 spec（487 行）、README 的一节，以及 `$DSH_HOME` 下一份带版本的磁盘文档，存在的目的是收养官方 0.1.7 设置子系统遗留下来的家族设置。宿主会把 `settings.yaml` 重命名一次，并按每个 section 自己的名字当作 profile entry id 导入；家族行是 `ui-pet` / `web-ui-pet`、`ui-liangshen` / `web-ui-liangshen`、`web-ui-usage`，因此这些 section 匹配不到任何条目，只能留在改名后的 `settings.yaml.imported` 里，并会退回 schema 默认值。[0.1.7 cohort 记录](../../implemented/architecture/2026-09-22-sdk-cohort-0.1.7-alpha.1.md)拥有该决定，并记录了两条解析规则、不覆盖合并与一次性标记。

该修复运行在插件内部，等 composition 落定之后（`src/index.ts:197-199`）；它的全部收益只落在"跨过重命名时家族 section 仍未被子收养"的 profile 上。两个事实界定了成本：

- 所有家族包现在都声明 `dsh.engines.dsh >= 0.2.0-rc.2`，因此该模块只能运行在比它所修复的状态更新的宿主线上。
- 但该下限并不能证明状态已经消失：孤儿状态由 0.1.7 时代的宿主产生，若某用户在那一版宿主上使用的家族插件早于 cohort 记录的实现，他可以带着仍留在改名后文档里的 section 跨过下限。此时本模块是唯一会收养它们的东西。

除记录之外没有任何文档写明该修复服务的支持窗口：`grep -rn '0.1.7' docs/*.md packages/AGENTS.md` 无命中；`src/index.ts:34-44` 再导出的四个符号，除模块自己的 spec 外没有消费方。

## Decision

所有者确认删除。`packages/dsh-web-settings/src/legacy-import.ts`（532 行）与 `packages/dsh-web-settings/tests/legacy-import.spec.ts`（487 行）已删除，`src/index.ts` 去掉该模块的导入、四个再导出与四个类型、activation 期的调用以及 `importLegacyFamilySettings` 本身——222 行变为 184 行。

设置文档的读取函数保留：`settingsYamlCandidatePaths`、`readSettingsYamlDocument`、`importedSettingsYamlPath` 与 `settingsYamlFallbackPath` 同时供 bridge 的 `readSettingsYaml` 使用，因此提案中"一并删除它们"的条目是错的，本次改动保留它们。

标记文档 `$DSH_HOME/dsh-web-settings-legacy-import.json` 成为惰性文件：没有任何代码写它或读它，也没有新增清理任务。README 三件套在两种语言中删掉特性条目、39 行的「旧版设置导入」一节与两条与该导入相关的已知限制，并重录配对记录。

所有者接受的代价：某个从 0.1.7 时代宿主跨过来、且家族 section 仍未被收养的 profile，会让这些值继续留在 `settings.yaml.imported` 中，并按 schema 默认值呈现。

## Context & Efficiency Impact

约 1000 行需要维护的源码与测试、三个文件里的一节 README，以及该包写入用户 `$DSH_HOME` 的一份带版本文档随之消失。对已经没有可收养内容的安装而言没有运行时行为变化，因为那里的修复按构造就是空操作。

上下文上的收益是 `dsh-web-settings` 不再同时承担两件互不相关的工作：它本来存在的设置桥，以及一项针对自身引擎下限所排除的宿主线的修复。

## Evidence

- 生产路径：`packages/dsh-web-settings/src/index.ts:197-199` 调用 `importLegacyFamilySettings`（:211），后者调用 `legacy-import.ts` 的 `importLegacyFamilySections`。
- 在 `node_modules` 之外搜索 `settings.yaml.imported`，只命中该包自己的源码与 README：没有其他包、脚本、测试或文档提到这个输入。
- 重命名的官方一侧在已安装的 `@deepseek-ai/dsh-settings` 中（`lib/index.js` 把该文档重命名一次，并按名字导入每个 section，对没有条目认领的记日志）。
- 公开表面：`src/index.ts:34-44` 再导出标记常量与标记读取函数，外加四个类型；它们唯一的消费方是 `tests/legacy-import.spec.ts`（487 行）。
- 下限：`packages/dsh-web-settings/package.json` 声明 `"dsh": { "engines": { "dsh": ">=0.2.0-rc.2" } }`，`@deepseek-ai/dsh` peer 同为该范围，因此该包在它所修复的那个宿主上会拒绝加载。
- 持久格式：`LEGACY_IMPORT_MARKER_FILE = 'dsh-web-settings-legacy-import.json'` 与 `LEGACY_IMPORT_MARKER_VERSION = 1`（`legacy-import.ts:50-53`），写在解析出的 DSH home 下。

## Alternatives considered

- **保留修复，并在包 README 中写明它服务的宿主窗口。** 这是今天那项隐含义务的诚实形态；若开放问题的答案是"是"，所有者就应当选它。它保留约 1000 行代码与标记文档，但把义务变得可审查、可凭证据退役，而不是凭猜测。
- **不现在做，而是安排退役。** 作为主提案被否决，但作为稳妥路径记录在案：再保留一个 cohort，在发布说明里宣告窗口结束，待说明可以写"没有受支持的宿主还会带该状态"时再删除。代价是多一个版本的代码，收益是免去静默丢设置的风险。
- **现在就删除并接受未迁移 profile 的损失。** 否决：损失是静默的（值仍留在改名后的文档中，用户看到的是默认值），这不是调查可以替所有者做的取舍。
- **保留修复，只删掉公开再导出与四个类型。** 否决（不足以构成简化）：它们只是成本中的十几行，真正的义务是模块本体、它的 spec 与那份持久文档。
- **把修复移进一个用户手动执行的一次性脚本。** 否决：那是把同一套逻辑挪到一个没人会跑的工具里，而不跑的用户恰好会丢掉该修复本来要救回的设置。

## Testing

- `pnpm --filter ./packages/dsh-web-settings typecheck` 与该包的 87 个测试通过；没有任何测试导入被删除的模块或其再导出。
- `pnpm docs:check` 在重录 `README.i18n.yaml` 后通过；两份 README 各删掉相同的 39 行小节与相同的三条条目。
- `pnpm i18n:check` 与 `pnpm emoji:check` 通过，`pnpm test:scripts` 保持绿色。
- 在 `.agents/notes/` 之外搜索 `legacy-import`、`importLegacyFamilySections`、`LEGACY_IMPORT_MARKER_` 与 `readLegacyImportMarkerState` 均无命中。

## Risks

- 删除该修复会让某个从 0.1.7 时代宿主跨过来的 profile 静默把家族设置退回 schema 默认值，且没有任何提示：官方宿主只会记录它未认领该 section。
- 保留它则让一份带版本的磁盘文档与约 1000 行代码为一个仓库无法枚举的人群长期存活；若窗口已经关闭，这份成本将永远支付。
- 标记文档是带版本字段的持久格式。之后的任何改动仍须能读版本 1，或者有意弃用它——这也是该决定应当只有一处记录的原因。
