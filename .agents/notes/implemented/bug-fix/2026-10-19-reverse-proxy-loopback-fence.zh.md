# Agent Note: 带转发头的反代请求一律判为远程

Status: implemented

## Problem

dsh 部署常被放在反向代理后面：Cloudflare 隧道、frp，或 nginx 反代，它们终结公网连接并拨向宿主的 `127.0.0.1:<port>`。这样一跳恰好同时满足回环判定两半，而请求其实来自公网：

- 源站看到的套接字对端就是代理，代理经回环接入，因此 `request.socket.remoteAddress` 是 `127.0.0.1`；
- 代理把 `Host` 头改写成它自己的上游字面量（`127.0.0.1:<port>` 或 `localhost:<port>`），Host 这一半也成立。

两个事实各自为真、合起来毫无意义：请求从来不是本机的。共享围栏（`isLoopbackRequest`）与本仓自己的控制面判定（`packages/dsh-remote-web-ui/src/gate.ts` 的 `isLoopbackClient`）都返回 true，于是 `makeGateListener` 不校验设备 cookie 直接放行，仅限回环的配对控制面（铸造、停止、撤销、设备列表、事件流）为一个未认证的公网调用者服务；仅桌面可见的状态视图（`/api/pair/status`）也把回环快照交给了它。

区分这两种情形的信号，正是代理自己盖上的转发头：`CF-Connecting-IP` 与 `X-Forwarded-For` 只会因为中途有跳转发而存在。issue #1906 记录了这次报告。

让这个头具有决定性是有代价的，下一个报告把它点明了（issue #1919）：同一个形态也正是运维**自己**的隧道或转发器拨向回环上游时产生的。在「一律判为远程」的规则下，自建隧道上的手机连启动配对流程所需的配对状态都读不到，本包任何页面也无法经部署自己的代理到达。同级任务看板从另一侧提出了同样的需求（issue #1918）：自己运行代理的运维没有地方注入它那条白名单代理路径所需的 token。

## Decision

携带 `CF-Connecting-IP` 或 `X-Forwarded-For` 的请求永远不是桌面。回环问题改为分两层提问——一个 Host 能否被应答（可达性），以及一个请求能否被交付桌面载荷或凭据（载荷）——转发头只决定后者，不再决定前者。

- 规则只存在一份，在 `shared/host/loopback.ts`：`isProxiedRequest` 报告两个头是否存在，`isLoopbackRequest` 在读取 Host 之前直接拒绝这类请求，二者与 #1906 修复发布时完全一致。该文件在它们旁边新增一个事实 `isForwardedLoopbackRequest`：转发头、回环套接字、回环 Host 三者同时成立。它描述的是路由形态，永远不是信任决定，因此每个消费者都把它放在自己的默认关闭开关之后。以 `isLoopbackRequest` 围栏宿主路由的每个包（ssh、git-graph、market、plugin-manager、session-archive、skill-explorer、task-board、task-board-github、usage、update）经各自的生成副本继承这条围栏，副本由 `node scripts/sync-shared.mjs` 刷新。
- `packages/dsh-remote-web-ui/src/gate.ts` 把判定拆成两个。`isLoopbackUpstream`（回环套接字与回环 Host，刻意忽略转发头）回答「本进程在某个回环权威上可达」；`isLoopbackClient` 就是同一个事实在不带转发头时的形态，仍是桌面判定。`src/routes.ts` 的 `isTrustedHost` 建立在 `isLoopbackUpstream` 之上，因此隧道访客能到达配对入口页与状态视图，而铸造、停止、撤销、事件流、`lan-bind`、`api/gate` 监听器与每一个凭据继续由 `isLoopbackClient` 判定。
- `/api/pair/status` 对被转发或未配对的调用者只答最小载荷 `{ ok, paired, requirePairingForLan, phase, lanAvailable }`。完整快照（令牌过期时间、公网隧道 URL、计数）与逐设备列表只留在桌面或活着的设备上，因为过期时间与隧道 URL 的探针本身就是瞄准帮手。
- `isTrustedApiRequest` 的 Origin 断言对直连请求保持 `Origin == Host`，只对「被转发且落在回环上游」的请求改变：在那里 Origin 与本面实际服务的权威比对，因为代理改写后的 Host 命名的是访客自己的回环，而不是本机的。
- 配对路由里的 `redirectOrigin` 在请求被转发到回环上游、且配置了公网基址时，把 `/pair-accept` 的 303 指向 `publicBaseUrl`；桌面直连的导航仍留在它实际到达的权威上。
- `packages/dsh-task-board` 把这个更窄的反例做成 `trustForwardedProxy`（`Config`，volatile，默认 `false`，schema 默认值由 `DEFAULT_TRUST_FORWARDED_PROXY` 钉住，经 `resolveProxyAccess` 按请求读取，因此改动对下一次请求生效）。关闭时维持 #1906 围栏；开启后只放行 `isForwardedLoopbackRequest` 且必须同时带浏览器同源标记，显式 `sec-fetch-site: cross-site` 照旧拒绝。正是这条跨站检查取代了直连路径上的 Origin 相等断言，因为改写后的 Host 让围栏无从比对。
- 这处修复的其余性质全部不变：浏览器同源标记保持原有位置与顺序，跨站标记仍然先拒绝，真实桌面请求——回环套接字、回环 Host、无转发头——判定结果与改动前完全一致。
- 任务看板新增一条完全不读取转发头的放行路径：它桥接 Host 的 `connection` 服务，因此 Host 自己已经用 Host/Origin 围栏和签名浏览器会话认证过的请求，无需看板专用白名单即可到达看板（[connection 认证桥接](2026-10-23-task-board-connection-auth-bridge.md)）。本 note 上文的规则与其余每一道围栏均不变。

