# Agent Note: Plain-HTTP LAN reopens stayed on a path no device credential can answer

Status: implemented

## Problem

经纯 HTTP 局域网 URL 配对的手机（`lanBind: true` 的默认形态）无法回到应用。该源永远不是安全上下文，因此[重开 service worker](2026-08-30-remote-reopen-service-worker.zh.md)从不在那里注册——而捕获脚本仍然把地址栏改写到 `/`，正是那条不依赖 cookie 的手机流程无法满足的路径。接下来的刷新、标签恢复或书签打开都会落到 harness 兜底座的浏览器认证 401（"dsh web authentication required; reopen the URL printed by dsh web."），而插件自己的设备 cookie 就躺在同一个浏览器里没人用。唯一的回归方式是重新配对。

其背后的结构事实：重开 worker 与「地址栏停在裸根路径」其实是同一个决定。worker 存在的意义就是接管对 `/` 的导航；它不存在的地方，地址栏就不能是 `/`。

## Decision

捕获脚本按自己运行所在的源来选择重开路径：

- `window.isSecureContext ? '/' : '/pair-app'`——安全上下文分支是既有的、由 worker 拥有的 canonical root，保持不变；另一分支把插件自有的落地路径留在地址栏。
- 两个目标都是裸路径，因此一次性授权仍随改写一起消失，设备凭据不会进入历史、地址栏或任何被分享出去的 URL。这正是被采纳的形态与原笔记否决的 `/pair-app?device=` 形态的区别：只有路径，没有凭据。
- `window.isSecureContext` 在既有的 `try` 块内读取。从未暴露该标志的引擎读作假值，于是走落地路径——这是安全的方向：`/pair-app` 总有应答（应用壳或双语重新配对页），`/` 只有在手机并不持有的浏览器认证 cookie 下才有应答。
- 它留在的落地页就是二维码流程本来就会落到的同一个路由，因此不需要新表面、新路由或新栅栏：有效配对 cookie 返回打过补丁的应用壳并刷新 `lastSeenAt`，被撤销或已清空的 cookie 返回 `pairingFailurePage`。
- 官方应用壳为这次改动不需要任何兼容性验证。harness 的 index 文档带 `<base href="./">`，因此在 `/pair-app` 下相对的 `api/pair/*` 调用与模块资源仍解析到与 `/` 相同的源根；而且 SPA 完全不读 `location.pathname`。

## Alternatives considered

- **对任何携带有效设备 cookie 的请求都在 `/` 交付应用壳。** 否决：`/` 属于 harness 兜底座，由 `frontend-static` 拥有并由 `connection.authorizeIndex` 门控。在那里放一条插件路由会把这份文档从该座位上所有其他消费者手里拿走，包括回环桌面以及未来任何 harness index 行为，只为解决一个地址栏里的路径就能解决的问题。影响面是整个源，而修复只要两行。
- **到处都保留 `/`，并给手机一枚 harness 浏览器认证 cookie。** 原笔记已在架构层面否决，此处不变：有了那枚 cookie，SPA 会直连 `/api`、通过连接围栏，而在本 cohort 没有任何组件发出 `api/gate` 的情况下停止将不再能切断设备。
- **把重开 worker 扩展到非安全源**（在别处注册、代理该源、或用 https 隧道）。否决：每一种都要为手机已经持有的那枚 cookie 增加一个活动部件，而隧道方案还会改变局域网流程之所以被选择的信任前提。
- **在纯 HTTP 下把地址栏停在 `/pair-app?device=<id>`。** 否决：设备 id 是活的会话凭据，而整套授权加落地页的设计正是为了让它远离 URL。

## Consequences

- 纯 HTTP 局域网上已配对的设备刷新、恢复标签或重开书签时会落在 `/pair-app`，并凭配对 cookie 拿回应用，每次重开都像 https 上 worker 那样刷新活跃时间。无需重扫；被撤销的设备在那里看到的正是双语重新配对页。
- 设备门控的落地页首次可能从浏览器历史条目进入，因此它在 cookie 被清空时的行为成为用户可见表面的一部分；`tests/routes.spec.ts` 固定了它（失效页、无应用壳、无捕获脚本）。
- 浏览器拒绝注册 worker 的安全源保持原样，`/` 上的重开仍会退回 harness 栅栏——该缺口被记录为已知限制而非修复，因为被拒绝的注册在页面内没有任何信号可供捕获脚本据此行动。
- 纯 HTTP 的地址栏比 https 多一个路径段。应用壳没有任何代码读取该路径，因此这只是外观差异；对比两种传输截图的人应当预期到它。
- 现在有一处事实按设计存在于两处：本笔记拥有「按源决定的重开目标」，包 README 拥有它的用户侧契约。

## Testing

- `tests/app-shell-capture.spec.ts`（新增）：把注入脚本放到它所触碰的四个全局变量的假实现上运行。非安全上下文保留 `/pair-app`、写入设备 id、发布 host 模式标记、不注册任何 worker，且留下的是无查询串的路径，既不含授权也不含设备 id；安全上下文保留 `/` 并以 scope `/` 注册 `/pair-app.sw.js`；缺少该标志的引擎解析到落地路径。
- `tests/routes.spec.ts`：落地页拒绝没有有效配对的调用者（双语重新配对页、无官方应用壳、无捕获脚本），因此重开路径仍是一道凭据门。
- 包内测试全绿；仓库 `pnpm typecheck`、`pnpm test`、`pnpm test:standards`、`pnpm docs:check`、`pnpm i18n:check` 通过。
