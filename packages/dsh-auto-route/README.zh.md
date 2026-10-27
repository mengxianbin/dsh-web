# dsh-auto-route

[English](README.md) | 中文

DSH Web 自动源路由（2026-10-24 裁定乙案；参数 2026-10-27 修订）：宿主内常驻
控制器轮询 OpenCode Go 计量接口（`GET https://opencode.ai/console/api/go/status`，
Bearer key 只进进程内存），以**两条上沿 + 一条共用下沿**决策：

- 三窗**任一** `used/limit >= 0.95`（未取整）→ **只移动全局默认模型**到 MiMo
  官方路由——新会话/轮换后继生在活源上，在跑会话继续干活；
- 任一 `>= 0.99` → 额外对**活跃会话集**（运行中 ∪ 近 30 分钟有请求）逐个
  `selectModel` 批切；
- 三窗**全部** `< 0.95` → 双腿一起切回 `opencode-go`。

策略状态在 loopback 围栏内的 `GET /api/auto-route/status` 只读可查——侧栏
「当前生效源」徽标的唯一权威。host-only 包：无 `dsh.client` 面，浏览器插件
清单不出现。

## 为什么

两层阈值是有意的：glance v3 UI 在 85 % 起预警标红，本控制器在 99 % 才动作——
「85 % UI 预警 / 99 % 自动动作」双层口径。harness 无 provider failover 配置、
dispatch 插件只建会话不发消息，因此切换通道与策略控制器只能自建。99 % 线 +
30–60 s 轮询在两次轮询之间存在短暂烧穿竞态；线值与节拍均可配，需要时再调。
95 % 默认线（2026-10-27）正是为这个竞态而设：后继会话已生在活源上，在途沿
漏接的代价是失败一次，而不是空一晚。

## 安装

本地 link 安装（本包不发 npm）：

```powershell
dsh plugin --profile <name> add link:<repo>/packages/dsh-auto-route
```

单行 bundle（`auto-route`）只挂载宿主控制器。重启宿主（或依赖 patch 热载）
后生效。

## 配置

裁定参数全部可配；默认值即 2026-10-24 裁定值。

| 字段 | 默认 | 含义 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `pollIntervalMs` | `45000` | 轮询节拍；超出 30–60 s 裁定区间会被夹取并记日志 |
| `triggerRatio` | `0.99` | 在途上沿：任一窗 `used/limit >=` 即批量切活跃集到 `switchTo`（未取整） |
| `defaultRatio` | `0.95` | 默认上沿：任一窗 `>=` 只把全局默认模型切到 `switchTo`（2026-10-27） |
| `restoreRatio` | `0.95` | 共用下沿：三窗**全部严格** `<` 双腿一起切回（2026-10-27 修订，原 0.70） |
| `minDwellMs` | `0` | triggered 相最短驻留；`0` = 关闭 |
| `activeWindowMs` | `1800000` | 请求新鲜度窗口（活跃集口径） |
| `switchTo` | `mimo` / `mimo-v2.6-flash` | 扳机目标（不带 effort → 用模型自身默认） |
| `restoreTo` | `opencode-go` / `mimo-v2.6-flash` / effort `high` | 切回目标（还原部署默认行为） |
| `meterUrl` | `https://opencode.ai/console/api/go/status` | 计量源 |
| `meterKeyEnv` | `OC_GO_CC_API_KEY` | Bearer key 所在环境变量名（只进内存、绝不入日志） |
| `balanceGuardrail` | `enabled: false` | mimo 余额护栏——按 2026-10-27 裁定关闭（不设现金闸，烧到余额为止） |

目标模型不在实况目录里时**整条边阻断**（不半切），并在状态端点可见；下一次
轮询在目录可用后自动重试。

## API

所有路由仅限 loopback（RFC 5735 127/8、`::1`、IPv4-mapped，加同源标记）；
远程 socket 一律 `403`。

### `GET /api/auto-route/status`

`200 { ok: true, service: "dsh-auto-route", policy: { … } }`，其中：

- `phase`（`baseline` | `triggered`）与 `effectiveSource`（在途腿 provider
  ——徽标渲染字段），另有 `defaultsSource`（新会话继承的默认源；95–99 死区
  内可与 `effectiveSource` 分叉）、`lastDecision`、`lastDecisionAt`
- `lines`（触发/默认/切回/驻留/节拍/窗口的生效参数）、`targets`
- `windows`（最近读数：美元 `used`/`limit`、未取整 `ratio`、`resetsAt`）、
  `readingAt`、`lastPoll`
- `lastDefaultSwitch` / `lastTrigger` / `lastRestore`（边读数 +
  `switched`/`skipped`/`failed`/`defaultSaved`）、`lastOutcome`（逐会话结果）、
  `targetProblem`（阻断诊断）
- `activeSet`（跟踪中的会话：运行标记与请求新鲜度；子代理会话会标注且永不切）
- `manualLocks`（被人工碰过的会话：发散的 `provider/model` 值 + 加锁时刻——
  两条沿都跳过它们直到值重新对齐；A 案 2026-10-27）
- `balanceGuardrail`（`enabled` + 指名使其关闭的裁定说明）

非 loopback `403`、方法错 `405`、状态生产者异常 `500`。

## 行为

- **活跃集** = 运行中或 `activeWindowMs` 内有请求的会话（来源：`session/event`
  请求头 + `agent/status`）；冷会话不批量 resume。
- **边只触发一次**：每趟执行发生在各自 latch 的边上，不在每次轮询重复；
  `selectModel` 失败会归类（子代理归属 → `skipped`，其余 → `failed`）并计入
  边记录。
- **两条腿、一条下沿**：默认边（`default-switch`）只保存部署默认模型
  （`agent-default-model`）、绝不碰在跑会话；在途边批量切活跃集（并重复一次
  默认保存）；共用下沿把两腿一起送回——但其会话趟**仅在在途腿曾动作过时**
  执行，默认腿单独回落绝不踩动策略从未挪过的会话。
- **人工锁定（A 案，2026-10-27 人工锁定优先）**：每条耐久 `model/selection`
  事件都做自动/人工判别（写入期望 + 台账 + 活目标对账——共享 `selectModel`
  通道无来源元数据）；人工碰过即锁，**两条沿**都记 `skipped` / `manual-lock`
  跳过，直到值与台账或活目标重新对齐。锁与台账为内存态（重启即清）；同值
  触碰与仅 effort 变更不可见（已披露盲区）。
- **坏数据不决策**：计量轮询失败只记 `lastPoll.ok: false`、状态分毫不动；
  下一次好读数照常决策。
- 策略状态在内存中：宿主重启后回到 `baseline`，首次轮询即从实况读数重推相位。

## 目录

- `src/index.ts` — 插件入口：注入 `webServer`、`sessionController`；接事件、
  控制器与状态路由。
- `src/policy.ts` — 纯相位逻辑（扳机/切回边、滞回、驻留、不完整读数保守不切）。
- `src/controller.ts` — 轮询环、目录预检、切换批、默认保存、状态视图。
- `src/meters.ts` — go/status 抓取（未取整比值；秘密永不入日志）。
- `src/active-set.ts` — 运行/新鲜/子代理活动台账。
- `src/manual-lock.ts` — 人工锁定台账（A 案）：写入期望、所有权值、两沿共守
  的锁。
- `src/host/routes.ts` — loopback 围栏状态路由。
- `src/host/loopback.ts`、`src/host/http.ts`、`src/mount-once.ts` — 仓内共享
  host 模块的生成副本（改 `shared/host/*` 后跑 `node scripts/sync-shared.mjs`）。

## 许可

Apache-2.0