## 规则看不见的部分

规则是请求头测试，而反向代理是可配置的。这些残余风险是刻意保留并写进包 README 安全模型的，而不是藏起来：

- 被配置成丢弃这两个头的代理会把请求重新放回与桌面相同的形状，任何基于请求头的规则都无法区分它。Cloudflare 与 nginx 默认转发 `X-Forwarded-For`；手写的一组 `proxy_set_header` 若漏掉它，或写成 `proxy_set_header X-Forwarded-For ""`，则不会转发。
- 本机进程可以伪造任何请求头，正如它本来就能伪造本机工具发出的 `Origin`。本地信任模型没有任何变化：桌面依旧不需要凭据。
- 桌面外壳自己的重发服务与本包的回环代理（`loopback-proxy.ts`）都不转发转发头，因此二者不会因为这条规则被新挡住。
- 放行这个更窄的形态是运维的决定，不是检测结果：公网隧道按构造就满足 `isForwardedLoopbackRequest`，因为代理就是本进程的客户端。这也正是 remote-web-ui 只买到可达性、不发放任何凭据的原因，也是任务看板（同一形态在那里足以触达看板整套 API）把它留在默认关闭开关之后的原因。

## Alternatives considered

干脆拒绝回环 Host 的方案被否决：桌面正是从 `127.0.0.1` 提供服务，基于 Host 的封禁会连同本地应用一起打掉，只为处理代理情形。

保留一份可信代理名单（只有已配置的代理才能把请求标记为被转发）被否决为安全修复的错误默认值。它是失败开放（fail open）的配置面：未配置时不设防，而恰恰是需要这处修复的部署从来没有配置过；以「转发头存在」为准则失败关闭（fail closed）。

从 `X-Forwarded-For` 归一化出真实客户端地址再判定，被否决：除非知道可信跳数，否则该值由调用方提供，跳数一错就等于换个花样重建同一条绕过路径。本 note 实现的正是 issue 已定的决策——带转发头即非本机——它不需要知道拓扑。

只修 `gate.ts` 被否决，理由与共享围栏存在本身相同：十个同级包都以 `isLoopbackRequest` 围栏，只修一个会把这同一条绕过路径留在其余包里。

把「被转发且落在回环上游」的形态直接判为本机——issue #1919 的报告最初正是这样邀请的——被否决，因为公网隧道按构造满足该形态：一律放行等于把 #1906 的绕过路径原样交回去。正确的做法是让可达性与载荷分离，这也正是最终落地的方案。

