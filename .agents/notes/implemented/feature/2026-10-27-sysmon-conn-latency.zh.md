# Agent Note: Sysmon 网络读数——连接段取代 TTFT

Status: implemented

## Problem

v4 网络读数（[sysmon-net-reading](2026-10-27-sysmon-net-reading.md)）量的是
TTFT——attempt 起始帧到首个 chunk。TTFT 在协议栈上太高：服务端排队与首 token
生成搭在本该是网络信号的读数里，毫秒量纲的网络分量被秒级服务等待淹没，它回答的
是「模型有多慢」而不是「链路现在健康吗」——对第一时间粗粒度问题定位意义有限。
用户同日钉了两条判据（ask id `sysmon-net-direction`，task
`#sysmon-conn-latency-1027`）：纯连接延迟才与 CPU/内存/磁盘读数同等维度；TTFT
的层位拉低了它首瞥诊断的价值。双读数的失败半区与「零额外流量、不加主动探测」
裁定继续有效。

## Decision

第 4 格改为显示**纯连接延迟**——DNS 解析 → TCP 连接 → TLS secureConnect——在
承载本次调用的同一条真实模型请求的 socket 层被动打点：

- `src/host/conn-tap.ts` 包装 undici fetch 栈调用的进程级入口
  （`net.connect`、`net.createConnection`、`tls.connect`），用 WeakMap 记录每个
  首跳，每次 TLS 握手完成报一段。直连握手从 `tls.connect` 调用起算（DNS + TCP +
  TLS 全段真网络）；本机代理 CONNECT 隧道把回环首跳与 TLS 腿链接、从首跳起算到
  secureConnect——回环 TCP + CONNECT 应答 + 隧道握手，以真网络为主。`connVia`
  随载荷携带形态（`direct` | `proxy`）。
- `src/host/net-observe.ts` 保留 attempt `start` 帧作**归因窗**：已结算的连接段
  归给最老的未归因 attempt，无 pending 即整体丢弃——模型请求之外的背景流量进不
  了读数。`chunk`/`end` 只负责关窗——复用 keep-alive 热连接的请求没有新连接段可
  报（文档化的损耗；undici 空闲超时本来就把每步的常态造成新连接）。
- `src/core/net.ts` 用 `noteConnect(ms, via)` 替换 TTFT 结算。10 分钟滑窗、
  `TIMEOUT`/`TRANSPORT` 失败计数、`{ prepend: true }` 失败观察者、
  `netWarnFailures` 全部零改动。载荷以 `connMs`/`connAt`/`connVia` 换掉
  `ttftMs`/`ttftAt`，并保留 `ttftMs: null` 兼容桩：修订前的旧客户端轮询到新宿主
  在重启窗口里显 `—` 而非 `NaNms`（与 v4 可选 `net` 字段的降级互为镜像）。
- tooltip 删首包措辞、渲染 `连接 {conn}`，并新增诚实的取点口径行
  （`chip.netPathDirect` / `chip.netPathProxy`，zh/en + dsh-i18n 的 ru 镜像）
  ——判据源要求读数不得自称超过它实际测到的段。

## Probe evidence (2026-10-27, this machine)

- 实际出口走代理：宿主进程（pid 15000）持有 4 条 established
  `127.0.0.1:* → 127.0.0.1:7897`（clash-verge / mihomo）、直连 `:443` 为零；
  `HTTP(S)_PROXY=http://127.0.0.1:7897`、`NODE_USE_ENV_PROXY=1`，且 harness
  `util/http-proxy` 装了 undici `ProxyAgent` 全局 dispatcher。
- socket 层取点在本机 Node 24.16 上两形态皆通：直连 `tls.connect({host})` 探针
  落 lookup/connect/secureConnect = +309/+1457/+2453ms；代理路径落
  `net.connect(127.0.0.1:7897)` = +2ms（回环）再 `tls.connect({socket,
  servername})`、隧道内 `secureConnect` +1212ms。故取点不需动适配器即拿得到真
  时间戳——未触发停下简报条件。
- 探针实测排除：Node perf `http` 条目（undici 栈从不发）、fetch Resource Timing
  （代理下相位字段全部塌到同一时间戳：dl = conn = secure = 53.4ms）、undici
  diagnostics channel（会发但不带连接段时刻）。

## Alternatives considered

**TTFT 与连接读数并排显示。** 败给裁定：主格一格一指标，秒级 TTFT 挨着毫秒级
握手读数会把裁定要清除的噪声原样请回来；「请求在受伤」的那半已经有失败计数扛。

**perf hook 的 HTTP 相位计时（`phases.dns/tcp/tls`）。** Node 只对 `node:http`
客户端流量发 `http` 条目；undici fetch 栈从不产生（探针实证），读数会静默永远
不来。

**Fetch Resource Timing 条目。** Node 24 下存在，但在本机占主导的本机代理形态
后面每个相位字段都塌缩成单一时间戳——恰恰在这种配置下错，而「如实标注测的是哪
段」正是本次修订的全部要点。

**undici diagnostics channel（`undici:*`）。** 触发可靠但不带连接段时刻；从它们
倒推需要 socket 身份簿记，相比直接包 socket 层毫无收益。

**主动 HTTPS 探测。** 继续否决（v4 裁定 `q-source`）：额外流量、端点/令牌选择、
代理路径保真问题。本修订只改被动读数的取点位置。

## Consequences

- 四态展示不变（`23ms` / `⚠3` / `23ms ⚠3` / `—`）；`data-warn` 语义不动，故
  skin-center 语义契约表 `chip` 行无需改（其 `net` 键自始只描述失败告警）。
- 载荷变更双向安全降级：新客户端 + 旧宿主经 `?? null` 退回显 `—`/失败徽章；旧
  客户端 + 新宿主读到 `ttftMs: null` 桩同样显 `—`——两个重启窗口都不会出
  `NaN`。
- keep-alive 复用意味着有新连接才更新读数；窗口内模型请求全走热连接时显 `—`，
  这与「不展示陈旧值」规则一致，不是缺陷。
- tap 在宿主进程包装全局连接入口；拆卸走身份守卫（后装的包装层赢、不被误拆），
  两个方向都防异常（观察者抛错打不坏 socket）。两种行为都有测试钉住。
- 测试 67 → 82：net 窗口/格式（FIFO 归因、污染过滤、窗口老化）、tap 形态（直
  连、代理隧道、非回环首跳、错误路径、拆卸、别名恢复）、接线姿势、chip 主格与
  tooltip（含两条口径行与旧宿主降级显 `—`）、路由载荷。包级 typecheck/build 与
  仓级 `i18n:check`（16 命名空间，三个 net 键 zh/en + ru 对齐）、`docs:check`
  保持绿。
- 宿主半区生效需要重启 DSH web（归人）；客户端半区 F5 生效。
