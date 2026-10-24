# AGENTS.md — dsh-sysmon

会话头部系统指标 chip：宿主每秒采 CPU/内存/磁盘，浏览器半区在会话头部动作槽
渲染三读数并按连续样本告警变红。包级规则：只写本包特有约定，不重复根
AGENTS.md 与 packages/AGENTS.md 的全局/包级规则。

## 本包要点

- **三分区**：`src/host`（采样器 + 路由）、`src/client`（chip + locale）、
  `src/core`（两侧共用的纯逻辑：CSV 解析、环形缓冲、告警推导、类型）。
  两侧 program 都编译 `src/core`，故 core 内禁止 import node 或 DOM API。
- **typeperf 采样通道（P0 探针定案，勿改）**：Windows 中文版 typeperf 带
  `-f CSV` 会把 CSV 数据改道到进程 cwd 的 `输出.csv`，stdout 只剩控制噪声。
  采样器 spawn 时**不带 `-f`**，stdout 管道即可稳定 1 行/秒（2026-10-24/25
  P0a-d 实测）。改此参数会静默丢数据并污染 cwd。
- **栅栏**：`GET /api/sysmon/samples` 走 pair-access（loopback 恒过 +
  配对设备 cookie），与 dsh-usage overview 同一信任边界。
- **降级契约**：宿主关（路由 404）→ chip 自隐藏；传输失败 → 保留上帧重试；
  磁盘行超过 5s 未更新 → 磁盘读数置 null（`—`），不展示陈旧值。
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
```
