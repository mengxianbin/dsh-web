# Agent Note: 让每个包的 invariant 伴生模块与它实际发布的内容一致

Status: implemented

其 invariant 表面已被 [sdk-cohort-0.2.1-rc.2](../architecture/2026-10-17-sdk-cohort-0.2.1-rc.2.md) 取代：0.2.1 线在上游移除了 runtime invariants 注册表（`@deepseek-ai/dsh-invariants` 没有发布任何 0.2.1 版本），于是家族删除了最后两个伴生模块——`dsh-git-graph` 与 `dsh-remote-web-ui` 不再声明 `./invariant`、不再携带 `src/invariant.ts`、不再依赖该注册表——家族里没有任何包再声明该子路径。`scripts/family-dsh-engines.test.mjs` 现在会在任何清单回归时让构建失败。仍然成立的是：本记录的核心 rationale（声明的子路径必须解析到它所声称的东西，绝不能是静默空操作），以及下文对六个包状态的审计，作为本记录所修复状态的历史记载。

## Problem

`@deepseek-ai/dsh-invariants` 是官方为"包自有运行时检查"提供的注册表：任何包都可以附带一个 `./invariant` 伴生模块，伴生模块以该包的确切 npm 名经 `ctx.invariants` 注册，而挂载了注册表的 composition 决定哪些伴生模块运行。家族里有六个包声明了这个子路径，其中四个做不到声明所承诺的事。

| 包 | `src/invariant.ts` | 是否产出 `lib/invariant.js` | 是否向注册表注册 |
| --- | --- | --- | --- |
| `dsh-git-graph` | 有 | 有 | 有——`name`、`inject: ['invariants']`，`apply` 注册一个有注释说明的空安装器 |
| `dsh-remote-web-ui` | 有 | 有 | 有——同样的形态 |
| `dsh-ssh` | 有，4 行 | 有 | 无——`export function apply(): void {}`，没有 `name`、没有 `inject`、也不注册 |
| `dsh-task-board` | 有，4 行 | 有 | 无——同样的空壳 |
| `dsh-session-id` | 有，2 行 | 无——tsdown 只构建 `src/index.ts` | 无——同样的空壳 |
| `dsh-i18n` | 无 | 无 | 无——该导出根本没有源文件 |

两个不产出任何文件的包发布了一个无法解析的子路径：composition 挂载 `@linxin666/dsh-client-ui-session-id/invariant` 或 `@linxin666/dsh-i18n/invariant` 时得到的是模块解析错误而不是检查，而这两个包的构建从未产出过该文件。两个空壳确实能解析，但挂载它们只会执行一个从不触碰注册表的 `apply`，composition 同样静默地得不到任何检查。

`scripts/plugin-template` 让这个缺陷继续繁殖：它输出同样的 `./invariant` 导出块，却只脚手架出 `src/index.ts` 与 `src/client/index.ts`，于是每个新包都从 `dsh-i18n` 的现状起步。共享预设自己的注释（`shared/tsdown.client.ts:139-141`）说 node 半边入口清单"写在调用点，好让 package-invariants 门禁能在每个包自己的 tsdown.config.ts 里看到 `src/invariant.ts`……"，但本仓并不存在这样一道门禁——`dsh-session-id` 与 `dsh-i18n` 正是这样漂移出去的。

web profile 不组合任何 invariants 服务（git-graph 伴生模块的文件头已记录这一点），因此这六个在本部署中一个也不会加载。该表面仍然重要，且重要两次：对确实挂载注册表的 composition，以及作为每个包发布的 npm 契约。

## Decision

家族里有六个包声明了 `./invariant` 子路径，其中四个无法提供它。这四处声明已删除：`dsh-i18n`（从来没有源文件）、`dsh-session-id`（从未产出该文件），以及 `dsh-ssh` 与 `dsh-task-board`（四行空壳从不注册任何东西）。它们的 `src/invariant.ts` 已删除，`dsh-ssh` 与 `dsh-task-board` 的 tsdown 入口清单也不再列它。

两个可用的伴生模块保留：`dsh-git-graph` 与 `dsh-remote-web-ui` 保持 cordis 形态——`name`、`inject: ['invariants']`，以及经 `ctx.invariants` 注册安装器的 `apply`——并继续产出 `lib/invariant.js`。（2026-10-17 更新：此句记录的是本记录发布时的状态；0.2.1-rc.2 cohort 适配随上游注册表一起移除了两个伴生模块——见文首的取代说明。）

