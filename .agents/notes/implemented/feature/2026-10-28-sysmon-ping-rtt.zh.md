# Agent Note: Sysmon 网络读数——单目标 ICMP 往返取代连接段（A 案）

Status: implemented

## Problem

连接段读数（2026-10-27，[sysmon-conn-latency](2026-10-27-sysmon-conn-latency.md)）
量纲诚实，但仍是**多段叠加**：本机代理 CONNECT 应答 + TLS 隧道握手 = 两三个
往返，且压在跨境路径上——chip 于是显示 477ms 量级的数字，挨着按百分比读的
CPU/内存/磁盘，一眼看去像「网络烂透了」。2026-10-28 用户反思：网络内部环节
太多，任何单一参数都表达不全，不如给【网络质量】一个**单纯**的含义。用户拿来
作参照的是自己敲的 `ping api.deepseek.com`——19ms，ICMP echo 往返：纯网络层，
数字里什么别的都没有。用户裁定（ask id `net-quality-semantics`，选项 A·推荐）：
主格读**单一国内参照点的 ICMP RTT**；跨境/代理链路的问题由失败半区兜底；又因
探测是发包行为，本裁定**取代 2026-10-27 的「零主动探测」判据**（选 A 即明示
接受低频主动探测）。

同日本机探针证据：`ping api.deepseek.com` → 123.54.208.173，平均 19ms、0%
丢包；`ping opencode.ai` → 172.65.90.20，平均 237ms——同一网卡、同一瞬间，
差 12 倍，正是「RTT 是到目的地的属性」：**固定参照点**才让单个数字有资格代表
「本机网络」。被替换读数的当日分解实测：经代理 TLS 建连 520/647ms、直连 TCP
握手 189/679ms（curl），对上 chip 当时的 `connMs=477, connVia=proxy`。

## Decision

第 4 格改为显示**对固定国内参照点发一个 ICMP echo 的往返时间**——与
`ping <目标>` 同一个概念：

- `src/host/ping-probe.ts`（新增）：启动即跑一轮，此后每 `PROBE_INTERVAL_MS`
  （60s）**在上一轮结算后**计时——慢探针/失败探针不会与下一轮重叠。spawn
  `ping -n 1 -w 3000 <target>`（隐藏窗口、stdout 管道），stdout 按 **GBK/ANSI
  解码**（探针实证：中文 Windows 管道写出的是系统代码页而非 UTF-8——首行字节
  `d5fd d4da` = 「正在」；按 UTF-8 解码会把「时间」前缀变乱码、让每次读数静默
  变 null），解析中英双语回复行（`时间=19ms` / `time=19ms`、`<1ms` 记 1），并
  保留纯 ASCII 的 `NNms` 兜底（应对系统配置成 UTF-8 输出的情形；exit 0 时回复
  行恒在统计块之前，首个记号必是回复值）。超时、丢包、非零退出、spawn 报错一律
  报 `null`。每分钟一个 32 字节包：此前裁定想避开的流量代价在此频率下可忽略，
  用户选 A 即接受。
- **失败探测什么都不记**——最后一次成功往返站住，直到 `RTT_STALE_MS`
  （150s = 两个周期 + 宽限）把它老化成 `—`。单次丢包不清空格子，持续探测
  失败才清——即磁盘行「绝不展示陈旧值」规则换到探测节奏上。
- `src/core/net.ts`：`NetMonitor` 卸掉整套 pending-attempt / 连接归因机械
  （`noteStart`/`noteConnect`/`noteChunk`/`noteEnd`、`MAX_PENDING`、FIFO
  规则——全部回滚锚 = commit `8ec42c58`），新增 `noteRtt(ms | null)`。
  10 分钟失败窗口、`TIMEOUT`/`TRANSPORT` 归类、`{ prepend: true }` 姿势、
  `netWarnFailures`、`⚠n` 徽标原样不动——**RTT 本身永不参与染红**，红态仍
  只由失败阈值决定。`provider` 改为只来自计数的失败（探针无路由属性）：tooltip
  的路由标签只在有失败时出现，绝不错把 RTT 说成某条路由的。
- 载荷：`SysmonNet` 以 `rttMs`/`rttAt`/`probe` 换下 `connMs`/`connAt`/
  `connVia`，三者连同 `ttftMs` **保留为恒空退役桩**。新客户端 + 旧宿主经
  `?? null` 降级为 `—`/失败徽标；旧客户端 + 新宿主读到空桩同样显 `—`——
  两个方向的重启窗口都不出 `NaN`，且旧客户端绝不会把残留 `connMs` 当 RTT
  （发出即为 null）。
