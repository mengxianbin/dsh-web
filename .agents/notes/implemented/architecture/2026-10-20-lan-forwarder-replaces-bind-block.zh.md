# Agent Note: 局域网可达性是运行时转发器，而不是 webserver 行的受管块

Status: implemented

部分取代[远程控制复用官方界面](2026-08-29-remote-control-reuses-official-ui.md)（其中局域网绑定那一条）、[局域网绑定块先问已安装的宿主接受哪些绑定地址](../bug-fix/2026-10-17-remote-web-ui-wildcard-bind-capability.md)，以及 [issues 1389/1390/1381](../bug-fix/2026-09-06-issues-1389-1390-1381-fixes.md) 与 [issues 1743/1751](../bug-fix/2026-09-29-open-issues-resolution-1743-1751.md) 这两轮 profile 写入修复：那些 note 修的那个块已经不存在。[带转发头的反代请求一律判为远程](../bug-fix/2026-10-19-reverse-proxy-loopback-fence.md) 拥有转发器所依赖的判定规则。

## Problem

局域网访问开关以受管块的形式存在于 profile `cordis.patch.yml` 中：`writeLanBind` 重写两行标记注释之间的一个 `- id: webserver` 条目，并把该行的整个 config 换成静态字面量。这个安排有三个承载性前提，而每一个都是它所造出的架构里的缺陷：

- 块写入的那一行正是 harness 取绑定的那一行。同 id 补丁行整行替换该行 config，于是官方的 `host: !!js ctx.webStartup.host ?? '127.0.0.1'` 表达式被替换掉，`--host`/`--port` 再也到不了服务端，插件猜出来的字面量成了绑定。
- profile 补丁受 Host 监视，因此写入会重组合正在运行的进程、重绑一个活着的监听器。而安装的 webserver schema 所拒绝的字面量是一个本插件无法修复的启动砖：它只在那个拒绝启动的 webserver 之后才会挂载。
- 可达性活在文件的字节里：网络变化需要改 profile 再重启，卡片只能报 `pendingRestart`。

issue #1917 报告了结果：在被开关动过的 profile 上，显式 `--host` 失效了；而开关是本包唯一会写不属于自己的文件的东西。

## Decision

局域网可达性是本进程的运行时状态。插件不拥有任何绑定：profile 的 `- id: webserver` 行属于官方 bundle，永不被写，`--host`/`--port` 能到达它，宿主继续监听 `127.0.0.1`。可达性来自一个转发器（`packages/dsh-remote-web-ui/src/lan-forward.ts`）：

- 它监听本机的第一个局域网 IPv4 地址、web server 的实际端口，把每个请求转发到同一端口上的 `127.0.0.1`——HTTP 与 WebSocket upgrade 一视同仁，每一跳各自重建自己的 hop-by-hop 头。
- 请求的 Host 与转发头归它所有：客户端提供的值一律丢弃、绝不追加，由转发器盖上它被到达时的局域网权威以及 `X-Forwarded-For` 与 `x-forwarded-proto`。因此回环上游这一跳是以被转发请求的身份到达的，每一个判断「这是不是桌面」的围栏都会拒绝它，而面向手机的那些围栏仍与二维码链接宣传的局域网权威匹配。
- 计划（`forwardPlanOf`）只会返回具体的接口地址，因为通配地址会与同一端口上的回环监听器相撞。开关关闭是 `off`；运维用 `--host` 把宿主绑到网络是 `host-bind`，转发器让出该端口；本机没有局域网 IPv4 地址是 `no-address`，卡片会如实说明。
- 抢不到的绑定（网络变化后地址消失、端口已被占用）只损失局域网入口：回环监听器永不受影响，失败会记入日志并上报，宿主不会变砖。
- 本插件截至 0.4.8 写下的旧版受管块会在每个进程首次激活时被清除一次（`removeManagedBlock`）：临时文件原子替换并保留文件权限，只在这些标记确实存在时动手，且不回写任何内容。清除失败会大声报错，因为残留的块会在此后每次启动继续替换绑定。
- 状态帧携带 `forward { listening, host, port, reason, error }`、与可达的 `bindHost` 并列的 `localBindHost`、`legacyBlockRemoved`，以及 `pendingRestart: false`——该字段为卡片既有的读取方保留，而 `lanBind` 是 schema-volatile，因此开关现在绑定的是下一次请求而不是下一次启动。
- 每一个可达性消费者都跟随转发器：`lanEdgeHost` 与 `applyLanBases` 把转发器的地址发布为配对服务的局域网基址，因此二维码链接与面向手机的围栏始终与局域网客户端实际拨的地址一致。

## 这条边界

