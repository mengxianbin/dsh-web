# Agent Note: 把宿主的斜杠指令与技能搬上远程桥

Status: implemented

[协议记录](../architecture/2026-10-16-remote-bridge-protocol-v1.zh.md) 的通道记录：那篇拥有这个面本身——信封、配对闸门与进程内网关消费。本篇只拥有加在那个面上的一个通道。

## Problem

经 `dsh-remote-bridge` 遥控一条会话的手机能发言、能打断、能读历史、能应答审批，但做不到桌面输入框以斜杠开头时做的事：列出宿主为这条会话提供的指令与技能，并执行其中一条。协议 v1 没有任何方法去读 `ctx.commands` 的有效视图或按会话寻址的技能目录，也没有办法问宿主「这一行到底认不认」。缺口在两头都看得见——手机给不出目录；而人在手机上手打 `/compact`，只能把它当提示词发出去，宿主于是把它读成一条消息，而不是它本来就是的那条指令。

## Decision

- **新增能力 `commands.v1`，带两个方法。** `session.commands {sessionId}` 回 `{sessionId, items:[{name, description, kind, line}]}`，`session.command {sessionId, line}` 回 `{matched}`。门控与 `agents.v1`、`session.fork.v1` 完全一致：没声明该能力的客户端在配对闸门之前就被拒为 `unknown-method`，且不会为它产生任何网关调用；未配对回 `unpaired`；能力名在 `hello` 的 `capabilities` 里公告，客户端因此不必试就知道这个通道存在。
- **目录是两份宿主表折成的一张平表，每次调用现拉。** `commands/list` 是该 Agent 的有效视图（Agent 作用域子上下文注册的会遮蔽全局那条），`skills/list` 是该会话 cwd 与预设选出的技能表。先全部指令、再全部技能，各自保持宿主顺序。跨帧不缓存、不分页、不推送：桥里没有「某会话能跑什么」的索引，因此插件前一秒注册的指令、被换掉的预设撤走的技能，都出现在下一次应答里，也不存在会过期的第二份真值。
- **`line` 是补全进草稿的整行文本，含分隔空格。** 两种 kind 都回 `/<name> `——官方输入框插入的就是这个，而尾随空格不是装饰而是必须：两个宿主面都只在名字后面跟着空白或文本结尾时才认这个手势。因此技能行是宿主从提交的消息里读出的提示词文本，从来不是注册表条目。
- **`matched` 是宿主自己的判定，只回报、不重算。** `session.command` 把该行原样交给 `commands/execute`，`submittedAttachments` 为空数组，只有调用真的返回一次已结算的执行时才回 `matched: true`。宿主对两种准入失败都回 `undefined`——它的解析器不认这一行，或名字不在它的注册表里——所以桥从不解释一行是什么意思，不预判指令，也不拒绝它不认识的行。
- **宿主没有这些端点时回本桥自有码。** 网关报 `invocation-unavailable` 或 `definition-unavailable`（它表达「没有任何活动的 Remote 方法导出这个端点」的方式）时回 `commands-unavailable`。仅仅还在激活中的服务保持 `gateway/service-unavailable`：那个窗口在到达这里之前已经重试过，持续失败是部署坏了而不是通道不存在，把两者折成一个会把它藏起来。
- **`hello` 回 `minor:12`。** 指令通道把一种新的应答体放上线路，而这正是本仓提 minor 的判据；`commands.v1` 作为第十四个已服务能力追加。

## 装好的 CLI 里的一手依据

- `CommandRuntime.execute`（`@deepseek-ai/dsh-commands` 的 `lib/index.js`）在任何 handler 跑起来之前有两次 `return undefined`：`const parsed = parseCommand(line); if (parsed === void 0) return void 0;` 与 `const command = this.view(agent).get(parsed.name); if (command === void 0) return void 0;`。这一对就是 `matched` 的全部词表。
- 注册表里只有插件注册过的那些：这一 cohort 是 `compact`、`feedback`、`goal`、`permission`、`plan`、`export`，各自一个 `ctx.commands.register`。`dsh-skill`、`dsh-skill-filesystem`、`dsh-tool-skill` 一处都没有调用它，所以技能名能过 `parseCommand`、随后在注册表里落空：`/adversarial-acceptance ` 是一条形式完整、宿主解析不出任何东西的指令行。
- 技能靠用户文本里的手势唤起：`SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/`（`@deepseek-ai/dsh-tool-skill` 的 `lib/index.js`），由 `invokedSkillNames` 在该步之前扫 `source.kind === 'user'` 的文本块消费；官方输入框的 `onPick` 回 `\`/\${candidate.name} \``（`@deepseek-ai/dsh-client-ui-skill` 的 `lib/client.js`）。这个先行断言正是桥的 line 要带那个空格的原因。
- 线参数取自 typert 的宿主描述符，不靠记忆：`commands/list` 收 `{agentId}`，`commands/execute` 收 `{agentId, line, submittedAttachments}`（`agentId` 是 agent 作用域的线名），`skills/list` 收 `{request: SkillListRequest}`，而 `SkillListRequest` 就是 `{sessionId}`。

