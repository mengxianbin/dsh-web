# Agent Note: Sysmon 网络格撤失败数展示 + tooltip 悬停冻结 + 探测失败快速重试

Status: implemented

## Problem

用户盯着 chip 当天（2026-10-28）连报三件事：

1. **失败数不代表当下**：第 4 格的 `⚠n` 来自 10 分钟滑动窗口，数字爬升与回落
   都以十分钟计——判据原话「不要显示失败会话数量了，数量更新的窗口太长了，
   体现不了当下实时状态」。
2. **tooltip 一闪一闪**：悬停时原生 `title` tooltip 每秒闪一次，看不清。根因
   = 载荷每秒轮询换一次 `title` 字符串（含秒级刷新时钟与四个读数），**原生
   tooltip 在指针下方被重写即被浏览器打断**——dwell 计时反复清零，肉眼就是
   「一闪一闪」。
3. **延迟消失只剩失败数**：实测瞬间截图 `网络 ⚠36`（无毫秒）。诊断：线上
   `/api/sysmon/samples` 恢复后 `rttMs=41` 新鲜——截图时刻恰逢探测连败超过
   `RTT_STALE_MS`（150s = 60s×2 + 宽限），RTT 按「绝不展示陈旧值」规则落成
   `—`，而失败徽标仍站着，成了唯一显示。失败日志也佐证当时链路真差
   （`failures` 8 → 36 → 43 快速爬升）。60s 一探的节奏下，三次连败就让
   格子空两分钟以上——最需要读数的时候失语。

## Decision

同日 ask 回执（选项「彻底撤」，用户选定）一次定三案：

- **撤展示（彻底撤）**：`⚠n` 徽标、网络格红色、`data-warn` 的 `net` 键、
  tooltip 失败数与路由行**全部退出展示**——网络格只渲染
  `formatNetValue`（`19ms` / `—`），`netLine` 只渲染往返或空窗提示。
  locales（zh/en）`chip.netDetail` 去掉 `{failures}` 占位、删除
  `chip.netProvider`，dsh-i18n ru 镜像同步。**载荷与计数管道原样保留**：
  `failures`/`provider`/`warn` 照常上线路，`netWarnFailures` 只定载荷
  `net.warn` 标志（README 配置行已改口径）。skin-center 语义契约表 `chip`
  行摘除 `net` 键并注明裁定日期。撤除理由：红与数字同源同窗口，留一半同样
  不代表「当下」。
- **tooltip 悬停冻结**（修闪烁）：`SysmonBody` 把 title 放进 state——
  **悬停期间不写**（`hoveredRef` 挡住每秒的 `setTitle`），离开悬停时用最新
  载荷恢复实时值。原生 title 与 ~1s dwell 保留。**钩子必须放在 404
  early-return 之前**（首版放在后面当场触发 React「Rendered fewer hooks
  than expected」，`hostOff` 分支会改变钩子条数）。
- **探测失败快速重试**（修延迟消失）：`ping-probe.ts` 新增
  `PROBE_RETRY_MS = 15_000`——失败轮 15s 后重探，成功才回 60s 节奏
  （`schedule(ms === null ? retryMs : intervalMs)`）。瞬时丢包不再把读数
  拖成分钟级 `—`；持续故障仍会老实显 `—`（那是诚实行为，不是 bug）。稳态
  流量仍每分钟 1 包：快速重试只在探测失败期间发生。

## Alternatives considered

- **只撤徽标保红色 / 换 60s 短窗口**：用户在 ask 里明确选「彻底撤」——红与
  数字同源（10 分钟失败窗口），留哪个都与判据冲突。
- **自绘 CSS tooltip（悬停 div）**：能修闪烁且即时显示，但引入裁剪、触屏
  回退、明暗样式三类新风险；原生 title 冻结一行 state 即修，取最小改动。
- **拉长 `RTT_STALE_MS` 保住数字**：违反「绝不展示陈旧值」的既有铁律；改从
  探测节奏下手才是治本（陈旧界限继续守 150s）。

## Consequences

- 网络格从四态（`19ms` / `⚠n` / `19ms ⚠n` / `—`）收敛为**两态**
  （`19ms` / `—`）；`data-warn` 与染红只剩 `cpu`/`mem`/`disk` 三键。
- 载荷仍带 `failures`/`warn`（wire 不变，旧消费者零破坏）；将来若要短窗口
  失败指示器，数据管道现成。
- tooltip 悬停期间内容是 hover 起点的快照（≤1s 旧），离开后恢复实时——稳定
  可读优先于毫秒级新鲜。
- 测试 **82 全绿**（81 → 82：net −1（徽标例组）+ chip +1（悬停冻结例）
  + ping-probe +1（快速重试例））：net 11、net-observe 3、ping-probe 13、
  chip 19、seats 7、routes 4、sampler 9、sample 16。冻结例断言：hover 中
  第二次轮询到达时 `title` 不变，`mouseLeave` 后恢复实时值。
- 门禁：包级 typecheck / test（82）/ build；仓 `i18n:check`（16 ns、
  zh = ru 配平，`chip.netProvider` 三语同删）、`docs:check`（README 双语经
  `verify-docs --write` 重录）。
- **激活**：显示层与冻结 = 客户端半区，构建后浏览器 F5 即生效；快速重试在
  宿主半区（`ping-probe.ts` 随插件 effect 装载），需宿主热挂载生效或重启
  DSH web（归人）。
