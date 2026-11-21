# Agent Note: Incremental TypeScript programs for build and typecheck

Status: implemented

## Problem

每次 `pnpm build` 与 `pnpm typecheck` 都在重做同样的编译工作。十四个包的 typecheck 程序跑的是 `tsc --noEmit`，其中十一个包还为声明产物额外跑一次非增量的 `tsc -p tsconfig.build.json`，于是热态的 `pnpm build` 约 6.0s、热态的 `pnpm typecheck` 约 7.6s，两次运行之间什么都不缓存。只有三个包（`dsh-git-graph`、`dsh-remote-web-ui`、`dsh-update`）带 `tsc -b` 状态，也只有它们的 typecheck 会跳过工作。

## Decision

每个包保留自己的 program，只让它们变成增量：

- 声明 program（`tsconfig.build.json`）设为 `composite: true`，`tsBuildInfoFile` 指向 `lib/tsconfig.build.tsbuildinfo`，构建脚本跑 `tsc -b tsconfig.build.json && tsdown`。JavaScript bundle 仍由 `tsdown` 产出。
- typecheck program（`tsconfig.json`，覆盖 `src` 与 `tests`）保留 `noEmit`，新增 `incremental: true`：构建会产出声明的包把缓存放在 `lib/tsconfig.typecheck.tsbuildinfo`；三个构建只用 `tsdown` 的包（`dsh-market`、`dsh-web-all`、`dsh-web-settings`）放在 `node_modules/.cache/tsconfig.typecheck.tsbuildinfo`。`tsconfig.test.json` 继承 `incremental`，它自己的缓存路径本来就指向 `node_modules/.cache/`。
- `typecheck` 为 `--noEmit` 的十五个包，其 typecheck 程序改由原生编译器执行（`@typescript/native-preview` 提供的 `tsgo`，在根 `devDependencies` 里精确钉版；一条根依赖足够，因为 workspace 脚本会解析 workspace 根的 `node_modules/.bin`）。三个 `tsc -b` 包保留 `tsc`：build 模式会产出，tsgo 的产出字节与 tsc 不一致（打印器的引号风格），而构建里的 `tsc -b` 无法复用 tsgo 写的 `tsbuildinfo`，切换它们会让构建慢掉的比 typecheck 赚到的更多。原生编译器遵循同一套设置——写入配置的 `tsBuildInfoFile`、热态复用、未变化的热态运行不重写该文件——并且对每个切换的包给出与 `tsc` 相同的 program 集合与相同的结论。
- `files` 原本写裸目录 `lib` 的五个包（`dsh-i18n`、`dsh-model-capabilities`、`dsh-plugin-manager`、`dsh-session-id`、`dsh-skill-explorer`）改为四个产物 glob（`lib/**/*.js`、`lib/**/*.js.map`、`lib/**/*.d.ts`、`lib/**/*.d.ts.map`）——这正是既有的三个 `tsc -b` 包一直以来的写法——从而构建缓存永远不会被发布。（2026-10-17 更新：`dsh-model-capabilities` 已在 0.2.1-rc.2 cohort 适配中从家族移除——见 [移除 dsh-model-capabilities](../simplification/2026-10-17-model-capabilities-native-removal.md)——因此该 glob 改动现在覆盖剩下的四个包。）三个只用 `tsdown` 的包不需要改 glob，因为它们的 typecheck 缓存在 `lib/` 之外。

## Why the cache lives next to the outputs

`tsc` 会跳过版本未变的文件的重新产出，这既是缓存的意义，也是它的锋利边缘。缓存放在 `lib/` 之外时，`rm -rf lib` 之后再跑一次热态会恢复**零个**声明：编译器认为项目已是最新，于是什么都不产出，包在 `pnpm build` 报成功的情况下失去了类型声明。在 `dsh-task-board` 上实测：删掉 `lib/` 后，一次热态增量运行耗时 0.48s，没有产出任何 `.d.ts`。把缓存放进 `lib/` 就让它的生命周期与它所描述的产物绑定：`rm -rf lib` 一并删掉缓存，下一次构建重新产出全部内容（实测：两个包分别恢复了 76 个与 9 个声明）。