## Testing

`packages/dsh-remote-bridge/tests/commands.spec.ts` 用可控假服务驱动真实 `BridgeConnection`：目录顺序与每行的 `kind`/`line`、两个端点的线参数、第二次列出确实再读一次、桥渲染不出的行被丢弃、两个端点各自的 `commands-unavailable`、激活失败保留自己的码、任何网关调用之前的 `invalid-args`、命中与三种未命中的 `matched`、宿主拒绝原样透出、未声明能力且零网关调用、未配对路径，以及握手公告。包内套件 34 个文件 430 条全绿，`tsgo --noEmit` 干净。

## Alternatives considered

- **让 `session.prompt` 自己解析前导斜杠。** 一个方法就有两种含义，桥也成了「一行是什么」的判官：文法、Agent 作用域遮蔽、附件准入全都要搬进来；而宿主本来就在任何回合之外追加 `command/run` 与 `command/done`，那条生命周期是提示词路径复现不了的。想要目录的客户端仍然需要第二个方法。否决。
- **在桥侧把每个技能注册成斜杠指令。** 这样 `/name` 能解析，但宿主会为一次它从未执行过的调用写下 `command/run`，而且把宿主拥有的目录塞进本桥的注册表——预设一变、技能一撤，那里就没有任何通路能跟上。否决：技能行的诚实答案是 `matched: false`，因为宿主确实什么都没解析出来。
- **在桥里判一行以决定 `matched`，不调用宿主。** 复制 `parseCommand` 与作用域查找等于养第二套会漂移的文法，而且只要预设加了一条桥没见过的指令，它就一定是错的。否决。
- **订阅 `commands/change` 推送目录事件。** 注册表通知是全局且不带过滤的，而目录是按会话、按作用域解析的，变更帧说不出是哪个会话的目录动了；手机仍然需要那个按会话寻址的应答，而它正是这个方法本身。否决：无事件、无广播、按需读。
- **给目录分页或限行。** 注册表的大小由「有多少插件注册了指令」决定（这一 cohort 六条，加上客户端贡献），技能表不过一个预设的量；给这样一张表加游标，每份应答都要为它付钱，而没人会用。否决。
- **对任何形式合法的斜杠行都回 `matched: true`**，让客户端把「看起来像指令」当成功。那会在什么都没跑的时候告诉手机 `/adversarial-acceptance` 跑了，而这正是这个方法唯一要如实回答的东西。否决。
- **`minor` 停在 11**，只靠能力名。能力名公告的是行为，但应答体确实是线路上的新东西，本仓正是为此提 minor；把它留着等于让两种不同的协议形状共用一个版本号。否决。

## Consequences

- 手机能列出会话能跑什么，并跑其中一条，由宿主自己的判定决定到底有没有发生。
- 桥放弃了「知道一条指令是什么」：它无法告诉客户端哪些指令收自由输入、哪些接受附件、或某个名字在跑之前是否存在——`CommandDescriptor.input` 与 `CommandDefinition` 仍是宿主的词表，目录只透出 `name` 与 `description`。要输入提示就得再加一个键和一次决策。
- 跑一行就带着指令自身的效果，`/compact` 也一样：这个方法是一次派发，不是探测。唯一能得知某行跑不起来的方式就是发出去，而那次网关调用在准入失败时什么都不会记（宿主只在准入之后写生命周期事件）。
- 附件在构造上就不在范围里：草稿行不带附件，桥因此送空的 `submittedAttachments`，需要附件的指令只有能暂存附件的输入框才够得着。
- 没导出这些端点的宿主与拒绝某次调用的宿主被区分开，客户端因此可以禁用目录，而不是反复失败地重试。
- 这里未证明：对着正在运行的宿主进程做过一次端到端往返。通道由包内套件对着可控网关覆盖；运行中的宿主只有在本包重新构建、DSH 进程重启之后才服务这两个方法。
