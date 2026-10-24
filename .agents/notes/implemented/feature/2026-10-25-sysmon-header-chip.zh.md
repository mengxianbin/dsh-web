# Agent Note: dsh-sysmon——会话头部系统指标 chip

Status: implemented

## 问题

排查机器变慢时，总要离开 DSH Web GUI 去开任务管理器和 Traffic Monitor 看
CPU、内存、磁盘读数。这些窗口各占屏幕、各占一个进程，还恰好在注意力已挂在长
会话上时要求一次上下文切换。侧栏 logo 行的用量 glance 证明了「装进 GUI」这条
路成立，但它只覆盖 provider 配额——shell 里没有任何主机资源信号，于是一台被打
满的机器在会话明显卡顿之前始终不可见。

## 决策

- **一个双半区插件 `packages/dsh-sysmon`**，仅 link 安装（`private: true`，
  不发 npm、不进 `dsh-web-all`）：其 `typeperf` 采样是 Windows 专属，不能跟着
  跨平台聚合包走。
- **宿主半区**（`src/host/sampler.ts`）：一个常驻 `typeperf -si 1` 子进程经
  stdout 流式输出 `PhysicalDisk(_Total)` 的 `% Disk Time`、
  `Disk Read Bytes/sec`、`Disk Write Bytes/sec`；1s tick 同时对 `os.cpus()`
  做差分并读 `os.totalmem()`/`os.freemem()`。`SampleRing` 保留 600 个样本
  （十分钟）。`GET /api/sysmon/samples` 在共享 pair-access 栅栏（loopback 或
  配对设备）后提供最新样本与连续告警标志，完整环仅在 `?history=1` 时返回。
- **告警按连续样本而非尖峰**：某指标只有连续 `warnStreak` 个样本（默认 3）
  都在阈值（默认 90/90/90，均可在 profile patch 覆盖）上方才染红。
- **浏览器半区**（`src/client/SysmonChip.tsx`）：注册进
  `conversation.session.header.actions` 槽，entry id `sysmon`、order 10，
  落在 agent-preset 标签右侧。标签可见时每秒轮询一次；容器查询在 ≤620px 时
  掉单位标签、≤440px 时整条隐藏，镜像 preset 标签的让位阶梯。
- **降级按信号各自独立**：路由 404 时 chip 自隐藏（宿主关闭或未装）；磁盘行
  超过 5 秒未更新则服务 `null`，chip 显示 `—` 而非陈旧值；子进程意外死亡触发
  3 秒延迟重生；轮询失败保留上一帧。
- **typeperf 必须不带 `-f` 启动**（见 `packages/dsh-sysmon/AGENTS.md`）：中文
  Windows 上 `-f CSV` 会把 CSV 数据改道到进程 cwd 的默认 `输出.csv`，stdout 只剩
  进度噪声。四个 P0 探针（2026-10-24/25）定案了传输路径：不带 `-f`、管道
  stdout、约每秒 1 行 CSV。

## 备选方案

- **底部状态条（`shell.bottom` 槽）**：无会话时也可见，但永久独占 single 槽、
  给每个布局加一条常驻 24px 行；header chip 不动行预算，且会话期间视线本就
  停在 header 上。
- **侧栏 logo 行、用量 glance 旁边**：否决——40px 行已被 glance 的三条窗口行加
  统计列正好占满；再塞三个读数会正好挤爆用户点名「空间有限」的那块地方。
- **按次 PowerShell `Get-Counter`**：否决——每次采样 spawn 一个进程，制造抖动
  与延迟，与「减少进程数量」的目标背道而驰。
- **带 `-f CSV` 的 typeperf 加临时文件**：早期草稿；P0b 证明该参数把数据改道到
  cwd `输出.csv`，而轮转临时文件又带来垃圾风险（探针期间两个游荡的 `输出.csv`
  污染了两个仓，必须清扫）。管道路径根本不需要文件。
- **koffi/PDH 原生绑定**：否决——原生 addon 比一个常驻 `typeperf` 子进程更重，
  而 1s 节奏下没有可观察的延迟收益。
- **自动逐进程归因**：按用户裁定超出范围——chip 回答「机器热不热」，
  `scripts/common/io-attribution.ps1` 仍是手动找真凶的工具。

## 后果

- 进程数净值约 −1 到 −2：一个 `typeperf` 子进程进场，任务管理器与 Traffic
  Monitor 在「扫一眼」场景下可以退役。
- chip 在新建会话空屏与无会话工作区视图不可见（header 行那里不渲染）；这与
  用户 90% 时间在会话内的工作模式一致。
- 环形缓冲随宿主进程消亡；将来做历史视图只需新增客户端界面，无需改宿主。
- `packages/dsh-sysmon/AGENTS.md` 钉死了 typeperf `-f` 陷阱；改动该 spawn 参数
  会静默打断磁盘采样。

## 测试

- `tests/sample.spec.ts` 覆盖 CSV 解析（表头、空首行、短行）、>100 钳制、
  MB/s 格式化、环形封顶、连续告警推导（含 null 指标排除）。
- `tests/sampler.spec.ts` 用注入的假时钟/假 cpus/假子进程/假 interval 驱动采样
  器：CPU 差分数学、磁盘行新鲜与陈旧、表头/空行拒绝、连续告警标志、意外退出
  重生、stop() 语义。
- `tests/routes.spec.ts` 复用 dispatch 插件的 fake req/res 模式，覆盖 200 形状、
  `?history=1` 按需、403 栅栏、精确路由路径。
- `tests/sysmon-chip.spec.tsx`（jsdom）断言三个读数、告警着色加 `data-warn`、
  首帧前占位、404 隐藏契约、保留上一帧行为，以及 tooltip/GB 助手。
- 包级门禁：`pnpm --filter @linxin666/dsh-client-ui-sysmon typecheck`、
  `test`（38 通过）与 `build` 截至 2026-10-25 全绿。
