# Agent Note: 智能体小队定义获得模型可调用的工具面

Status: implemented

## Problem

小队定义只有页面一条入口。想知道有哪些小队、加一个成员、或者启动一个，人都得打开页面、填表格、按按钮——而刚刚回答完「这项工作该怎么拆」的那个 agent，才是知道本部署提供哪些预设与权限的那个。于是定义始终留在讨论它的那段对话之外，用户维护的每支小队都得先在聊天里被人复述一遍，agent 才用得上。

两条捷径就在手边，但都站不住。这个包已经为 Agent Teams 运行期安装了一套会话级工具，所以最省事的动作看起来是往里加十个名字。这个包也已经用同一份账本服务七个 HTTP 路由，所以第二省事的动作看起来是在工具里调那些路由。前者把定义管理塞进只在整队运行期间存在的会话里，而那里恰恰是改不了定义的地方：运行中的队伍名单是固定的，会去管理的那个会话正是被管理的那个。后者把一次进程内调用绕到面向浏览器的围栏外面：换来一次 HTTP 往返、一次重复解码和一个端口，而服务调用本来就已经给出这一切。

## Decision

本包在每个会话里注册十个模型可调用工具：`squads_list`、`squads_read`、`squads_create`、`squads_update`、`squads_delete`、`squad_member_add`、`squad_member_update`、`squad_member_remove`、`squads_run_member` 与 `squads_run_squad`。它们直接调用 `AgentsHostService`——`src/host/routes.ts` 调的就是同一个对象——因此账本、账本锁、启动顺序和每一道 fail-closed 钉住都是既有的那套。`DSH_AGENTS_ROUTE_PATHS` 仍然只有七个路由；工具面不新增、不删除，也不需要端口。

参数门禁复用包自己的解析器（`src/protocol.ts` 的 `parseTeamDraft`、`parseMemberDraft` 与各个 id 读取函数），而不是在第二处重述长度上限、精确键规则与枚举成员资格。一个解析器只给出一个答案：页面发不出去的字段工具也发不出去，协议里抬高的上限对两边一起生效。两个运行工具委托给 `AgentsHostService.run` 与 `AgentsHostService.runSquad`，所以工具发起的运行记录下的内容与页面发起的一模一样。`squads_run_squad` 只带目标、不带别的：目标随请求上送，经 `team:squad` 系统提示词 context 送达 Lead，绝不伪装成一条用户消息。

成功值是 `{ ok: true, ... }`。领域拒绝是返回值——`{ ok: false, code, message }`——`code` 取自 `AGENTS_ERROR_CODES`，参数非法用 `invalid-request`，不引入任何新码；只有本插件之外的失败才会被抛出。

## Gating and announcement

注册跟随 `enabled` 全局进行，这条约定归[家族工具面约定](2026-10-02-family-tool-surface-conventions.md)：整个宿主注册一次，关闭设置即撤销，靠这一点才让工具注册表的按作用域限制继续有权收走这些名字。只有摆放位置属于本包：公告是独立的 `plugin:agents` 系统提示词段，order 取家族段位表里的 220，因此它落在插件指导的档位里，而不是挤进整队运行会话才有的 team policy 段；它由插件设置卡上的 `announceToAgent` 控制（默认 `false`，volatile），文案经 `visibleToolText` 生成，只列对当前装配作用域真实可见的工具名。写死一句列出十个工具的静态文案，会在设置关掉或作用域限制之后继续教模型去调已经不在的工具，而这句假话唯一看不见的地方就是提示词本身。

## Partial updates and destructive confirmation

`squads_update` 与 `squad_member_update` 是局部合并：省略的字段保留现值，空串清除该可选字段，`name` 不接受空串。整体替换会逼每个调用方为了改一个字段而重述成员的简报、模型钉住与权限，第一个漏掉的人就会悄悄丢掉用户设过的钉住——对一次声称「改个名字」的调用来说，这是数据丢失的形状。