## Alternatives considered

- **为全部十七个包套用完整的 solution 加 host/client 分层**（`dsh-git-graph` 的形态）：否决。这套分层存在的原因是 host 与浏览器两半以不同类型合并同一批 `Context` 属性（TS2717）；其余包都不触发该冲突，多出来的 program 只会增加文件。它还会改变产出集合（参考实现的 program 会在声明旁边一起产出 JavaScript），除非每个 program 都保留 `emitDeclarationOnly`；而且参考实现的 `typecheck`（`tsc -b`）根本不检查测试——采用它等于丢掉这些包今天对测试做的类型检查。
- **不加 `tsc -b`、只用 `--incremental`**，保持原有构建脚本：否决。typecheck 的收益相近，但在声明 program 上，热态 `tsc -p --incremental` 在同一包上耗时 0.48s，而 `tsc -b` 是 0.08s，因为 `-b` 还会跳过产出阶段。
- **所有 program 的缓存都放 `node_modules/.cache`**：对声明 program 否决，理由同上。
- **为全部十七个包改 `files` glob**：在三个只用 `tsdown` 的包把 typecheck 缓存移出 `lib/` 之后否决；`dsh-market` 与 `dsh-web-all` 是 `lib/` 已提交的两个包，它们的清单保持原样。

## Consequences

热态 `pnpm build` 从约 6.0s 降到 3.0s（三次交替采样的中位数；冷路径不变——清空缓存后复现旧画像，6.9s 与 7.7s）。热态 `pnpm typecheck` 随增量 program 从约 7.6s 降到 5.1s，而 2026-10-14 的原生编译器切换又把它推进了一步：在十核机器上背靠背实测，全树（`pnpm -r typecheck`）热态 7.66s → 2.63s、冷态 13.95s → 4.64s，三个 `tsc -b` 包处在较慢的一端。逐包数字被 pnpm 自身固定的启动开销（每次脚本调用约 1.4s）压缩，因此全树比值才是有意义的数字；在四 vCPU runner 上这部分常数占比更高，这也是 CI 步骤自身的降幅小于本机比值的原因。构建在 `packages/*/lib/` 下新增 22 个被 git 忽略的缓存文件，而发布包不含缓存（用 `npm pack --dry-run --json --ignore-scripts` 对全部十七个包验证过）。分发不受影响：除缓存外，发布的 `lib/` 文件集合与之前一致，已提交的 `dsh-market` 与 `dsh-web-all` 产物逐字节相同。

约束机制就是缓存位置：新增声明产出的包必须把 `tsBuildInfoFile` 留在 `lib/` 内，否则被删除的产物可能在一次「成功」的构建之后依然缺失。

## Testing

`pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm test:scripts`（384 个用例）与 `pnpm aggregate:check` 通过。`pnpm libs:check` 因另一个任务造成的源码改动在 `dsh-web-all` 上失败，与这些文件无关：`packages/dsh-market/lib` 与 `packages/dsh-web-all/lib` 下的每个已提交产物在本次改动前后逐字节相同。对全部 665 个 `packages/*/lib` 文件的改动前后快照显示：没有文件被删除，新增 22 个缓存，两个 `dsh-git-graph` 缓存文件被重写——那是本来就存在的缓存文件的正常变动。

2026-10-14 的编译器切换重新验证了 typecheck 路径：逐包与 `tsc` 对照（同一 program 集合、同一结论，另加一个人为注入错误的工程，两个编译器给出相同诊断）、以 `--frozen-lockfile --ignore-scripts` 做净室安装证明不需要 postinstall（二进制以平台 optional dependency 形式随包分发），以及 `pnpm typecheck`、`pnpm test:scripts` 与仓库其余门禁全绿。
