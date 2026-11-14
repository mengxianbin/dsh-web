# Agent Note: 把宿主的提问搬过桥

Status: implemented

## Problem

远端桥此前搬不动 `ask_user_question`。宿主早就有提问服务（`ctx.userQuestions`，带 `user-questions/request` waterfall 与 `userQuestions` 投影），但协议 v1 只暴露了 `approval.resolve`——那是单次工具审批，还带着「沉默视为拒绝」的规则。于是手机连着桥的时候，宿主提出的问题在手机上没有任何去处：客户端既没有可渲染的事件，也没有可作答的方法。

## Decision

- 新增能力 `questions.v1`，承载 `question.request` 事件与 `question.answer` 方法。门控方式与 `session.snapshot.page.v1` 一致：不声明能力的客户端收不到该事件，调用该方法会拿到 `unknown-method`，行为逐字节不变。
- 桥照既有 `approval/request` 的写法，在进程内认领宿主的 `user-questions/request` waterfall。它只在至少有一个已配对客户端在线时认领；广播没有送达任何声明了能力的客户端时，立刻撤回认领并 `next()`，以免一个没人听的桥把宿主的等待占住。
- 认领之后，两种状态分两条落地路径：`open` 由桥结算自己持有的 waterfall promise；`continued` 转调宿主的 `answer` 远程方法——那个方法只接受 continued 问题（在 `continued(agent)` 里找不到就返回 `false`），所以 open 那一半用不了它。
- 线路上的 `callId` 是 opaque 句柄。timed 提问带宿主的真实 `ToolCallId`（`wait.callId`）；阻塞式提问没有，由桥铸造 `bridge:<base64url>`。不这样做的话，每一个阻塞式 `ask_user_question`（也就是实际声明的那个工具，没有 `timeout` 参数）都会被让位出去，手机上永远看不到提问。
- 未知 `callId`、`sessionId` 不符，以及「问题已不可寻址」的宿主拒绝，统一报 `question-unknown`；宿主错误原样穿过，码表保持开放。
- 桥不发明 deadline。timed 提问沿用宿主的 deadline，`ASK_TIMED_OUT` 后转 `continued`；阻塞式提问根本没有 deadline，一直 `open`，直到有人作答、最后一部客户端离开后为它保留的宽限期结束，或桥被卸载。
- timed 提问现在把宿主自己的 deadline 送上线：桥对 hosted 认领订阅 `userQuestions/attachWait`，把报来的 `remainingMs` 换算成绝对的 epoch 毫秒 `expiresAt`，并入宣告该问题的那同一条 `question.request`；之后的帧以同一 `callId` 移动这个 deadline，最多每秒一次。阻塞式提问没有宿主 deadline，因此不带这个键。订阅会在每条结算路径上关闭，并在它报出的 deadline 到点那一刻关闭：宿主在有等待方挂着时会取消并跳过自己的截止定时器，放手正是今天 `open` → `continued` 得以保留的原因。
- 卡片原本只有一条退休信号：`question.request` 的 `state: "settled"`；而桥会撤回全部认领（`BridgeHub.detach` → `QuestionClaims.withdrawAll`），如今是在为最后一个配对设备保留的宽限期结束时（[宽限期记录](2026-10-23-user-question-claim-grace-window.zh.md)），而不是在它离开的那一刻。那一刻不在线的手机收不到任何通知，于是「早已没人等」的卡片在下次启动时从手机自己的存储里恢复，以可作答的姿态出现，作答只会换回 `question-unknown`——2026-10-21 实测：10-20 14:53 提出的提问，次日 07:52 仍显示为可作答，而那条会话的 transcript 里一条 ask 行都没有。这个洞用一次读取而不是启发式补上。
- 第二个能力 `questions.list.v1` 承载一个只读方法 `question.list`：它回答本桥此刻仍持有的提问——每条活认领一行 `{key, sessionId, state, payload}`，`state` 只可能是 `open` 或 `continued`——外加 `complete`。行里的 `payload` 就是发布这张卡时用的同一份 `question.request` 体，由同一个函数产出；`key` 是 `<sessionId>/<callId>`，即手机自己已经在用的卡片身份。客户端唯一可以据以动作的是 `complete`：只有全集才允许退休卡片，因此读不出自己持有什么的认领表回 `question-list-unavailable`，而不是回一个空列表；将来若只能给部分，必须回 `false`。声明与公告缺一不可，与本包其余通道同一判据：从未声明的客户端拿到 `unknown-method` 且不产生任何读取，`hello.r.capabilities` 里没有这一项的桥则让客户端沿用旧规则。这个方法不认领、不移动 deadline、不触发 `continued`、不写任何宿主状态；它也不收参数——持有的集合是一张全局表，加 `sessionId` 过滤只会让手机漏掉它没点名的那些会话的卡。

