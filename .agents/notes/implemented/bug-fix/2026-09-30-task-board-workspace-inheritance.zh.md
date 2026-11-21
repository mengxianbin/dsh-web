# Agent Note: 任务看板的工作区继承

Status: implemented

## 问题

工作区未钉住的任务会跑到不属于它的项目里执行。有两条路径，都落在 runner 的同一行上：

1. `HostExecutionRunner.launch()` 对未钉住的卡片干脆不传 `workspaceId`，依据是「宿主会解析出最近使用的工作区」这一书面说法。宿主并没有这么做：`@deepseek-ai/dsh-api-session-controller` 的 `create()` 计算的是 `const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd`，于是这条执行落到了宿主进程的工作目录——桌面版即 profile 目录（`~/.dsh/profiles/desktop`）。2026-09-30 实测：一张在 `~/code/dsh-web` 会话里创建的卡片跑到 `~/.dsh/profiles/desktop` 执行，会话存储把它记在 `~/.dsh/sessions/--Users-zcl-.dsh-profiles-desktop--/` 之下。那次执行的会话头记录了 `cwd: /Users/zcl/.dsh/profiles/desktop`、`delegationDepth: 0`、`agentPreset: standard`——正是 App 的 profile 根，Agents 界面随后把一批 agent 的工作目录显示成它。
2. 只有浏览器的「新建任务」表单会填这个钉（当前所在项目，或用户显式选择）。通过 agent 工具 `task_board_create` 写下的卡片——对话中创建定时任务时的常规做法——到达时没有钉，于是它的每一次执行都走上一条路径。

要恢复的用户可见契约：没有指定工作区的卡片，在创建它的那个会话所在的工作区里执行。

## 决策

**经看板 action 路径创建的根任务，继承创建它的那个会话所在的工作区。** `TaskBoardHostService.apply()` 在账本看到之前，把进来的 create 动作过一遍 `withInheritedWorkspace()`：当动作是 create、带 initiator 会话 id、没有 `parentId`、也没有钉 `workspaceId` 时，服务用 `workspaceOwningSession()` 解析拥有该会话的工作区并把它钉到卡片上。agent 工具本来就传 `callingSessionId(exec)`，浏览器也提交主视图当前会话，因此同一条规则覆盖两个写入方。initiator 由客户端断言，只用于在部署已列出的工作区之间做选择。

**仍未钉住的执行改为解析最近使用的工作区；部署没有任何工作区时拒绝运行。** `HostExecutionRunner.launch()` 解析 `task.handover?.workspaceId ?? task.workspaceId ?? mostRecentWorkspaceId(registry.list())`——记录最后变更的工作区（附加会话会盖 `updatedAt` 时间戳），平局按部署自己的列表顺序。这覆盖本次改动之前写下的卡片、导入的卡片，以及任何工作区都无法对应的创建者。三个来源都为空时——没有钉、没有交接包、工作区注册表缺失或一个都没注册——启动在调用 `session.create` 之前抛出 `MISSING_WORKSPACE_REASON`（`this card pins no workspace; choose a workspace on the card before running`）。拒绝发生在任何会话存在之前，因此看板以这段文字把卡片结算为失败，agent 工具读到的也是同一段文字，浏览器则按 `exec.error.noWorkspace` 字典项以读者语言渲染。复用会话那一支不受影响：续接已有会话不需要工作区。

三条规则都放在不依赖框架的 `src/core/workspace-target.ts` 里，只读 SDK `Workspace` 实体的结构化子集，因此浏览器半区编译它们时不需要任何 SDK 值导入：`workspaceOwningSession()`、`mostRecentWorkspaceId()`，以及 `MISSING_WORKSPACE_REASON` 与其 `isMissingWorkspaceReason()` 谓词。

## 测试

- `tests/workspace-target.spec.ts`——会话归属、最近选择、平局、不可解析的时间戳、空注册表，以及拒绝谓词。
- `tests/host-runner.spec.ts`——未钉住的启动把会话建在最近使用的工作区，并保持既有的 create/rename/prompt 调用序列；注册表为空、或根本没有注册表的部署以缺失工作区的原因拒绝，且不创建任何会话。
- `tests/host-service.spec.ts`——从某个会话创建根任务会钉住该会话的工作区，即便另有更近使用的工作区；显式钉住优先；子任务继续按血缘继承。
- `tests/task-detail-panel.spec.tsx`——执行记录以读者语言渲染这次拒绝，而不是账本记下的宿主原文。

## 备选方案

- **只修 runner（执行时解析最近工作区）。** 作为全部答案被否决：它满足书面的「最近使用的工作区」文案，但每天定时执行的卡片此后会跟着用户最后碰过的项目走——对一张职责就是维护本仓卫星仓的卡片来说，跑进无关的检出正是报告里描述的那类意外。
- **什么都不解析时继续静默兜底。** 被否决：没有工作区时 `session.create` 唯一能做的就是回退到宿主进程工作目录，而这正是本笔记要终止的「落到 profile 目录」结局——一次不说明自己去哪儿、看板也无法纠正的执行。拒绝则在用户要求执行的那一刻说出缺了什么、怎么补（在卡片上选择工作区）。
- **只在浏览器里钉住创建者的工作区。** 被否决：agent 工具这条路径根本不经过浏览器，两个写入方会各自漂移。
- **项目未打开时强制选择工作区。** [项目分区笔记](../../feature/2026-09-13-task-board-project-partition.md)已否决过：留空钉正是「不需要选项目也能写卡片」的性质；静默继承保住了它。
- **从会话目录而不是工作区记录解析「最近」。** 被否决：为了好一点点的信号，每次启动都要多读一次名册并做会话到工作区的映射，而 `updatedAt` 本就是工作区记录自身的变更戳。
- **把 initiator 当成权威。** 被否决：它始终只是提示，只用于在部署已知的工作区之间做选择，伪造的 id 既不能注册工作区，也够不到列表之外的目录。

## 后果

- agent 在某个项目内创建的卡片，此后会把该项目显示为自己的钉住工作区，项目过滤与执行目标因此一致。
- `task_board_create` 工具描述、`NewTaskInput.workspaceId` 的文档注释，以及 README 里项目分区那一条，改为陈述这套继承，而不再承诺一个宿主从未实现的「最近使用的工作区」。
- 未钉住卡片的执行目标仍可能逐次变化，因为它跟随最近使用的工作区；要固定下来仍然靠钉住工作区。
- `TaskBoardHostService.apply()` 每次根任务创建读一次工作区注册表——对部署工作区列表的一次同步扫描。
- 还没有注册任何工作区的部署（全新 profile）此后完全跑不动未钉住的卡片：执行以缺失工作区的原因结算为失败，直到有工作区、或卡片自己钉一个。至少有一个工作区的部署，以及任何钉了工作区的卡片，行为与改前完全一致。
- 定时到点遇到这次拒绝时不创建会话，并按计划退回这次 run，与任何在会话存在之前失败的启动一样。