`squads_delete` 与 `squad_member_remove` 必须 `confirm: true`。其它取值在触碰账本之前就返回 `{ ok: false, code: 'invalid-request' }`，删除成功则回传被删对象的 `id` 与 `name`。这个标志把「手滑删掉」从丢定义变成一次被拒的调用；返回值里的名字则让调用方能说清自己删了什么：只看到 `ok: true` 的 agent 无法告诉用户它删的是小队还是成员。

## Alternatives considered

- **十个工具只装进整队运行会话，与 `team_*` 并列。** 不采用。整队运行会话的存在目的是跑一支小队，且名单在这次运行期间固定，于是唯一能管定义的那个会话恰好也是不能改定义的那个；而普通对话——agent 被问有哪些小队、或被要求建一支——依旧什么都看不到。它还会继承安装门的代价：每次成员关系变化都重扫一遍 live agent，而对象却是账本而不是会话。
- **在工具里调本插件自己的 loopback HTTP 路由。** 不采用。那会把浏览器围栏、体积上限与一次 JSON 解码塞进模型和一份它本来就能在进程内读到的账本之间，给一段对话添上端口依赖，并让一次本地调用按跨源请求的方式失败。路由继续做浏览器的传输层；工具走服务。
- **为工具参数另写一层校验。** 不采用。长度上限、精确键规则与权限枚举住在 `src/protocol.ts`，是账本唯一的门禁；第二份拷贝在任何一侧改动的那一刻就会漂移，两个界面于是对「这份草稿可不可接受」给出不同答案。复用解析器不新增依赖，并让契约只有一个主人。
- **让 update 类工具整体替换定义。** 不采用，理由就是上一条数据丢失：局部合并的代价是每个字段一次 `undefined` 判断，而它绝不会丢掉调用方没提到的钉住。
- **删除不要确认标志，或只回一个 `{ ok: true }`。** 不采用。id 打错一个字符很便宜、也没法撤回，所以这个标志区分的是「一次被拒的调用」与「一份丢掉的定义」；而光秃秃的 `ok` 让调用方说不出自己删了什么，那恰恰是一次破坏性汇报唯一需要的事实。
- **用一句静态文案无条件公告这些工具。** 不采用，理由家族已经记录在[家族工具面约定](2026-10-02-family-tool-surface-conventions.md)：为作用域看不见的工具写的指导，只会让模型去尝试一次被拒的调用。在这里它还会额外熬过「预设限制了工具面」这一种情形，而这些工具恰恰必须在这种情形下继续可用。

## Consequences

- 每个会话多背十个工具 schema。公告默认关闭，用户不主动打开时提示词保持干净，但工具 schema 属于每个继承它们的会话的注册表。
- 模型写下的定义就是启动目标：`squads_run_member` 与 `squads_run_squad` 会开真实会话、消耗与页面发起相同的 API 配额，所以一个 agent 回合就能拉起一支小队。钉住依旧按具名错误 fail closed，本部署兑现不了的运行会被拒绝，而不是降级成默认值。
- HTTP 围栏不变：没有路由被移动或新增，工具也只在本 Host 自己的进程内可达。一个从不暴露路由的部署照样有工具。
- 账本归属不变。一次工具调用拿的是同一把进程锁、走的是同一条 fsync 加 rename 的写入路径，因此第二个 Host 依旧 fail closed，而不是交错写。
- 两个面保持分离：定义工具在每个会话都在，`team_*` 工具仍只装进整队运行会话。两者都不替代原生 subagent 工具。

## Testing

这个工具面没有自己的规则，因此它的覆盖就是它复用的那些路径的覆盖：`packages/dsh-agents/tests/protocol.spec.ts` 钉住参数解析器，`packages/dsh-agents/tests/service.spec.ts` 钉住工具以返回值形式呈现的 Host 拒绝，`packages/dsh-agents/tests/routes.spec.ts` 钉住本工具面不去扩展的那七个路由。`packages/dsh-agents/tests/team-runtime.spec.ts` 钉住让两个面保持分离的那处对照：普通根会话零 Team 工具，整队运行会话拿全套。
