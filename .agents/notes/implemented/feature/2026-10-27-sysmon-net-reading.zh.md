# Agent Note: Sysmon chip v4——纯被动 provider 网络读数

Status: implemented

## Problem

一天里频繁出现 `connection error` / `request timeout`，暴露了 chip 的盲区：
CPU、内存、磁盘量的都是本机，所以宿主指标可以全绿而模型链路正在塌。相关信息
全是事后的，埋在轨迹计时页（单轮 TTFT）与聊天重试横幅里——主界面上没有任何
东西回答「provider 链路现在健康吗？」，而 sysmon 原始裁定（7 点决策第 4 条）
明确把网络推迟了。

## Decision

加第四个读数，**纯被动**地由两个 harness agent 事件喂养，两者都在 profile
bundle 的根上下文上观察，零行为改变：

- `agent/assistant-stream`（emit）：attempt `start` 帧打下时间戳，首个
  `chunk` 结算为 TTFT 读数（真实请求所走那条路上的连接 + 首字节 + 首 token，
  含代理配置），无 chunk 的 `end` 丢弃该 attempt。
- `agent/request-error`（waterfall）：只统计 `LlmFailure.code` 为 `TIMEOUT`
  或 `TRANSPORT` 的失败，随后原样委派 `next()`。

两者喂进同一个 **10 分钟滑动窗口**（`src/core/net.ts`，纯逻辑、时钟注入；
剪枝发生在读取时，闲置宿主零开销）。载荷新增的可选 `net` 字段携带 `ttftMs`、
`failures`、`provider`（tooltip 用的路由标签）与 `warn`；chip 渲染
`128ms` / `⚠3` / `128ms ⚠3` / `—`，窗口内失败数达到 `netWarnFailures`
（默认 1，`0` 关闭红态）即染红。空窗口读 `—`——磁盘行「绝不展示陈旧值」的
规则，但边界按请求节奏定，而非磁盘行的 5s。

**零主动探测、零额外流量。** 被否的替代方案是周期 HTTPS 探测：它自带
限流/流量面、要选免 token 的端点、还得复刻 harness 代理设置才测得到真实
路径——而这些数字真实请求本来就在免费产出。

## Constraints

- **prepend 是承重的。** llm-retry 对可重试失败是*不调* `next()` 直接返回
  重试决定的，排在它后面的观察者恰好会漏掉最值得数的那批失败。失败监听器以
  `{ prepend: true }` 注册，先观察、对下游零改变（`tests/net-observe.spec.ts`
  钉住该姿态）。
- **Events 垫片**：固定 SDK cohort（`@deepseek-ai/dsh-agent` ^0.1.2-rc.1）
  早于 `agent/assistant-stream`，故 `net-observe.ts` 带一个纯类型的
  `declare module '@deepseek-ai/cordis'` 块，逐字镜像 harness 声明；cohort
  带上官方声明后整块删除（同键扩展会自冲突——SlotMap 垫片先例）。
- 单个非 scoped 监听器覆盖所有会话：scope 过滤派发对无标记监听器放行所有
  agent（describe-image 先例）。
- chip 保持既有降级阶梯：pre-v4 宿主根本不带 `net`（可选字段），客户端渲染
  破折号；404 仍隐藏整枚 chip。

## Alternatives considered

**主动 provider 探测（周期 HTTPS 往返）。** 按 2026-10-27 裁定
（`q-source`）否决：额外流量、端点/token 选型、代理路径保真问题——而被动
观察本来就搭真实请求路径的便车。若将来「闲置期也要恒活读数」比零流量更重要，
可作回退方案保留。

**只给裸延迟毫秒数。** 同一裁定（`q-form`）否决：请求超时时恰好在信号最
重要的时刻*产不出*延迟值——失败计数才是观测症状的直接读数，TTFT 是辅助读数。
故取双读数。

**把连接/TTFB 单列为独立阶段。** 缓期：TTFT 把服务端排队时间混进了读数，
但拆出连接段需要在适配器内部再打一个点。已作为已知限制记入 m-note 设计草案。
（同日后续修订 `sysmon-net-direction` 已完成此拆分——见
[conn-latency](2026-10-27-sysmon-conn-latency.zh.md)。）

**计数只在达到阈值时才显示。** 否决：徽标本身就是计数（阈值 5 时 `⚠2`
保持不红），阈值以下的失败应保持可见而不是消失。

## Consequences

- chip 现在有四个读数（`data-warn` 多了 `net` 键；skin-center 语义契约表
  对应行已更新），tooltip 多了一行网络明细（带路由标签）与空窗口的闲置提示。
- 多 provider 注意点：窗口跨路由共享，`provider` 报最近一次观察的路由——读数
  只在 tooltip 里归属到该路由。
- 配置面多一个键：`netWarnFailures`（默认 1）。
- 包级测试 45 → 67（`net.spec.ts` 窗口/格式化、`net-observe.spec.ts` 接线
  姿态、chip 渲染用例）；docs:check 与 i18n:check（16 命名空间 / 1292 键，
  zh↔ru 含 sysmon 四个新键）保持绿。
- m-note 设计草案（`content/tech/ai/dsh/dsh-sysmon.md` v4 条目）承载裁定
  溯源：本笔记是它的实现记录。
- 同日修订：延迟半区改量连接段、TTFT 撤出主格与 tooltip（用户 ask
  `sysmon-net-direction`）——已落地形态见
  [conn-latency](2026-10-27-sysmon-conn-latency.zh.md)；本笔记保留 v4 原裁定
  记录不改。
