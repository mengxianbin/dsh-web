# Agent Note: 归档身份硬闸与台账 actor（三值裁决表）

Status: implemented

## 问题

2026-10-29 13:53 误归档（taskbot R16 在用户输入中归了人工会话 `session-e631dae6`）没有任何机械拦截：归档 REST 对任何回环调用方、任何目标都放行，裁决只活在 skill 文本里，台账只记「何时」不记「谁」——归因花了一小时转录考古。m-note 裁定（decision-log 2026-10-29T16:03）把每一次归档裁决都指派给身份：`bot-worker` 会话由 `bot-boss` 归、`bot-boss` 由继任 `bot-boss` 归、其余归人工，无豁免，并要求台账携带执行者（actor）。

## 决策

- **`POST /api/dsh-session-archive/archive` 必填 `actor`**（缺失 400，与 seal 硬闸的必填字段模式同款）：裁决会话 id（`session-…` 或裸 uuid）或人工通道名（`manual` 等）。`BatchRequestBody` 增该字段；仅此路由必填（unarchive/delete 不动，见「后果」）。
- **新宿主模块 `src/host/identity.ts`** 在 `$DSH_HOME/session-attention.json`（dispatch 插件的注意力账本）上实现裁决表——每批归档现读一次（三值行、遗留 `bot` 行按 `bot-worker` 计、文件缺失/损坏得空表）。`mayArchive`：human 全放；`bot-boss` 放 `bot-worker`/`bot-boss` 目标、拒 `human`；`bot-worker` 全拒；未分类 actor 全拒；查无记录的**目标**按 `human` 计。`resolveActorClass`：会话 id 查表（查无记录的 actor 拒，绝不猜成人工），其余视为人工声明的通道名。
- **闸在 `ArchiveService.archive` 内逐 id 执行**（`not-found` 之后、动作之前），拒绝结果 = `skipped / identity-denied`、`detail` 带双方类；批内不连坐；放行归档的 actor 写进对应台账条目（`LedgerEntry.actor`，反序列化宽容读）。
- **自报信任，明写在案**：actor 是回环请求字段，与 `recordManualArchive` 同一信任模型——拦的是「判据里没这条」的出错自动化（R16 形态），不防蓄意撒谎的调用方。调用方接线在 m-note 侧（taskbot skill 传 boss 会话 id、`archive-janitor.mjs` 传 `ownerSessionId`、人工 skill 传 `manual`）。

## 备选与否决理由

- **只做软约束（SKILL 自觉）**：被裁定否决——R16 正是判据里没这条的会话；简报选项 C。硬闸是第一道、skill 文本是第二道。
- **缺 actor 失败放行（按人工处理）**：否决。任何未接线的 bot 调用仍能归人工会话 = 事故同型留口；本批已把已知调用方全部接线，必填的代价只是三个脚本里各多一个变量。
- **原生 UI 通道也上闸**：超出可达与范围——侧栏归档根本不走本插件 REST（这正是 `recordManualArchive` 观测的对象），它自带确认/撤销面。

## 后果

- 不带 `actor` 的 REST 调用一律 400，直到调用方更新；m-note 批内同批更新 `archive-janitor.mjs` 与 `taskbot`/`dsh-session-archive` 两个 skill，按旧 skill 文本运行的在途会话在轮换前可能吃到拒绝（已接受，随汇报呈报）。
- 原生 UI 路径（`observed` 补记）与三值化之前的存量条目不带 `actor`；只有声明了 actor 的插件归档有。
- `/delete` 与 `/unarchive` 不过身份闸（超出本裁定范围，作为残余呈报）——delete 仍受其自身确认契约约束。
- 闸依赖账本健康：注意力账本漏记会话期间（2026-10-29 现场问题，已单独呈报），新会话 actor 解析为未分类即被拒，直到账本补齐。
- 本分支（`local/sessionclass-triclass-1029`，基于 tag `v0.4.11` = 部署中的运行时）与在途的 `local/archive-seal-gate-plugin-1028` 改同一批文件（`routes.ts`、`janitor.ts`、`ledger.ts`）；后落地的一方负责合并逐 id 拒绝路径。

## 测试

`tests/identity.spec.ts`（12 例）覆盖完整矩阵、裸 uuid 归一、空/缺 actor、通道名、表解析（遗留/未知/缺失/损坏）。`tests/janitor.spec.ts` 新增身份 describe 级（boss 归 worker + boss 被拒于 human 目标、台账盖 actor；未分类会话 actor vs 通道 actor），既有 `archive()` 调用全部补上 actor。`tests/routes.spec.ts` 新增 actor 必填 400 + 声明 actor 200 一例；`tests/ledger.spec.ts` 新增 actor 往返一例。包级 `typecheck`、`vitest`（16 文件 147/147）、`verify-docs.mjs --write` 全部通过（2026-10-29）。
