# Agent Note: PR 维护运行 2026-10-15（第二十一次巡检）——合并 CI 并行通道 PR

Status: implemented

## Problem

本次是 `zhu1090093659/dsh-web` 的第二十一次维护巡检，承接[第二十次巡检](../../archived/process/2026-09-23-pr-maintenance-twentieth-pass.md)。范围只有用户点名的那一个 PR：[#1864](https://github.com/zhu1090093659/dsh-web/pull/1864)。这是主仓 PR，维护规则只在用户点名时才受理。它由 owner 自己提交的同仓分支（`ci/ci-optimization`），36 个文件、+1568/-82，基于当时的 `dev` 顶点 `fa472d15`：把必需的 `CI checks` job 拆成 `Static checks` / `Unit tests`（四个分片）/ `Consistency gates` 三条通道，再由沿用旧上下文名的汇聚 job 汇总，并加上原生类型检查（`tsgo`）、只报告不拦截的 Oxlint 通道、弹性 checkout 与钉版 CLI 断言。

PR 上四个必需上下文全绿，但没有任何 review，于是 GitHub 在 ruleset `integration-branch-policy` 要求的「至少 1 个批准」上给出 `mergeStateStatus: BLOCKED`。这个批准拿不到：作者就是仓库 owner，而 GitHub 不允许自审自批。所以本次要回答的问题不是「CI 是否绿」，而是「owner 自己提交的内部 PR 该等第二个人批，还是走 ruleset 已经给 owner 的豁免」。

## Decision

#1864 以合并提交 `2c282fb4` 并入 `dev`，走 ruleset 给 owner 的豁免：`integration-branch-policy` 把用户 `46916148`（owner）列为 `bypass_mode: always` 的 bypass actor。这与文档里 owner 流程直接把本地分支推到 `dev` 用的是同一份授权；选择合并 PR 而不是直接推分支，是为了让合并事件、diff 与检查记录留在同一处可追溯，而不是散落。

合并前的验证全部在独立 worktree 的 head `fcd4bab5` 上完成（macOS 10 核、Node v25.8.1、pnpm 11.24.0）：

- 全新检出下 `pnpm install --frozen-lockfile --ignore-scripts` 退出码 0，`node_modules/.bin` 里有 `oxlint` 1.88.0 与 `tsgo` 7.0.0-dev.20260707.2，说明两个新 devDependency 确实由冻结的 lockfile 装上，而不是悄悄缺失。
- `pnpm typecheck`、`pnpm emoji:check`、`pnpm i18n:check`、`pnpm docs:check`、`pnpm test:standards`、`pnpm test:scripts`（399 个用例、0 失败）、`pnpm aggregate:check`、`pnpm libs:check` 全部退出码 0。
- `node scripts/test-shard.mjs <i> 4`（i = 1..4）全部退出码 0，合计 3+4+5+6 = 18 个包且每个恰好一次——既完整又互不重叠，与 `listTestPackages()`、以及 `pnpm ls -r` 去掉 `pnpm -r test` 不跑的 workspace 根一致。
- `actionlint` 对全部 16 个 workflow 无告警，包含重写后的 `ci.yml`。
- GitHub 侧四个必需上下文（`CI checks`、`plugin-mount`、`Validate PR contribution evidence`、`guard-agent-notes`）在 PR 上均为 SUCCESS。

独立只读评审没有发现阻塞缺陷。它的两条 important 属于有意设计而非疏漏：16 个 `packages/*/package.json` 的 typecheck 换成原生编译器的 `-dev` 构建且没有 tsgo/tsc 诊断一致性测试；新的 Oxlint 步骤写成 `pnpm lint || true`，即使工具本身报错该步骤也不会失败。评审确实执行了汇聚 job 的脚本体，分别代入 `success` / `skipped` / `cancelled` / 空值，确认只有三个 `success` 才退出 0，因此被跳过或被取消的通道无法满足必需上下文。

## Alternatives considered

等 ruleset 里另一位 bypass actor 批准被否决：这是 owner 自己的集成工作，仓库文档给 owner 的流程本来就不进 PR 审查，把 owner 自己的合并卡在仓库自己声明可豁免的审查后面，只增加流程而不增加证据。

把四个分支提交直接快进推到 `dev`（文档里的 owner 流程）被否决：推的是同样的字节，但没有任何记录与 PR 关联，合并后的 PR 会处于无人认领状态，审查轨迹与实际落地的提交脱节。

合并本地 `dev` 分支再推（本地 `dev` 已经带着内容相同的 `91958d66`）被否决：本地 `dev` 还领先 `origin/dev` 22 个提交，里面是其他会话尚未推送的功能改动，把它们发布出去超出本次任务的授权。

squash 合并被否决：四个提交分别承载工作流重写、安装顺序修正与实测数字，合并提交保留了这一分层，同时仍然只呈现一次落地改动。

## Consequences

`dev` 现在在保持 `CI checks` 这个上下文名不变的前提下跑三条并行通道，必需检查的墙钟因此是三条通道的最大值而不是总和。真实的 runner 侧确认落在 `origin/dev` 上 `2c282fb4` 的 push 运行——这是重写后的工作流第一次在 `push` 事件（而不是 pull request）上产出必需上下文。

同一份改动在本机 `dev` 上还以未推送的提交 `91958d66` 存在。两者是同一改动：逐文件 patch 对比只差周围的 `es-module-lexer` devDependency 一行——本地树有、`origin/dev` 没有——因此本地 `dev` 下次 rebase 或合并到 `origin/dev` 时，`91958d66` 会作为「已应用」被丢弃，而不是产生冲突。

遗留待办（都不阻塞、也都不是重开这次合并的理由）：只报告的 Oxlint 步骤把工具自身失败藏在 `|| true` 后面；`docs/development.md` 把 `pnpm lint` 列进提交前必须跑的门禁链，但该命令在干净的树上也退出非零，而 `AGENTS.md` 列的同一条链里没有它；CI 通道清单笔记自相矛盾（表格行说文本规则在 `pnpm install` 之前跑，正文与 `ci.yml` 都是之后跑）；空分片退出 0，所以一旦矩阵变宽就可能出现「全绿但什么都没跑」的通道；`scripts/test-shard.mjs` 忽略多余的 positional 参数；`scripts/plugin-template/package.json` 用了 `tsgo` 却没声明依赖，只因 workspace 根的 `.bin` 才跑得起来；`ci.yml` 注释仍写 896 处 Oxlint 发现，而现测为 892。

取代性检查结论：CI 通道设计本身的 Owning Note 是 [CI 优化清单](2026-10-14-ci-parallel-lanes-and-optimization-checklist.md)，它继续拥有通道设计这件事；本条只拥有第二十一次巡检的处置决定，两者互相链接而非合并。没有旧笔记被取代。

## Testing

合并后的状态是从 GitHub 回读的，不是本地日志：`gh pr view 1864` 报 `MERGED`、`mergedBy zhu1090093659`、合并提交 `2c282fb4`；`git merge-base --is-ancestor fcd4bab5 origin/dev` 成立；`origin/dev:.github/workflows/ci.yml` 与 PR head 的 blob 哈希相同（`3fd2d0dc`）。`2c282fb4` 的 push 运行在 `dev` 上执行重写后的各通道。

本地唯一没过的门禁是单进程全量套件：`pnpm test` 连续 3 次失败于 `packages/dsh-liangshen/tests/benchmark-live-run.test.ts:255` 的 `Test timed out in 5000ms`。该用例为语料库每个任务真起一个子进程，在 `pnpm -r` 四包并发、机器 10 核的负载下越过默认超时。PR 没有改动该文件，单独跑 3/3 通过（整包 385/385、3.21s），放进分片 3 也通过，PR 自己的 CI 分片通道同样是绿的，所以这是既有的、对负载敏感的失败，与本次改动无关。

未验证：16 个包里 `tsgo` 与它替换掉的 `tsc` 之间的诊断一致性；以及平台缓存作用域的 runner 侧行为——这一项只是从工作流配置推断，没有实测。
