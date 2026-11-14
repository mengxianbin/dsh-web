# Agent Note: 明确挂载冒烟的产物意图

Status: proposed

## Problem

挂载冒烟需要回答两个不同问题，默认却回答第三个混合问题。CI 必须挂载当前检出的产物，发布必须挂载已发布产物。不传 `FAMILY_TGZS_DIR` 时，[改写器](../../../../scripts/e2e-mount-rewrite#L159-L170) 探测 registry 版本，并静默将缺失项替换为刚从 workspace 打包的 tarball。一次成功的混合运行，本身既不能证明完整检出产物，也不能证明完整已发布家族。

## Proposal

冒烟入口仅保留两种明确意图：从调用方提供的家族 tarball 目录验证检出产物，或不改写依赖地验证 registry 产物。现有 `FAMILY_TGZS_DIR` 用作检出产物选择器；不传时表示 registry 语义，而非逐依赖自动回退。挂载前打印所选意图。CI 保留既有打包阶段，发布保留 registry 发布门禁并严格从 registry 安装。

删除自动 registry 探测、semver range 求解、隐式 workspace 打包、auto-mode 分支及打包专属状态。保留供应 tarball 的递归改写、调用方输入只读、本仓 tarball 缺失时失败、循环/cache 处理、外部卫星 registry 依赖、tar 跨平台能力以及 scratch home/进程清理。不能称为删除整个改写器。

## Context & Efficiency Impact

移除由发布状态决定的选择策略、网络探测及第二条包创建路径。[CI](../../../../.github/workflows/ci.yml#L149-L166) 已打包明确的检出 tarball。[发布](../../../../.github/workflows/release.yml#L171) 在[挂载](../../../../.github/workflows/release.yml#L240) 前验证发布完成。替代物是一个意图分支，而不是另一套 registry 或打包编排框架。提示词/工具 schema 不变。根 `semver` 依赖仍有其他脚本消费，不能把删除该依赖算作收益。

## Evidence and ownership

- [冒烟入口说明](../../../../scripts/e2e-mount.sh#L18-L33) 描述自动回退与明确的完整检出 override。auto 专属生产路径是[改写器 47–90 行](../../../../scripts/e2e-mount-rewrite#L47-L90) 的 `checkPublished` / `resolvesFromPublished` / `packWorkspace`，随后进入 [213–255 行](../../../../scripts/e2e-mount-rewrite#L213-L255) 的 `ensurePackedTgz`。
- 供应 tarball 的路径分别位于 [141–158 行](../../../../scripts/e2e-mount-rewrite#L141-L158) 和 [259–294 行](../../../../scripts/e2e-mount-rewrite#L259-L294)，独立可达。它让外部卫星继续走 npm，并在本仓包缺少供应 tarball 时明确失败。[测试套件](../../../../scripts/e2e-mount-rewrite.test.mjs) 覆盖两条路径及递归依赖。
- [检出冒烟 owner](../../implemented/testing/2026-09-23-plugin-mount-smoke-local-tarballs.md) 明确保留 CI 检出产物和发布 registry 产物，两项承诺均保留。[tar 能力决策](../../implemented/bug-fix/2026-10-03-windows-tar-force-local-capability-probe.md) 与 [scratch home 安全决策](../../implemented/bug-fix/2026-09-23-scripts-cannot-delete-the-ambient-dsh-home.md) 继续约束实现。
- 搜索活跃 proposed/implemented/rejected 记录，未发现要求在 CI 已明确打包检出产物后继续保留混合模式的现行 owner。这是在收窄冒烟接口，不是取代 owner 的其他 benchmark、故障隔离或清理决策。既有记录保留，只有实施并审查剩余义务后才可能发生 supersession。

## Alternatives considered

保留混合默认：最强理由是在发布窗口期方便地成功运行，同时对已发布兄弟包继续走 registry。这是真实使用的能力，不是死代码；本提案明确放弃它。

所有冒烟只验证检出产物：否决，因为发布必须证明消费方能安装已发布产物，外部卫星也不属于本仓 workspace 打包集。

增加第三个 strict-registry 开关并保留 auto-mode：暂缓，因为它改善意图报告，却没有删除自动探测/打包器生命周期。把 auto-mode 移到另一个脚本也只是转移成本。

## Acceptance criteria

- CI 仍挂载当前本仓检出 tarball 并能发现构建故障；发布在 registry 缺失时绝不替换为 workspace 产物。
- 不供应家族目录时，保留 packed dependencies 并明确报告 registry 意图；已发布依赖缺失使安装失败。
- 供应目录保持只读；本地 workspace tarball 缺失会失败，外部卫星依赖保留 registry spec，嵌套/循环家族图保留当前正确行为。
- 删除 auto 专属 exports、探测/打包器测试及打包专属状态；保留递归复制/改写、平台 tar 与 scratch 安全测试。不为本地方便新增一份 CI 打包阶段副本。
- 仅在行为改变处更新冒烟契约及 owner；`pnpm test:scripts` 和基线门禁通过，再在隔离且本任务拥有的 scratch home 中对受支持宿主验证两种意图。

## Risks

依赖透明发布窗口回退的本地用户，需要明确选择检出产物或等待 registry 发布。网络/投影延迟会成为可见 registry 失败，这正是发布需要的判定。供应 tarball 的嵌套递归仍需要 reservation 与清理，以 auto-mode 清理为名删除其生命周期是不正确的。这是行为收窄提案，不是实施授权。
