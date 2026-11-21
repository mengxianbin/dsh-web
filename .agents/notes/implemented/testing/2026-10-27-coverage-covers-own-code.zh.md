# Agent Note: 覆盖率棘轮度量的是每个包自己的代码，而不是镜像进它的共享副本

Status: implemented

与[业务测试纪律闸门](2026-09-16-business-test-discipline-gates.md)配对：覆盖率棘轮归那篇管，本篇划定它的度量范围。

## Problem

Nightly 的覆盖率棘轮通道连红三晚：run 40079811095（2026-10-24）、run 40179561594（2026-10-25）、run 40305250665（2026-10-26），报的是 `[coverage] not in the baseline (1)/(2); record with --write-baseline: dsh-message-edit, dsh-browser-view`。

`scripts/coverage-baseline.json` 是 2026-10-22（提交 20c30c9c7）按当时存在的 20 个包记录的。之后落地的两个包从未被记录，而 `scripts/coverage-gate.mjs` 把被测到却没出现在基线里的包判为失败。

重新记录暴露了真正的形状：对着 2026-10-22 的基线，同一次测量有 28 个指标低于记录值，横跨 8 个包，最差的是 dsh-usage functions -10.98、dsh-usage lines -7.63、dsh-market lines -6.85、dsh-web-settings lines -6.70、dsh-liangshen functions -4.83 与 dsh-agents lines -3.99。

掉下来的主体不是手写的包代码。`scripts/sync-shared.mjs` 把 `shared/client/settings` 与 `shared/host` 逐字节相同地镜像进消费方，并带上生成文件头（`PluginSettingsCard.tsx`、`RangeBubble.tsx`、`SegmentGroup.tsx`、`settings-form.ts`、`settings-card.module.css`、`mount-once.ts`、`http.ts`、`loopback.ts`、`dsh-home.ts`、`pair-access.ts`、`body-mutations.ts`、`telemetry.ts` 以及它 `MANIFEST` 里其余文件），于是同一份源码被每个消费方各测量一次：一份副本落地，就在任何测试都没动的情况下同时移动了 8 个包里的 28 个指标。

## Decision

由 `MANIFEST` 生成的副本不属于该包自己的代码。`scripts/coverage-gate.mjs` 导出 `sharedCopyExcludes(packageName, entries = copyEntries())`，并为每一份副本向该包的 vitest 运行传入一个 `--coverage.exclude`；这份列表来自 `scripts/sync-shared.mjs` 的 `copyEntries()`，因此闸门里不重复任何文件名、任何包清单，加进 manifest 的副本会自动从它的消费方排除，无需改动闸门。

规则是统一的：`packages/<pkg>/` 内每一个 manifest 目标都对该包排除，不管它的副本覆盖得好不好，没有逐文件或逐包的例外。

共享源把行为证据留在 `shared/tests`，它走共享包自己的 vitest，包含在 `pnpm test` 里。

## Mechanism

重复的 `--coverage.exclude` 标志在 vitest 4.1 里是累加的：排除这两条路径后，被插桩的文件从 25 个降到 23 个，而单条大括号 glob 形式给出完全相同的结果。

路径是包相对路径，因为闸门以该包为工作目录运行 vitest，而 vitest 以包含语义把排除项匹配到插桩路径上。`--coverage.excludeAfterRemap=true` 不变。

## Numbers

仓库总量在排除后是 lines 83.05%，排除前是 79.25%。基线记录的是 CI runner 实测值而不是本机值：改动后的第一次 Nightly（run 40449496263，2026-10-27）有九个指标低于本机记录的基线、六个高于它，其中 dsh-web-all 在 CI 上低了 3.6 点，因为该包的百分比取决于车道在插桩前重新构建的 bundle。`docs/development.md` 本就要求按 CI 侧记录，因此基线取自那次运行。

三个包里有七个指标仍低于它们在 2026-10-22 的值，作为新的下限记录：dsh-remote-bridge lines 91.43 -> 90.6、statements 86.39 -> 85.22、functions 88.59 -> 87.21 与 branches 82.31 -> 80.87；dsh-session-id lines 83.87 -> 82.75 与 branches 78 -> 75；dsh-web-all lines 87.78 -> 86.37。前两个包的副本本来覆盖得很好，所以把这些文件从分母里去掉会降低它们的百分比，而测试一行都没改；dsh-web-all 的下限跟着它自己车道重建的 bundle 走。

两个此前从未被记录的包现在进了基线：dsh-browser-view（lines 79.92）与 dsh-message-edit（lines 95.34）。

有一个指标故意按两次观测里较低的那个记录：dsh-session-archive functions = 59.25，而不是新测到的 60.55。该指标在多次运行之间摆动约 0.8 点（2026-10-22 记录 59.25，CI 在 2026-10-26 测到 59.75，本次改动本地测到 60.0 与 60.55），比闸门 0.5 点的 epsilon 更宽，而 `docs/development.md` 要求基线在 CI 一侧站得住，两侧不一致时记录较低值。

## Testing

`shared/tests` 原本就带着 `settings-form.spec.ts` 与 `mount-once.spec.ts`，现在还带上 `plugin-settings-card.spec.tsx` 与 `range-bubble.spec.tsx`，共 21 个测试。

这次改动要求的验证：`pnpm test:scripts`、`pnpm test:standards`、`pnpm typecheck`、`node scripts/coverage-gate.mjs` 打印 `[coverage] OK: no package regressed`，以及改动推送后的 Nightly 通道。

## Alternatives considered

- **按整批 22 个包重录。** 否决：那会把 8 个包里 28 个指标一起压低，而它们的下滑度量的是副本，不是自己的代码。
- **给每个消费方副本各写一套测试。** 否决：一份源码八套相同测试，还都会各自漂移。
- **只排除覆盖不好的那些副本。** 否决：这是逐文件的主观判断，覆盖率一动含义就变。
- **只录两个缺失的包，留着回归继续红。** 否决：只要同样的副本还没处理，通道就一直红。

## Consequences

- 副本自身的回归不再能通过它消费方的百分比被发现；它由 `shared/tests` 的行为测试发现，也由 `pnpm test:scripts` 里跑 `sync-shared --check` 做同一性校验来发现。
- `shared/tests` 本身不是一个棘轮桶，所以共享源有行为测试但没有覆盖率下限，这是一个点名的缺口，不是疏漏。
- 上面那六个指标是对这两个包下限的真实、刻意的下调，记在这里，而不是被默默吸收。