## Alternatives considered

- **只认领带 `wait.callId` 的提问**（第一版实现）。宿主类型里 `wait` 是可选、只有 `askTimed` 才填，而真实工具 schema 又不声明 `timeout`，结果把所有真实提问都让位出去，通道对它唯一存在的场景完全失效。否决。
- **把每个回答都转调宿主的 `answer`**。该方法只结算 continued 问题，open 态会次次失败。否决。
- **复用 `approval.resolve` 作答**。它带不同的决策词汇与「沉默两分钟视为拒绝」的规则，那条规则不能漏到提问上；而且宿主根本不认这些 id。否决。
- **本地从 session 事件重算问题**，不认领 waterfall。那会让桥对宿主已经拥有的事实建第二个真相源，而投影本来就是为这件事存在的。否决。
- **给阻塞式提问加本地超时**。宿主对它没有 deadline；桥自造的 deadline 等于伪造一次用户从未给出的拒绝。否决。
- **把等待订阅一直挂到认领结算**。宿主的 `wait.attach` 在有等待方挂着时会取消并跳过自己的截止定时器，所以从不放手的桥会在手机连着期间一直压住 `ASK_TIMED_OUT`，让模型等过自己的 deadline。否决：改为在报出的 deadline 到点时放手。
- **只读首帧、立刻关流**。以今天的行为衡量两者等价（宿主每次 attach 只报一次剩余时长），而且完全不需要定时器。否决，因为那条流正是宿主用来报告 deadline 变动的通道；关掉之后桥再想转发后续帧就得另造一套机制。
- **由桥计算并广播倒计时**（从广播那一刻起算）。那是桥自己的 deadline，偏差等于一次往返的耗时，而且宿主早已走过它之后仍会继续倒数。否决。
- **让手机在本地推断过期**——会话没在跑、卡片太旧、名册里没有这一行。这些信号每一个都落后于它代表的事实，而判错的代价是一张真活卡变成只读。桥本来就持有答案，把它作为一张表读出来即可。否决。
- **把持有的集合按会话切分**（`{sessionId}`）。认领本来就是一张全局表，因为这条通道是全局的；按会话读会让手机悄悄漏掉它没点名的那些会话的全部卡片。否决：方法不收参数，带载荷即拒。
- **改为推送持有的集合**——`question.list.changed` 主题，或每次重连自动重放。新提问本来就有 `question.request`，被结算的本来就有 `settled`；唯一缺的事实是「我离线时发生了什么」，每条新连接读一次就够，不必再养一条事件流，也不必把手机已经持有的卡片重发一遍。否决。

## Consequences

