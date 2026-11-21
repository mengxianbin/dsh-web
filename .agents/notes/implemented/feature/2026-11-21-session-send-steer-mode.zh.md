# Agent Note: session-send 投递模式（可选 queue/steer 字段 + ACK）

Status: implemented

## Problem

session-send 路由（[2026-10-26-session-send-route](2026-10-26-session-send-route.md)）把投递语义写死为 queue：消息发给忙会话必须等当前 turn 跑完，哪怕调用方明确知道这条消息应该影响会话正在执行的这一步。长 turn（turn p50 ≈ 13 分钟，>30 分钟占 28.1%）下，排队延迟正是这条 send 要解决的问题——跨会话 steer 此前根本没有 REST 通道，只能靠人工在 composer 打字（而这条路由存在的意义就是取代人工打字）。Host 会话控制器早已内置两种投递动词（`agent.followup` / `agent.steer`，`commands.prompt` 处按 mode 分发），缺的是线上契约而不是机制。此外调用方无从知道一条 steer 是否真的到达了模型。

## Decision

- **`POST /api/session-send` 增加可选 `mode` 字段**：`"queue"`（默认）或 `"steer"`，在 `parseSessionSendBody` 校验，其他取值 400 并点名该字段。字段缺席解析为 `queue`，因此旧线上行为逐字节保持——queue 默认是经回归测试钉死的零改动（routes.spec 断言无字段请求体解析出 `mode === 'queue'`）。
- **默认仍是 queue，因为它就是历史契约**：既有调用方（派发链、m-note 脚本）从不发 `mode`，本次部署不得改变它们的行为。
- **steer 复用 Host 既有的 pre-step 注入**：`mode: 'steer'` 直达 `commands.prompt`，由其调用 `agent.steer`——消息进入 `next-step` 收件箱，在运行中 turn 的下一个步边界被认领（忙会话在它正在跑的 turn 内读到；空闲或已停止的会话保持唤醒开 turn 的既有路径，因为空闲 agent 上的 `steer` 本就是被唤醒的 prompt turn）。零新循环代码。
- **ACK 埋点，事件驱动**：路由把 `deliveredAt` 记入 `SteerAckTracker`（新文件 `src/host/steer-ack.ts`）；包内既有 `session/event` 订阅把投递与 steer 消息的 `user/message`（按 `rpcId` = 该 prompt 的 requestId、同会话匹配）及随后第一条 `assistant/message` 配对，输出一行结构化 `[steer-ack] sessionId=… requestId=… deliveredAt=… injectedAt=… firstResponseAt=… latencyMs=…`——即影子期校准所需的 `deliveredAt → 模型首响` 时延。无定时器、无轮询、fail-open（事件畸形或 sink 抛错都不影响投递），pending 上限 256、最旧先逐出。
- **范围止于投递 + 度量**：超时窗策略（3 分钟补发 / 10 分钟判未听）不在本单，仍归阶梯档；不改 UI；不改 queue 语义。

## Alternatives considered

- 忙会话默认改 steer：拒绝——它会静默改变每个既有调用方拿到的东西（queue 语义是被钉死的契约），而且派发链说「排一条提示词」时要的不是 steering。
- 单开 `/api/session-steer` 端点：拒绝——为一个字段的差异复制整套围栏/校验/错误映射体，而 Host 本就把两种动词建模为同一 `prompt` 请求的 `mode`。
- 用探测循环或定时检查度量 ACK 时延：拒绝——事件流本来就恰好产出一次该值，轮询等于为每个会话加一个定时器；可用性门第 1 问（不新增宿主轮询）直接否决。
- 只在路由侧记 ACK（仅投递时间戳）：拒绝——投递只证明收件箱收下了消息，不证明模型读到了；校准窗口（3/10 分钟）针对的是模型首响，配对必须包含 `injectedAt` 与 `firstResponseAt`。

## Consequences

- 调用方显式选择：不写 `mode: "steer"` 就不会 steer。queue 路径与旧版逐字节相同。
- `[steer-ack]` 行是首期 ACK 数据的单一来源；阶梯档 §三 L1 的窗口（3/10 分钟）对着它校准，不对投递回执校准。
- 投递后从未进入 transcript 的 steer（中途停止、被 dispose）在上限处静默老化——不出行，这是正确的：没有可度量的模型响应。
- 与本包所有路由改动一样，生效需 Host 重启；`GET /api/session-dispatch/health` 加一次指向沙箱会话的探测 send 即可验证。

## Testing

`tests/routes.spec.ts` 钉住线上契约：无字段体默认 queue、`steer` 透传、未知 `mode` → 400 且在触碰会话服务之前拒绝，围栏/校验套件原样保留。新增 `tests/steer-ack.spec.ts` 钉住 tracker：投递→注入→响应三段配对及精确行格式、注入前不出行、跨会话或跨 requestId 不配对、queue 投递不出行、上限逐出、畸形事件 fail-open。包内 119 测试全绿，另有 `tsc --noEmit` 与 `tsc -p tsconfig.test.json`。端到端忙注入语义（steer 在步边界进入捕获的 LLM 请求体、queue 不进入）由 harness 侧 steer-insert 语义 spec 钉住。