有一个后果是边界而不是缺陷：web server 绑在 `127.0.0.1` 之后，harness 的 `/api` Host 围栏对局域网权威返回 403，因此局域网浏览器不再到达原生 `/api` 面——客户端把传输改到本插件门控的 `/remote` 网关。要在局域网权威上恢复原生 `/api`，需要 harness web server 的 `trustedHosts`，这不在本仓库范围内；运维自己用 `--host` 把宿主绑到网络时，那块面只由 harness 围栏约束。包 README 如实写明这一点，而不是暗示局域网开关是一种通用的 API 暴露手段。

## Alternatives considered

保留受管块、只把它做得更安全（0.4.5 到 0.4.8 那几轮加固）被否决：真正的问题是「一个文件可以拥有一个活着的监听器」这个前提本身，所以每一次修复都让 `--host` 继续失效、让开关继续绑定重启。

只在拒绝通配绑定的宿主上保留受管块（即写具体的局域网 IPv4 字面量）被否决：那正是本 note 之前的状态，它仍会因为文件里留着旧字面量而在地址变化后变砖，也仍然吞掉 CLI 旗标。

让宿主自己绑 `0.0.0.0` 并放弃写 profile 被否决：安装的 webserver schema 拒绝通配地址（见[那份能力 note](../bug-fix/2026-10-17-remote-web-ui-wildcard-bind-capability.md)），而且整网绑定还会让 harness 的 `/api` 围栏自动信任局域网字面量，这正是本包刻意避开的姿态。

改为在文档里教用户自己跑 `socat` 或反代、而不发布转发器，被否决：这是没有任何测试覆盖的运维步骤，每次地址变化都会坏，而且对卡片渲染的状态帧完全不可见。

为局域网地址再跑第二个 web server 实例被否决：两个监听器争同一端口正是转发器存在的理由，web server 只拥有一个监听器。

复用本包已有的回环代理（`loopback-proxy.ts`）承担局域网这一跳被否决：那条路径的存在意义是用进程凭据再发起桌面自己的 `/remote` 流量，而局域网入口必须按设计保持未认证，并且必须改写那些否则会让网络请求看起来像本机的头。

## Consequences

- `--host`/`--port` 恢复常规语义，本包除「删除旧版本留下的块」之外没有任何代码路径会写 profile 文件。
- 网络变化既不需要改 profile 也不需要重启：接口列表在每次对账时重新采样，因此翻一次开关就够了。
- 抢不到绑定时是带原因的局域网故障上报，而不是一台死掉的宿主。
- 仍带着旧版 `0.0.0.0` 块的机器需要一次手工编辑，因为宿主在本插件加载之前就拒绝该值，清理在那里根本跑不到。其余所有旧版块都会被自动清除，README 为那一种形态保留手工步骤。
- 原生 `/api` 面不再能从局域网权威到达，因此局域网浏览器走 `/remote`；上面的边界一节与 README 安全模型都写明了这一点。
- 转发器现在是与安全相关的代码：它必须继续丢弃客户端的 Host 与转发头，`packages/dsh-remote-web-ui/AGENTS.md` 携带这条规则，以及「改动它必须同时移动双语 README 与本包测试」的要求。

## Testing

- `packages/dsh-remote-web-ui/tests/lan-forward.spec.ts`（11 项）端到端钉住形态：伪造的回环 Host 会被替换成局域网权威，请求因此不是桌面；客户端无法夹带自己的转发头；局域网监听器与 web server 同端口不同地址并存；端口被占用与地址已消失都会上报且回环监听器继续服务；WebSocket upgrade 带着局域网权威到达；dispose 会释放端口；同一目标启动两次只保留一个监听器。
- `tests/lan-bind.spec.ts`（15 项）、`tests/lan-bind-plan.spec.ts`（12 项）、`tests/lan-bind-status.spec.ts`（10 项）与 `tests/lan-bind-status.spec.tsx`（10 项）钉住计划原因（`off`、`host-bind`、`no-address`）、状态帧字段（`forward`、`localBindHost`、`legacyBlockRemoved`、`pendingRestart`）、一次性原子清除旧块，以及卡片对这些状态的渲染。
- `tests/port-unbound.spec.ts`（8 项）覆盖「局域网入口从不写绑定」：没有任何代码路径写 web server 行，旧块清除先于局域网入口与防火墙执行，抢不到的绑定被上报而不是抛出，CLI `--host` 以让出端口的方式被尊重而不是被改写，本机没有局域网地址会被明确告知而不是静默跳过。`tests/lan-bind-hmr-nesting.spec.ts`（4 项）把这项工作挡在设置事务之外，并且每个进程最多只碰一次 profile、且只为删除。
- 仓库门禁：改动下 `node scripts/verify-docs.mjs`、`pnpm emoji:check`、`pnpm i18n:check`、`pnpm test:scripts` 与 `pnpm test:standards` 均为绿，上面这些 spec 即 `pnpm -r test` 中受影响的那些 lane。GUI 轮次（转发器在局域网地址上监听、手机从该地址完成配对）即包 README 里的手动 E2E。
