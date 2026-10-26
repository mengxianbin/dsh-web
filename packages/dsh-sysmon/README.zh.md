# @linxin666/dsh-client-ui-sysmon

[English](README.md) | 中文

DSH web GUI 插件 sysmon——会话头部的实时系统指标 chip。它展示宿主每秒采样的
CPU、内存与磁盘活动，并把连续多秒处于阈值上方的指标染红，让你不用离开对话
就能看到机器是否被打满。

## 能力

- 在 `conversation.session.header.actions` 槽、agent-preset 标签右侧挂一枚紧凑
  chip：三个等宽数字读数（CPU 忙碌 %、内存占用 %、磁盘忙碌 %）+ 悬停 tooltip
  展示磁盘吞吐与内存绝对值。
- 同一枚 chip 同时镜像到 `conversation.header.leading`——无会话时唯一仍渲染的
  头部单元格，空会话隐藏动作行时它也保持可见。两个座位经模块级挂载信号互斥，
  任何时刻只画一份：动作行座位在两者都会挂载时优先。
- 宿主每秒采样：CPU 来自 `os.cpus()` 差分，内存来自 `os.totalmem()` /
  `os.freemem()`，磁盘来自一个常驻 `typeperf` 子进程经 stdout 流式输出的三个
  `PhysicalDisk(_Total)` 计数器。
- 宿主内存里保留十分钟环形缓冲（600 个样本），藏在 `GET /api/sysmon/samples`
  后面，将来加历史视图无需改宿主。
- 告警按「连续样本」而非「单点尖峰」触发：某指标只有连续 `warnStreak` 个样本
  （默认 3）都在阈值上方才染红。
- 各自独立降级：宿主半区关闭时路由 404、chip 自隐藏；磁盘子进程停摆超过 5 秒
  则磁盘读数显示 `—` 而非陈旧值；轮询失败保留上一帧并在下个 tick 重试。

## 安装

本包仅支持 link 安装，不发 npm，也不进 `dsh-web-all` 聚合包（其 `typeperf`
采样是 Windows 专属）。

### 从本仓库（开发）

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm --filter @linxin666/dsh-client-ui-sysmon build
dsh plugin --profile web add link:$(pwd)/packages/dsh-sysmon
```

## 配置

插件暴露 schemastery 配置；在 profile 的 `cordis.patch.yml` 插件行覆盖任一键，
然后重启 DSH 服务。

| 键 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 采样器与路由的总开关。 |
| `cpuWarnPercent` | number | `90` | 触发 CPU 染红的忙碌百分比。 |
| `memWarnPercent` | number | `90` | 触发内存染红的占用百分比。 |
| `diskWarnPercent` | number | `90` | 触发磁盘染红的忙碌百分比。 |
| `warnStreak` | number | `3` | 告警所需的连续采样个数。 |

## 安全模型

`GET /api/sysmon/samples` 是只读路由，走共享的 pair-access 栅栏：loopback 请求
恒过，配了 remote-web-ui 的配对设备 cookie 也过；未配对的局域网或隧道请求一律
`403` 拒绝。链路上不传任何凭据、路径或进程名——只有每秒聚合计数器。

## 已知限制

- 磁盘指标依赖 Windows（`typeperf`）；其他平台上磁盘读数为 `—`，CPU 与内存
  仍可用。
- `_Total` 的 `% Disk Time` 在多队列盘上可能超过 100；显示钳到 100，历史保留
  原值。
- 环形缓冲在内存里，重启即失；尚无视图化历史。
- 兜底副本坐在头部 leading 单元格，因此跨状态时 chip 会从左边缘（无会话 / 空会话）
  移到 preset 标签旁（活动会话）。
- 逐进程归因不在范围内；需要定位真凶时跑 m-note 的
  `scripts/common/io-attribution.ps1`。

## 许可证

Apache-2.0.
