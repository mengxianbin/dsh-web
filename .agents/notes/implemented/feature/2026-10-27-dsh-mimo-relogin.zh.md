# Agent Note: MiMo 重登套件

Status: implemented

## 问题

dsh-usage 的 MiMo 余额探测携带平台 SSO Cookie（`MIMO_PLATFORM_COOKIE`），其过期是静默的：2026-10-25 的过期让侧栏数值在 ¥36.87 上冻结了 27 小时（[stale-fact TTL](../../bug-fix/2026-10-27-usage-stale-fact-ttl.md) 已让此类数值降级而非假装现值）。恢复手段则全靠人肉——找浏览器登录、从 DevTools 抄 Cookie 头、改环境变量、重启 dsh——而「用哪个 profile」的摩擦掩盖了真正的缺口：**没有任何通道能让 Cookie 从浏览器回到凭据存储**。TTL 修的是「说谎」，本套件修的是「怎么恢复」。

## 决策

新增仅链接的 host 插件 `packages/dsh-mimo-relogin`，围绕一个页面挂七条 loopback 围栏路由（`GET /api/mimo-relogin/page`）：

- **免登录续期**无人值守地重放平台自身票据链——`genLoginUrl` → `account.xiaomi.com/pass/serviceLogin` → 平台 `/sts`——用已存的账号 Cookie 换发 `api-platform_serviceToken`。2026-10-27 实测：只要账号 `passToken`（30 天）在档，链条无表单直接走通；`passToken` 失效后账号主机会用一个**登录页**应答行走（经典凭证表单，或 ~2026-10-30 起的 JS 渲染 SPA 外壳——其原始 HTML 无任何表单标记），此时判定 `interactive`（HTTP 409）。链条因此把「账号主机返回 HTML 而非重定向」一律判为交互步：无头行走推不动一个渲染页（没有 Location 可跟；JS/meta 跳转不会执行），判别的任何其他结果都是空转。这取代了原先基于标记的检测（`type=password` / `login-form`）——它完全认不出 SPA 外壳：2026-10-30 的过期在同一个 `/fe/service/login` URL 上空转到 `MAX_HOPS`，再拿未轮换的 jar 去探余额，误报成 `failed` + HTTP 401。人工重登由此被封顶为约每 `passToken` 寿命一次，且续期本身全程不需要浏览器。
- **登录并等待**（`/watch`，FORK mimo-relogin-watch，2026-10-30）是 interactive 判定自动转入的一键流程：附加或启动调试窗口，经 CDP 轮询两个 jar（默认 5 分钟预算，按 tick 计），登录一落地即运行抓取同款探测门并入库。操作者只在弹出的窗口里输密码，之后无需再碰页面。探测门只探测**变化过的** `serviceToken`（从未登录过的窗口带着旧 token 也不会每 tick 轰炸余额接口）；进程内闩锁让并发的第二个 watch 得到 409；窗口中途消失在连续 5 次 CDP 读不到后报 503；超时报 408。页面上的续期按钮遇到 409 会自动交给这个流程，两个入口都是一键。
- **抓取**经 CDP 从 chrome-debug 实例（端口 9224）读取两个 Cookie jar——保留为「刚在窗口登录完、想立即补抓」的手动档。
- **打开登录窗**：已运行则附加开标签，否则以专用调试 Chrome 启动（配置 `chromePath`/`chromeProfile`，默认沿用 chrome-debug 约定）；已连同粘贴一起降级进页面的「兜底通道」折叠区。
- **粘贴**是两者的手工地板通道。

所有写入路径 fail-closed：平台半区必须先用候选值通过 `GET /api/v1/balance` 探测，`credentials.set` 才会执行；账号半区的证明是消费它的那次续期成功。两个托管引用承载状态——`MIMO_PLATFORM_COOKIE`（探测燃料，dsh-usage MiMo 适配器消费）与 `MIMO_ACCOUNT_COOKIES`（续期燃料，含账号 SSO 根凭据 `passToken`）——都进 provider-managed 存储，其优先级高于环境层，因此一次探测周期内生效、**无需重启**。每次写入成功后套件会催促 dsh-usage 的 `/api/dsh-usage/refresh`，侧栏数秒内刷新新数值。

## 备选方案

- **deepseek 式 OAuth 窗口（authorize → code → exchange）**：否决，不可行——平台 `serviceLogin` 的回调以签名绑定其自有 `/sts`，不存在第三方 client 注册，除平台自身外无人能换取 code。
- **只跳转的页面（打开登录页即止）**：否决，死路——登录完成并不搬运 Cookie；问题本体就是搬运。
- **把纯粘贴页当产品（更早的「B 案」）**：仅保留为粘贴兜底；抓取与免登录续期都跑通后，只卖粘贴等于把手工地板当天花板。
- **写环境变量**：否决——进程环境要重启且在凭据接缝之外；托管存储既压过环境层又支持热发布。

## 后果

- 续期依赖平台内部 `genLoginUrl`/`serviceLogin`/`/sts` 形态；平台变更会以 `verdict: failed` 加页面链路明细呈现（非静默失效），但也意味着套件可能在无 harness 发布的情况下坏掉。
- `MIMO_ACCOUNT_COOKIES` 是 SSO 根凭据（30 天 `passToken`），与该存储内一切凭据同为明文存放；README 已写明照护要求。
- 调试 profile 默认硬编码本机 chrome-debug 路径（`D:\tech\m-note\.local\chrome-profile`）；其他机器覆盖 `chromeProfile`。
- 套件经 `cordis.patch.yml` insert（id `mimo-relogin`）挂载，仅 profile 链接、不发 npm——与 dsh-session-dispatch 同形。

## 测试

`tests/relogin.spec.ts`（17 例）覆盖：loopback 围栏；按 2026-10-27 实测 302/307 序列重放的续期链（断言 token 轮换、断言 hops 不含 ticket 参数）；**两种**登录页形态的 interactive 判定（经典表单与 2026-10-30 的 SPA 外壳——断言行走在登录页即止、且不再拿旧 jar 去探余额）；抓取的 fail-closed 探测门（未过期值与未登录窗口两种）；watch 流程（登录落地经探测门入库；旧 token 被等到且只探测一次；408 超时；窗口消失报 503——含 undefined 读取的丢失计数而非只计抛错；409 并发闩锁；开窗失败报 500）；粘贴的槽位/换行校验；开窗器的模式上报——全部缝隙注入（fetch、jar、存活探测、开窗器、sleep）。`tests/auto-renew.spec.ts`（10 例）覆盖常驻循环。typecheck、build、docs:check、i18n:check 与 aggregate:check 把门。
