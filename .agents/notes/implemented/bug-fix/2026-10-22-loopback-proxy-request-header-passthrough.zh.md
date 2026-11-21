# Agent Note: 远程通道透传调用者自己的请求头

Status: implemented

## Problem

`packages/dsh-remote-web-ui/src/loopback-proxy.ts` 用一个固定白名单重建每个再发起的 HTTP 请求：`host`、`sec-fetch-site`、`content-type`、`content-length`、`accept`，以及进程自己的内层凭据。白名单没听说过的头一律停在通道这一层，包括插件用来认证自己调用头的那些。

报告来自 `@michengai/dsh-im-connect` 的 `POST /api/dsh-im-connect/sessions/ensure`：浏览器半区带着 `x-dsh-im-connect-client: 1` 发出，但经配对后的远程桌面，该标记从未到达上游路由，路由的写操作护栏因此回 `403 {"error":"forbidden mutation request"}`，侧栏无法恢复 IM 频道会话。同一条路由走本机回环直连正常，由此把缺陷定位在转发层而不是插件或配对会话（issue #1925）。

白名单本身也是长期成本：每接入一个用自有标记认证的插件，都要先改这个文件，远程桌面才能用。

## Decision

再发起的请求除本通道自己掌握的头之外全部透传，于是插件自己的标记到达上游的方式与直连回环一致。

- **改写后端而非透传**：`host` 改成 `127.0.0.1:<port>`；`sec-fetch-site` 合成为 `same-origin`；`cookie` 换成进程自己的浏览器认证内层凭据（调用者的配对 cookie 永不离开本进程）。
- **丢弃调用者自己的源**：`origin` 与 `referer`。回环围栏会把 Web 的 `Origin` 与 Host 头比对，而那个 Host 现在指向本机回环，原样透传会让每条路由都拒绝（与 issue #1725 同类的缺陷）。
- **丢弃浏览器 fetch 元数据**（`sec-*`）：它描述的是外层请求而非再发起的请求。因此 `sec-fetch-site` 只能是合成值、调用者无法自己断言；`sec-fetch-mode` 与 `sec-fetch-dest` 也无法让一次 fetch 自称是文档导航。
- **丢弃逐跳头**：`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`，以及调用者在自己 `Connection` 头里点名的每一个名字（RFC 9110 7.6.1）。
- **丢弃转发标记**：`forwarded`、`x-forwarded-for`、`x-forwarded-host`、`x-forwarded-port`、`x-forwarded-proto`、`x-real-ip`、`cf-connecting-ip`。再发起的请求是回环请求；`shared/host/loopback.ts` 把 `cf-connecting-ip` 或 `x-forwarded-for` 视为「中间有跳」，带上边缘的戳会让本机每个围栏都拒绝这条通道。这也让[带转发头的请求一律视为远程](2026-10-19-reverse-proxy-loopback-fence.zh.md)所记录的事实继续成立。
- **丢弃无 cookie 的设备凭据** `x-dsh-remote-device`：通道的门在入口消费它——与剥掉 WebSocket 的 `?device=` 参数同理——活凭据不该流到本机端口上其他观察者手里。
- **丢弃那些要求响应侧描述它的请求头**：`accept-encoding`、`range` 与 `if-range`。响应方向复制的是一张固定头列表，其中既没有 `content-encoding` 也没有 `content-range`，邀请上游压缩或分段只会把没有任何元数据描述的字节交出去。转发这两个响应头是针对响应方向的另一项改动。

重复出现的请求头会折叠成一个逗号连接的值，与 node 在接收侧折叠重复头的方式一致，因此重复的自定义头仍以一个逻辑值到达。

## Alternatives considered

把 `x-dsh-im-connect-client` 加进白名单（issue 自己给出的最小补丁）被否决：那等于在本包里点名修一个插件，下一个用自有标记的插件会以同样方式失败，而文件里会攒下一串本不该由它知道的第三方头名。

透传转发标记被直接否决：`isProxiedRequest` 会拒绝带 `cf-connecting-ip` 或 `x-forwarded-for` 的请求，因此在任何隧道部署下每次再发起的调用都会被判为远程，整条通道回 403——那会让这次修复反向变成回归。

透传调用者的 `origin` 同理被否决：Origin/Host 相等检查跑在改写后的回环 Host 上，原值只可能导致拒绝。什么都不透传正是既有白名单的做法，也是对的。

透传 `x-dsh-remote-device` 被否决：它是门已经消费掉的活会话凭据，而 WebSocket 那条腿早已出于同样理由剥掉了它的查询参数孪生值。

透传 `accept-encoding`（并放开对 `range` 的排除）同时把 `content-encoding` 与 `content-range` 带回来，是推迟而非采纳：那会改动响应方向，需要对压缩与分段上游各写测试，而报告要的既不是压缩也不是分段——被报的缺陷在请求头上。

把同样的透传扩展到 WebSocket 握手（`proxyLoopbackUpgrade` 只转发 `sec-websocket-*`）被排除在本 issue 范围外：没有报告的路由需要它，而握手是手写进裸套接字的，需要单独评审。该缺口记录在此，不做暗示性的补齐。

## Consequences

- 用自定义请求头认证自己调用的插件，在配对门之后能正常工作，本包不再需要为某个插件单独改动。
- 插件现在可能在再发起的那条腿上看到任意由调用者提供的头。这并不是新增权限：该请求本就以完全控制权限的配对设备身份到达，而且「客户端自断言的头不是信任边界」是本仓既有规则。
- 通道自己掌握的头一个没变：回环权威、合成的同源标记、进程凭据，以及 origin/cookie/转发标记的缺失都仍然成立，因此没有任何原本拒绝再发起请求的围栏开始放行。
- WebSocket 握手仍保留白名单，所以用自定义头门控 upgrade 的插件依旧失败；这条缺口写在本文档里，而不是假装两边已对齐。

## Testing

`packages/dsh-remote-web-ui/tests/loopback-proxy.spec.ts` 在真实 HTTP 服务器上跑这台代理，三条新增用例钉住边界：

- 插件的标记头与 JSON 体原样到达上游（即被报告的 `/api/dsh-im-connect/sessions/ensure` 形状）；
- 上游看到的是回环权威、合成的 `sec-fetch-site: same-origin`，以及替换掉调用者配对 cookie 的进程凭据，`origin` 与 `referer` 缺席；
- 设备凭据、转发标记、浏览器 fetch 元数据、`accept-encoding`、`range` 以及调用者经 `Connection` 点名的头全部缺席，而通道不拥有的头照常通过。

区分度用打补丁前的源码核对过：第一条与第三条在那里失败，第二条两个版本都通过（它钉住的是不该移动的安全属性）。改动一并带上后，本包测试、`typecheck`、`pnpm test:standards`、`pnpm docs:check` 与 `pnpm emoji:check` 均为绿。