把收窄逻辑作为参数或共享开关塞进 `isLoopbackRequest` 被否决：十一个包以该函数围栏，只有两个需要这个更窄的事实，那样决定就会随一份每个包都携带的生成文件到处走。opt-in 属于那个知道运维是否运行这一跳的消费者。

复用任务看板的 token 白名单代理路径来处理隧道，被否决：改写 Host 的代理让插件没有可比的名单条目，快速隧道的运维也没有地方注入 token。转发头加上本机回环套接字是更弱但可用的信号，这也正是它默认关闭的原因。

把完整状态快照交给被转发的调用者，被否决：快照里有令牌过期时间与公网隧道 URL，逐设备列表还持有会话凭据。配对流程从那条路由需要的只是可达性。

## Consequences

- 反向代理后面的部署不再享受桌面待遇：配对控制面对它返回 403，状态视图把它当作未配对的调用者应答，而不是交出桌面快照。这正是修复的预期结果，也是把该绕过路径当便利使用的用户能看到的可见行为变化。
- 隧道访客如今在配对流程需要的地方被应答——入口页与最小状态载荷——而每一个承载凭据的面继续拒绝它。原本依赖桌面视图的反代部署会一直拿到 403，直到它出示设备 cookie。
- 任务看板的开关对从未设置它的部署毫无影响；自己运行隧道的看板获得一条有文档的进入路径，无需 token 白名单，看板 README 写明该形态、默认值与 volatile 性质。
- 配对通道与浏览器半区不受影响：配对过的设备经它出示的归一化 Host 到达 `/remote`，隧道落地流程照常工作，因为它从未声称自己是回环。代理改写了 Host 时，303 改经 `publicBaseUrl` 离开，手机因此不会被送回自己的回环。
- 本仓自己仪表化的隧道路径不受影响：accept 限流早已按边缘追加的 hop 为被转发请求分桶，`x-forwarded-proto` 依旧只决定 cookie 的安全性。
- 仓库内每一份 `loopback.ts` 副本会同时改变，因为该文件是生成的；任何未重新同步的副本会让 `pnpm test:scripts` 变红。

## Testing

- `shared/tests/loopback.spec.ts`（18 项）覆盖围栏要求的四种情形：回环套接字 + 回环 Host + 无转发头仍为本机；任一转发头使其成为远程；非回环套接字保持远程；以及空值情形，空值不得被读成「没有代理」。同时钉住浏览器标记，包括它们在直连请求上仍自行决定。
- `packages/dsh-remote-web-ui/tests/gate.spec.ts`（25 项）在 `isLoopbackClient` 上钉住同样四种情形，并钉住闸门本身（看起来像回环的被转发请求在没有设备 cookie 时被拒绝），另加一组 `isLoopbackUpstream`：回环套接字与回环 Host 上的被转发访客可达但不成为桌面，非回环套接字或外来 Host 仍在其外。
- `packages/dsh-remote-web-ui/tests/routes.spec.ts`（52 项）在真实 HTTP 服务器上跑真实路由族：带 `CF-Connecting-IP` 或 `X-Forwarded-For` 的 `/api/pair/issue` 与 `/api/pair/stop` 返回 403，而直连调用仍返回 200；`/api/pair/status` 对被转发的调用者恰好返回最小载荷，而桌面直连仍带快照字段；只有当代理把请求转发到回环上游时，本面服务的权威作为 Origin 才被接受；`/pair-accept` 的跳转对被转发的请求指向 `publicBaseUrl`，而桌面保留自己的权威。
- `packages/dsh-task-board/tests/trust-forwarded-proxy.spec.ts`（11 项）与 `tests/trust-forwarded-proxy-settings.spec.tsx`（4 项）经生成副本覆盖那个反例：`isForwardedLoopbackRequest` 需要三件事同时成立；开关关闭时看板拒绝该形态，开启且带同源标记时放行，显式跨站提交被拒；设置卡把该开关暴露为 volatile。这份 spec 是新共享判定唯一的直接覆盖；共享源本身没有独立 spec。
- 仓库门禁：改动下 `node scripts/verify-docs.mjs`、`pnpm emoji:check`、`pnpm i18n:check`、`pnpm test:scripts`（含同步漂移门禁）与 `pnpm test:standards` 均为绿，上面这些 spec 即 `pnpm -r test` 中受影响的那些 lane。