- 已配对的手机现在可以显示待答问题并作答，包括已经转成 `continued` 的——那种回答会作为新一轮 steer 回给 agent。
- 阻塞式提问没有 deadline，没人回答就一直可答。这是宿主自己的语义；这类事件完全不带 `expiresAt`：只有 timed 提问才发，而且只因为宿主自己报了它。
- deadline 以宿主的绝对时刻传递，而不是桥算出来的剩余时长；手机再次看到同一个 `callId` 时替换手里的值，而不是重启自己的计时。
- 宽限期结束之后才重连的手机，现在读到一份空的完整列表并退休这些卡，而不是把它们当成可作答重新打开。桥一直在做的撤回从此可被观察；对一张确实活得比撤回更久的卡，`question.answer` 仍回 `question-unknown`。
- 列表今天不分页、也没有条数上限：`complete` 的存在是为了让将来的部分应答能回 `false`，而读到 `false` 的客户端不退休任何卡。这个方法只是读桥自己的认领表——不调宿主、不订阅、不起定时器——所以手机在每条新连接上问一次，对宿主零成本。
- `question.request`、`settled`、`question.answer`、认领与撤回全都不变。`hello.r.minor` 因这项能力的公告升到 13；两个名字都不声明的客户端，看到的握手、事件与拒绝与之前逐字节一致。
- 验证：本包 41 个测试文件、571 个用例全绿，`pnpm typecheck` 干净；deadline 相关用例覆盖首帧随提问本身一并广播、节流、订阅无帧结束或直接失败、宿主 deadline 到点释放，以及首帧之前就被宿主放弃的认领。认领、铸造 id、open/continued 分流、`question-unknown` 各分支、宿主错误穿透、最后一个客户端离开后宽限期结束才让位、以及 legacy 客户端路径都有用例。列表一侧的用例覆盖：两种状态连同冻结 payload（含 deadline）的全体集合、宽限期结束后被撤回的提问、从未声明该能力的客户端、读取后状态与宿主逐字段不变、带参数的载荷被拒。「读不出认领表」那条拒绝今天是够不到输入的保护：认领表在内存里，读它的是一次纯投影。
- 这里未验证：对真宿主进程的端到端。`@deepseek-ai/dsh-user-questions` 在本包无法 resolve，认领是用 waterfall 形状的替身驱动的，类型也本地声明。这条往返需要一次人工确认。
- 桌面 profile 解析这个包走的是 `dsh-web/.pinned/dsh-remote-bridge` 那份拷贝，而不是 checkout，所以只重建 `packages/dsh-remote-bridge` 对运行中的宿主不产生任何影响：要把 `lib/` 同步进 pinned 副本再重启宿主。记下来是因为它让第一次真机验证白跑了一趟。
- 监听器用 `prepend` 注册：宿主的 waterfall 是先答者得，桌面客户端自己的应答者会在本桥被咨询之前就把每个提问认领走（在监听器入口写诊断证明过它从未执行）。**当有声明了该能力的手机在线时，桌面面板被刻意不启动**：桥能结算宿主那次 ask，却无法关掉宿主 UI 自己打开的面板，启动了就会在手机已经作答之后留下一张不消失的卡。手机不在线、以及认领被撤回时，仍然交给链上其余应答者。
- 提问在认领时只广播一次，只发给当时已经声明该能力的客户端。正在重连、或因重启被清空状态的手机从未见过那一帧，问题于是留在宿主上、手机上一个可作答的卡片都没有。因此 `hello` 会把所有未结算的认领连同它们各自的实际状态重新发给刚声明的连接（`BridgeHub.replayQuestions`，在 `attach` 里接线，所有构造路径都覆盖）。认领仍会在「没有任何人能收到」时撤回：收不到的客户端之后也收不到，让宿主的 ask 一直挂着比交给别的应答者更糟。
- 审批现在走同一套形状。无论连接声明了什么，`approval.request` 依然只向每条已配对连接广播一次，而 `approvals.v1` 只门控第二次送达——把仍未结算的认领重放给在 `hello` 里声明它的连接。能力为何门控重放而不门控首播、为何不列入 `SERVED_CAPABILITIES` 也不伴随 minor 升级、以及 `ApprovalRegistry` 唯一的结算路径如何让已释放的审批不复活，都记录在 [协议笔记](2026-10-16-remote-bridge-protocol-v1.md) 里；两条重放挂在同一个 `onDeclare` 钩子上，因此同时声明两个能力的连接会收到两套集合。