- `src/host/net-observe.ts` 只剩一个监听器：prepend 的 `agent/request-error`
  失败计数（prepend 依旧承重——llm-retry 对可重试失败直接返回重试决定、不调
  `next()`）。`conn-tap.ts` 与 `agent/assistant-stream` 归因窗连同其测试一并
  删除，`agent/assistant-stream` 的本地 Events 垫片随之拆掉。
- 客户端：`formatNetValue` 读 `rttMs`（`19ms` / `⚠3` / `19ms ⚠3` / `—`）；
  tooltip 渲染 `{rtt}` 版 `chip.netDetail`、改写 `chip.netIdle`，并用一条
  诚实的测量口径 `chip.netPath`（携 `{target}`）替换两条握手形态注记——
  「到 {target} 的 ICMP 往返（ping）——纯网络层时延，不含 DNS/TCP/TLS 握手与
  代理开销」。包内 zh/en + dsh-i18n ru 镜像。措辞判据源 = ask
  `net-quality-semantics`（「含义更单纯」）。
- 配置：`netProbeTarget`（默认 `api.deepseek.com`；`''` 禁用探测——RTT 半区
  显 `—`，失败照常计数）。声明接口里它是可选键、schemastery 默认值运行时才
  填，故接线处显式收窄。
- skin-center 语义契约表 `chip` 行无需改（其 `net` 键自始只述失败告警）。

## Alternatives considered

**B · 双目标（国内参照 + 当前 provider 域名）**：随裁定否——读数不再单一；
且对 provider 域名 ICMP 探的是**直连路径**，真实流量却走代理隧道，量的是流量
根本不用的那条路。

**C · 保留连接读数、只改 tooltip 措辞**：否——数字仍是几百毫秒，要修的正是
这个，不是措辞。

**经代理 ping / 经代理 TCP 计时**：ICMP 穿不过 HTTP 代理；隧道内的 TCP/TLS
计时又把裁定撤掉的多段叠加请了回来。A 案语义刻意是「本机网络」而非「provider
路径」——后者的故障以计数失败形式出现。

**每次探测成功重置失败窗口**：不做——失败半区的 10 分钟语义是此前双读数裁定
钉死的，A 案只换延迟取数来源。

## Consequences

- 四态与告警语义不变（`19ms` / `⚠3` / `19ms ⚠3` / `—`；`data-warn` 仍只随
  失败阈值携带 `net`）。
- 「读数随目的地而变」从隐患变成文档化属性：同一张网，到国内参照 19ms、到
  跨境任播 ~237ms——固定参照点正是单数字能代表「本机网络」的原因；跨境健康度
  活在 `⚠n` 里。
- 探测节奏活在宿主侧、随插件 effect 消亡（disposer 清定时器、杀在途子进程、
  压制迟到结果）；定时器 unref，绝不拖住进程退出。
- 测试 81 例（82 − 删除连接段/归因套件 + 新增探测套件）：`ping-probe.spec.ts`
  覆盖解析（中英、`<1ms`、ASCII 兜底、超时/null）、按探针实证字节形状的 GBK
  解码、编码标签兜底，以及循环体（结算后计时、失败/spawn 错上报、spawner 参数、
  退场姿势）。分文件：net 12、net-observe 3、ping-probe 12、chip 18、seats 7、
  routes 4、sampler 9、sample 16。
- 门禁绿：包级 typecheck / test（81）/ build；全仓 typecheck、`docs:check`
  （README 配对经 `docs:write-pair` 重录）、`i18n:check`（16 命名空间、
  1293 zh = 1293 ru）、dsh-i18n 测试（10）。全仓 `pnpm test`（--no-bail）：
  21/23 包绿；两处红均在本批之外——`dsh-task-board`（本批 0 触碰；隔离复跑
  334/334 绿，负载抖动定性，与在案 dsh-doctor / dsh-plugin-manager 同族）与
  sysmon 自身那轮撞进本批编辑窗口（定稿状态 81/81）。
- 宿主半区需重启 DSH web 生效（归人）；客户端半区 F5 生效。重启窗口内恒空桩
  让两代 bundle 都显 `—` 而非 `NaN`。
