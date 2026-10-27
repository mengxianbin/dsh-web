# AGENTS.md — dsh-sysmon

会话头部系统指标 chip：宿主每秒采 CPU/内存/磁盘，浏览器半区在会话头部动作槽
（preset 标签右侧，主位）与头部 leading 单元格（无会话/空会话兜底位）渲染四读数
（CPU/内存/磁盘 + 网络质量）并按告警变红，两位经 `src/client/presence.ts`
挂载信号互斥、恒只画一份。包级规则：只写本包特有约定，不重复根 AGENTS.md 与
packages/AGENTS.md 的全局/包级规则。

## 本包要点

- **三分区**：`src/host`（采样器 + 网络观察者 + 路由）、`src/client`（chip +
  locale）、`src/core`（两侧共用的纯逻辑：CSV 解析、环形缓冲、告警推导、
  网络窗口、类型）。两侧 program 都编译 `src/core`，故 core 内禁止 import
  node 或 DOM API。
- **typeperf 采样通道（P0 探针定案，勿改）**：Windows 中文版 typeperf 带
  `-f CSV` 会把 CSV 数据改道到进程 cwd 的 `输出.csv`，stdout 只剩控制噪声。
  采样器 spawn 时**不带 `-f`**，stdout 管道即可稳定 1 行/秒（2026-10-24/25
  P0a-d 实测）。改此参数会静默丢数据并污染 cwd。
- **网络读数（A 案 · 低频主动 ICMP 探测；2026-10-28 判据，取代 2026-10-27
  「零主动探测」裁定）**：判据源 = 2026-10-28 ask `net-quality-semantics` 选 A
  （读数 = 单一国内参照点的 ICMP RTT，语义单纯为「本机网络质量好不好」；
  跨境/代理链路由失败计数兜底）。`src/host/ping-probe.ts` 每轮结算后再计 60s，
  对 `netProbeTarget`（默认 `api.deepseek.com`；`''` 整体禁用探测）spawn
  `ping -n 1 -w 3000`，中英双语输出解析（`时间=19ms` / `time=19ms` /
  `<1ms`）。成功喂 `src/core/net.ts` 的 `noteRtt(ms)`；探测失败（超时/丢包/
  spawn 错）喂 `null`——**不更新读数**，最后实测值过 150s 陈旧界限
  （`RTT_STALE_MS`）自然显 `—`，绝不展示陈旧值。**失败计数仍纯被动**
  `agent/request-error`（`{ prepend: true }` 承重：llm-retry 对可重试失败直接
  返回重试决定、不调 `next()`，排在其后的观察者会漏掉恰是最该数的那批失败）；
  10 分钟窗口、`netWarnFailures` 染红、`⚠n` 徽标与四态展示全部不变（RTT
  本身不参与染红）。连接段被动观测（`conn-tap.ts` + `agent/assistant-stream`
  归因窗）已随 A 案撤除（回滚锚 = `8ec42c58`）；`connMs`/`connAt`/`connVia`/
  `ttftMs` 保留为恒空兼容桩（旧客户端显 `—` 防 `NaNms`）；`provider` 路由标签
  自此只来自计数的失败（探针无路由属性）。
- **Events 垫片**：`net-observe.ts` 里的 `declare module '@deepseek-ai/cordis'`
  逐字镜像 harness 的 `agent/assistant-stream` 声明（pinned rc.1 SDK 早于该
  事件），**cohort 升级带上官方声明后整块删除**（同键扩展会自冲突，
  SlotMap 垫片先例）。
- **栅栏**：`GET /api/sysmon/samples` 走 pair-access（loopback 恒过 +
  配对设备 cookie），与 dsh-usage overview 同一信任边界。
- **降级契约**：宿主关（路由 404）→ chip 自隐藏；传输失败 → 保留上帧重试；
  磁盘行超过 5s 未更新 → 磁盘读数置 null（`—`），不展示陈旧值；`net` 字段
  为可选——pre-v4 宿主不带它时 chip 网络位显 `—` 而非崩溃。
- **生成副本**：`src/mount-once.ts`、`src/host/{loopback,pair-access,http}.ts`
  由 `scripts/sync-shared.mjs` 生成，禁手改；改 shared 源后重跑
  `node scripts/sync-shared.mjs`。
- **link-only**：`private: true`，不发 npm、不进 aggregate.yml（Windows 专属，
  进聚合包会拖累非 Windows 安装者）；用
  `dsh plugin --profile web add link:<repo>/packages/dsh-sysmon` 安装。

## 提交前检查

```sh
pnpm --filter @linxin666/dsh-client-ui-sysmon typecheck
pnpm --filter @linxin666/dsh-client-ui-sysmon test
pnpm --filter @linxin666/dsh-client-ui-sysmon build
pnpm i18n:check   # locale 新键须同步 packages/dsh-i18n 的 ru 镜像
```
