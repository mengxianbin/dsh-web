# Agent Note: `pnpm build` 的重启信号构建戳

Status: implemented

## Problem

harness 宿主进程需要一个机器可读的基线，记录本仓插件产物最后一次是从哪份源码状态构建的（重启信号设计的 B 戳，harness `content/tech/ai/dsh/dsh-restart-signal-design.md` §二）。设计把 `dsh-web pnpm -r build` 列为必须记录该基线的生产构建入口之一，但 manifest 落在加载这些产物的 harness 各树内，且两仓无法共用同一套构建模块。此处不挂载的话，dsh-web 单独改动会让 harness 各树的基线悄悄过期而无人察觉。

## Decision

- 根 `build` 脚本包上 `scripts/build-stamp.mjs run -- <command>`：命令前取 S_start（仓级状态 = HEAD、`git diff HEAD`、porcelain、untracked 路径与内容；host 面用全仓内容态），命令成功后写 `.dsh-build/restart-stamp.json`（`kind: 'dsh-web'`，构建期间内容态移动则 `midBuildDirty=true`）。构建失败不动旧 manifest。
- 环境里已有 `DSH_BUILD_STAMP_ACTIVE` 时包装器纯透传：即使 harness 侧带戳链调到本脚本，一次构建也只有一对起止戳。
- `.dsh-build/` 进 gitignore；harness host 进程启动时经 profile `link:` 依赖扫描读取本 manifest，与自身树的 manifest 合并（能力门：带戳脚本的被链仓库才入罩）。
- manifest 构 schema 与嵌套标记协议镜像 harness `scripts/restart-signal/build-stamp.ts`；改任一侧须同步另一侧。

## Alternatives considered

从这里把 manifest 写进某个 harness checkout 被否决：需要机器专属的 harness 路径（或 setx 前置条件），而且一个仓的构建会改写另一个仓的基线文件。两仓共用一个模块被否决：谁也不 vendored 谁的脚本，harness 侧还需要本仓纯 Node 工具链不该承担的 TypeScript 分面路径遍历。

## Consequences

`pnpm build`（且仅成功运行）会保持 dsh-web 的 host 面组件对 harness R 戳新鲜；dsh-web 源码改了却没重建时，harness 侧读到 `INIT`/过期基线，而不是静默通过。单包直建（`pnpm --filter <pkg> run build`）绕过戳，已在入口清单中记为不入罩；生产流程走根 `pnpm -r build` 入口。

## Testing

2026-10-24 冒烟：`node scripts/build-stamp.mjs run -- node --version` 写出完整 manifest（repo/host 哈希在场、`midBuildDirty: false`），`DSH_BUILD_STAMP_ACTIVE=1` 重跑透传不重写，加 ignore 规则后 `git status` 不再列 `.dsh-build/`。
