# dsh-mimo-relogin

[English](README.md) | 中文

## 概述

纯 host 端套件，负责给 dsh-usage 的 MiMo 余额探测补给新鲜的 `MIMO_PLATFORM_COOKIE`。它提供一个 loopback 页面（`GET /api/mimo-relogin/page`），含三个动作与一个粘贴兜底：

- **免登录续期**（`POST /api/mimo-relogin/renew`）无人值守地重放平台自身的票据链——`genLoginUrl` → `account.xiaomi.com/pass/serviceLogin` → 平台 `/sts`——用已存的 `MIMO_ACCOUNT_COOKIES` 换发新的 `api-platform_serviceToken`，全程不开浏览器。2026-10-27 实测：只要 30 天的 `passToken` 还在，链条无表单直接走通；`passToken` 失效后落到凭证表单（HTTP 409，`verdict: interactive`）。这让人工重登的频率上限约等于 `passToken` 的寿命（约 30 天一次）。
- **抓取**（`POST /api/mimo-relogin/capture`）经 CDP 从 chrome-debug 实例（约定端口 9224）读取两个 Cookie jar 并入库——**仅当**抓到的平台 jar 通过 `GET /api/v1/balance` 探测之后。
- **打开登录窗**（`POST /api/mimo-relogin/open`）：已运行则附加开新标签页，否则以专用调试 Chrome 启动并直达平台。
- **粘贴**（`POST /api/mimo-relogin/paste`）是手工地板通道：`slot=platform|account` 加单行 Cookie 头；平台半区与抓取同款余额探测门（不通过探测的值永不入库）。

所有路由先过共享 loopback 围栏；Cookie 值不进日志、不进响应（只报名字与长度）。写入成功后套件会向 dsh-usage 的 `/api/dsh-usage/refresh` 发起探测催促，侧栏余额数秒内刷新。

常驻 **auto-renew** 循环（FORK mimo-relogin-l3，2026-10-29）按定时器重放同一条静默续期链：apply 后 60 秒跑首跳（因此每次重启都会在 `dsh-web.log` 留下首跑日志），之后每隔配置值跑一次（配置间隔被钳到 **24 小时下限**）。30 天 `passToken` 还在时全程无人值守；一旦链条报 `verdict: interactive`，循环**暂停**——不自动重试，页面仍是唯一入口——直到下一次成功的人工续期 / 抓取 / 账号粘贴再重新武装。所有结果都以 `[dsh-mimo-relogin] auto-renew:` 前缀入日志；调度按进程计，重启即重新武装。

套件写入两个托管凭据（provider-managed 存储，优先级高于环境层，因此**无需重启**）：`MIMO_PLATFORM_COOKIE`（dsh-usage MiMo 适配器的探测燃料）与 `MIMO_ACCOUNT_COOKIES`（续期燃料——含账号域 SSO Cookie（包括 `passToken`），须与任何登录态密钥同等对待）。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 完全禁用本套件。 |
| `chromePath` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | 冷启动路径使用的 Chrome 可执行文件。 |
| `chromeProfile` | `D:\tech\m-note\.local\chrome-profile` | 专用调试 profile（沿用 chrome-debug 约定；与日常浏览器隔离）。 |
| `cdpPort` | `9224` | 调试端口（chrome-debug 约定）。 |
| `platformUrl` | `https://platform.xiaomimimo.com/` | 套件登录并探测的平台源。 |
| `autoRenew` | `true` | 运行常驻 auto-renew 循环（`verdict: interactive` 时暂停）。 |
| `autoRenewIntervalHours` | `24` | 自动续期间隔（小时）；钳到 24 小时下限。 |

## 安装

仅链接、仅 host——无 `dsh.client` 面，不出现在浏览器 roster，不发 npm：

```sh
dsh plugin --profile <name> add link:<repo>/packages/dsh-mimo-relogin
```

## 路由

| 路由 | 方法 | 围栏 | 用途 |
| --- | --- | --- | --- |
| `/api/mimo-relogin/page` | 任意 | loopback | HTML 页面（CSP 收紧，仅内联资源）。 |
| `/api/mimo-relogin/status` | 任意 | loopback | 调试端口存活与凭据入库标志（仅布尔）。 |
| `/api/mimo-relogin/renew` | POST | loopback | 无人值守票据链续期；链条要表单或账号凭据缺失返回 409，链条或余额探测失败返回 502。 |
| `/api/mimo-relogin/capture` | POST | loopback | CDP 抓取 + 余额探测门；调试窗口未运行返回 503，窗口未登录返回 409。 |
| `/api/mimo-relogin/open` | POST | loopback | 附加或启动调试窗口直达平台。 |
| `/api/mimo-relogin/paste` | POST | loopback | 手工写入凭据：槽位校验 + （`platform` 半区）探测门。 |

## 已知限制与遗留工作

- 续期链依赖平台内部 `genLoginUrl`/`serviceLogin`/`/sts` 的形态；平台侧变更会以 `verdict: failed` 加页面上的链路明细呈现，而非静默失效。
- 调试 profile 路径默认指向本机 chrome-debug 约定位置；按机器覆盖 `chromeProfile`。
- Cookie 值以明文存于托管凭据文件（该存储内所有凭据皆如此）；账号 jar 携带约 30 天的 SSO 根凭据，链条报 `interactive` 时应通过重新登录轮换。
- auto-renew 调度按进程计：重启会重置 24h 节奏，`interactive` 暂停会持续到一次成功的人工入库或下一次重启。
- 页面文案为中文（host 侧字符串在审计中仅计为警告）；i18n 审计对 host 侧 CJK 只告警不拦截。