`scripts/plugin-template` 不再脚手架该导出块，新包因此不会再从 `dsh-i18n` 当初的状态起步；`shared/tsdown.client.ts` 也不再声称存在一道本仓没有实现的 package-invariants 门禁。`packages/AGENTS.md` 改为写下这项义务：声明 `./invariant` 的包必须发布注册表能加载的伴生模块。（2026-10-17 更新：`packages/AGENTS.md` 的义务段落已在 0.2.1-rc.2 适配中随约定一起移除；共享预设注释当年想象的那道门禁如今以 `scripts/family-dsh-engines.test.mjs` 的形式存在，它断言该子路径保持缺席。）

## Context & Efficiency Impact

改动很小——四个空壳文件、六个清单、一个模板、一条注释——并且不会移除本部署拥有的任何能力，因为这里根本没有挂载 invariants 服务。它改的是这些包承诺什么，而不是运行时行为。

收益是这个子路径不再有两层含义：改动之后，声明 `./invariant` 的包就是 composition 真能挂载的包；这也正是当某个 composition 想要检查某个家族包时，该约定唯一还能用的形态。

## Evidence

- 官方契约：`@deepseek-ai/dsh-invariants` 的 README（"any package can ship a `./invariant` companion that verifies its own durable relationships"）及其 `lib/index.js`（注册表服务按包名登记伴生模块）。
- 六行结论逐包核验：`package.json` 的 `exports['./invariant']`、是否存在 `src/invariant.ts`、`tsdown.config.ts` 的入口清单，以及上次构建后磁盘上的 `lib/invariant.js`（四个包存在，`dsh-session-id` 与 `dsh-i18n` 不存在）。
- 两个空壳（`packages/dsh-ssh/src/invariant.ts`、`packages/dsh-task-board/src/invariant.ts`）各四行，没有 `name`、没有 `inject`，`apply` 为空；`packages/dsh-session-id/src/invariant.ts` 是同一形态的两行版本。
- 脚手架：`scripts/plugin-template/package.json` 声明了 `./invariant`，`scripts/plugin-template/tsdown.config.ts` 只构建 `['src/index.ts']`，`scripts/plugin-template/src/` 只有 `index.ts` 与 `client/index.ts`。
- 仓库里没有任何代码 import `./invariant`：在 `packages/*/src`、`packages/*/tests` 与 `scripts/` 中搜索只命中自声明。聚合清单里没有伴生行，而已安装的 DSH 归档在本会话中不可检索，因此该约定的加载方一侧以官方包自身的文档为依据。

## Alternatives considered

- **保留全部六处声明，把伴生模块当作"为将来的检查预留的接缝"。** 否决：其中两个根本无法解析，其余注册不了任何东西，于是挂载它们的 composition 得到的是模块错误或静默空操作，而不是声明所宣传的检查。
- **把所有空壳都改造成真实的 cordis 形态。** 作为默认方案否决：那会新增一个不安装任何检查的注册——只有形态没有内容。它只适合近期确实会加检查、并希望先声明接缝的包；本提案把这一选择留给各包自己。
- **把该约定整体从仓库移除**，包括两个可用的伴生模块、模板里的导出块与共享预设的注释。否决：`dsh-git-graph` 与 `dsh-remote-web-ui` 发布的伴生模块注册表确实能加载，且该约定是官方的；损失将是 composition 用来检查家族包的唯一接缝。（2026-10-17 更新：这一备选后来还是发生了，只是来自上游一侧——0.2.1 线移除了注册表，约定随之离场，而非家族自行决定删除。）
- **只修模板。** 否决（不足以构成修复）：它阻止新包继承缺陷，却把现有四个原样留下。

## Testing

- 每个声明 `./invariant` 的包，要么发布注册表能加载的伴生模块——`name`、`inject: ['invariants']`、一个会注册安装器的 `apply`，且构建产物里有 `lib/invariant.js`——要么不声明该子路径。
- 由 `scripts/plugin-new` 脚手架出的包从上述两种状态之一起步，模板的 README 与 AGENTS 文字描述它实际构建的东西。
- `pnpm -r build` 为且仅为声明该导出的包产出 `lib/invariant.js`；`pnpm typecheck`、`pnpm test` 与 `pnpm docs:check` 通过；共享预设的注释不再提一道本仓没有实现的门禁，或者该门禁已经存在。

## Risks

- 从已发布的包中删掉子路径对第三方是 semver 可见的改动，因此随版本发布而不是打成补丁；`dsh-session-id` 与 `dsh-i18n` 的该导入本来就是坏的，这把风险限制在"调用方本来就已经失败"的范围内。
- 挂载 `dsh-ssh` 或 `dsh-task-board` 空壳的 composition 今天得到静默空操作，删除后会得到解析错误。正因如此，本提案对每个包给出"删除或实现"而不是四个一起删，由所有者作答。
- 若某个已删除声明的包日后要加检查，导出与构建入口必须一起回来；脚手架修复的验收标准正是防止这一点被遗忘。
