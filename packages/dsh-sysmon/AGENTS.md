# AGENTS.md — dsh-sysmon

会话系统指标读数：宿主每秒采 CPU/内存/磁盘，浏览器半区三座位渲染——composer 行
尾槽 `conversation.composer.dock.trailing`（输入卡下方行最右端、21% 上下文表之后，
主位四读数）+ 头部工具行 `conversation.session.header.utilities`（order -20 的
本地挂钟，紧贴 open-in-app 文件夹控件左侧）+ 头部 leading 单元格（无会话/空会话兜底位，自带挂钟格，
因这些状态没有工具行）。读数按告警变红，两枚 chip 经 `src/client/presence.ts`
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
  （读数 = 单一国内参照点的 ICMP RTT，语义单纯为「本机网络质量好不好」）。
  `src/host/ping-probe.ts` 每轮结算后再计 60s，对 `netProbeTarget`（默认
  `api.deepseek.com`；`''` 整体禁用探测）spawn `ping -n 1 -w 3000`，中英双语
  输出解析（`时间=19ms` / `time=19ms` / `<1ms`）。成功喂
  `src/core/net.ts` 的 `noteRtt(ms)`；探测失败（超时/丢包/ spawn 错）喂
  `null`——**不更新读数**，最后实测值过 150s 陈旧界限（`RTT_STALE_MS`）
  自然显 `—`，绝不展示陈旧值。**失败轮 15s 快速重试**（`PROBE_RETRY_MS`，
  2026-10-28 延迟可见性修复：60s 节奏下三次连败即把读数拖成分钟级 `—`；
  成功才回 60s 节奏，稳态流量仍每分钟 1 包）。
- **失败数只计不显（2026-10-28「彻底撤」展示裁定）**：判据源 = 同日 ask 回执
  （用户原话「不要显示失败会话数量了，数量更新的窗口太长了，体现不了当下
  实时状态」，选项「彻底撤」）。**`⚠n` 徽标、网络格红色、`data-warn` 的
  `net` 键、tooltip 失败数与路由行全部退出展示**——网络格只渲染
  `formatNetValue`（`19ms` / `—`），`netLine` 只渲染往返或空窗提示。
  载荷与计数管道**原样保留**（`failures`/`provider`/`warn` 照常上线路，
  `netWarnFailures` 只定载荷 `net.warn` 标志），语义契约表 `chip` 行的
  `net` 键已同步摘除。失败计数仍纯被动 `agent/request-error`
  （`{ prepend: true }` 承重：llm-retry 对可重试失败直接返回重试决定、
  不调 `next()`，排在其后的观察者会漏掉恰是最该数的那批失败）。
- **本地挂钟（2026-10-29 裁定；座位 2026-11-18 拆出 chip）**：判据源 =
  2026-10-29 ask 回执（位置选 A、格式选 `MM-DD HH:MM`），动因 = F11 全屏工作
  藏掉系统任务栏时钟。时钟从 `SysmonBody` 拆成独立组件 `SysmonClock`：
  **活动会话**注册进头部工具行（order -20，行首格、open-in-app 控件左侧），**无会话/空会话**
  由兜底 chip 的 `ClockCell` 格承载——两处不同时出现（工具行存在时兜底必被
  presence 让位）。共用 `useDayTime` 钩子：**独立 1s 定时器**（不挂 payload：
  传输失败会冻结载荷，冻结的钟比 `—` 更害人——它撒谎）；可见性暂停 +
  visibilitychange 重同步（后台标签节流不得画陈旧分钟）。时钟**不带键名标签**
  （格式自释、容器降级摘标签时该格宽度不变），分钟精度（秒只给没人读的值加
  每秒跳动）。**404 不再陪葬**：读数随宿主半区关闭自隐，钟不随——2026-10-29
  「常显」裁定高于旧「共存亡」代价。
- **dock 副本降噪（2026-11-18 设计拍板）**：`chipDock` 变体去胶囊底色、读数降
  三级灰 400 字重（与统计药丸同级；告警仍错误色 500 全强度——平时安静、出事才
  扎眼）。`.v` 带数字位宽下限（百分比 4.25ch、网络格 5.4ch），读数跨位数变化不
  带动居中排整行位移。容器降级锚在 harness 侧新增的 InputBar `.dock`
  （container-type），阈值 740px 摘键名、640px 整格让位——与药丸共挤一行时先
  摘自己再隐身，绝不挤扁药丸。
- **tooltip 悬停冻结（2026-10-28 闪烁修复）**：载荷每秒换一次，原生
  `title` 在指针下方被重写即被浏览器打断 → 一闪一闪。`SysmonBody` 把
  title 放进 state：**悬停期间不写**、离开悬停恢复实时值（钩子必须在
  404 early-return 之前，顺序不得随 `hostOff` 变化）。
- 连接段被动观测（`conn-tap.ts` + `agent/assistant-stream` 归因窗）已随 A 案
  撤除（回滚锚 = `8ec42c58`）；`connMs`/`connAt`/`connVia`/`ttftMs` 保留为
  恒空兼容桩（旧客户端显 `—` 防 `NaNms`）。
- **Events 垫片**：`net-observe.ts` 里的 `declare module '@deepseek-ai/cordis'`
  逐字镜像 harness 的 `agent/assistant-stream` 声明（pinned rc.1 SDK 早于该
  事件），**cohort 升级带上官方声明后整块删除**（同键扩展会自冲突，
  SlotMap 垫片先例）。
- **栅栏**：`GET /api/sysmon/samples` 走 pair-access（loopback 恒过 +
  配对设备 cookie），与 dsh-usage overview 同一信任边界。
- **降级契约**：宿主关（路由 404）→ 读数自隐藏、挂钟照走（兜底位与工具行同
  保证）；传输失败 → 保留上帧重试；磁盘行超过 5s 未更新 → 磁盘读数置 null
  （`—`），不展示陈旧值；`net` 字段为可选——pre-v4 宿主不带它时 chip 网络位显
  `—` 而非崩溃。
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
