# Agent Note: CI 把必需检查拆成并行通道，且 CI 改动遵循同一份清单

Status: implemented

## Problem

每一条必需检查过去都是一个串行 job。`CI checks` 把三条文本规则、类型程序、构建、整个 workspace 套件和八道一致性门禁当作单个 2m44s job 的步骤依次跑完，可这些步骤除了同一份 checkout 之外毫无共享：文本规则读的是手写源码、根本不需要依赖，一致性门禁比对的是已提交产物，套件读的是已提交的 `lib/` bundle。第二条必需检查 `plugin-mount`（2m24s）每次运行都重新下载钉版 DSH CLI——占它 32s——而任何一个 job 都可能卡在一次停滞的 `git fetch` 上直到 30 分钟超时，因为没有任何东西为 clone 设界。

仓库同样没有为那些标准 CI 问题留下过答案：更快的运行器、原生类型检查器、linter、浅层或过滤安装、依赖缓存、测试分片、跨测试文件共享模块状态。每个任务都要重新争论一遍，而一次用 runner 分钟换延迟的改动没有既定标尺可判——这在本仓尤其重要：仓库是公开的，标准 runner 分钟免费，贡献者真正感知的指标是墙钟时间。

## Decision

`ci.yml` 把必需检查拆成三条独立通道加一个汇聚 job：

| job | 名称 | 内容 |
| --- | --- | --- |
| `static-checks` | Static checks | 弹性检出、actionlint、环境安装、三条文本规则在 `pnpm install` **之前**、安装、lint、typecheck、build |
| `unit-tests` | Unit tests（`shard: [1,2,3,4]`） | 弹性检出、环境安装、依赖安装、`node scripts/test-shard.mjs <shard> 4`——不构建 |
| `consistency` | Consistency gates | 弹性检出、环境安装、依赖安装，随后 sync-shared、libs、aggregate、docs、runtime-deps 与脚本测试——从不构建 |
| `ci` | **CI checks**（名称不变） | `if: always()`，`needs` 上述三条通道，除非每个 `needs.<job>.result` 都恰好是 `success` 否则失败 |
| `plugin-mount` | （不变） | 行为不变，另加弹性检出与缓存化的钉版 DSH CLI |
| `contribution-evidence` | Validate PR contribution evidence | 不变 |

`nightly.yml` 保留它的两个 Tier-2 job，只加弹性检出；`release.yml` 保留受开关控制的发布通道，只给 `verify-release` 加弹性检出与同一套 CLI 缓存。

必需检查的名字由仓库 ruleset `integration-branch-policy` 冻结——`CI checks`、`plugin-mount`、`Validate PR contribution evidence`、`guard-agent-notes`——因此沿用旧名的是汇聚 job，而不是让三条通道变成新的必需上下文；并且聚合判断是显式写出的，不依赖 `needs` 默认语义：被跳过或被取消的通道永远不能算作满足了必需检查。

`windows.yml` 落在这一切之外，也落在必需检查之外：它唯一的 job `Windows smoke` 跑在 `windows-latest` 上，由推送到 `dev` 或 `main` 以及 `workflow_dispatch` 触发，用 `--frozen-lockfile --ignore-scripts` 安装整个 workspace 后执行 `@linxin666/dsh-remote-bridge` 与 `@linxin666/dsh-client-ui-browser-view` 两个套件，不做任何构建；原因是 v0.4.9 里唯一带平台色彩的改动——`packages/dsh-remote-bridge/src/core/devices.ts` 里的串行 `#writeQueue`，名单写入要经过它，因为 Windows 拒绝重叠 rename——从未在 Windows 上执行过，而其余每条通道都跑在 `ubuntu-latest`。它不改任何 job 名、也不出现在任何 `needs` 里，因此四个被冻结的必需上下文含义不变、必需墙钟不动；它不推进下面清单里的任何条目——那些条目衡量的都是必需检查的延迟或 runner 成本——逐条回答写在 workflow 自己的头部。

### 每一处摆放的理由

- **文本规则跑在 `pnpm install` 之后，不是之前。** 在没有 `node_modules` 的树里执行任何 `pnpm` 脚本，pnpm 会先自作主张跑一遍完整的 workspace 安装。runner 上实测：`Scope: all 19 workspace projects` … `Packages: +429` … `added 429, done`，脚本本身开始前已经过去 21.7s（该步骤 24s，慢 runner 上 34s；而改动前该步骤跑在安装之后只要 1s）；在仓库外的临时副本里同一个门禁在缺 `node_modules` 时 33.99s、存在时 5.01s，而裸脚本两种情况都约 1s。这次隐式安装用的还是 pnpm 自己的参数，而不是通道的 `--frozen-lockfile --ignore-scripts`，所以「安装前先失败」既更慢也更不受控。三条规则保留在真正值得快速失败的位置：Typecheck 与 Build 之前。
- **构建归属 `static-checks`，分片通道不构建。** 唯一读构建产物的套件（`packages/dsh-web-all`）读的是全新 clone 本来就带的已提交 `lib/` 产物，而 `libs:check` 独立地把这些产物与已提交源码绑定。实测：在一棵 `lib/` 被证明与 `HEAD` 逐字节相同的树里，十八个套件在没有构建的情况下全部通过。
- **`consistency` 从不构建。** `libs:check` 用指纹比对已提交产物与已提交源码；同一工作树里先跑构建会先把产物替换掉，恰好掩盖该检查存在的意义——那个陈旧的提交。各自独立的 job 各自拿到干净 checkout，于是这条保证不再依赖单个 job 内的步骤顺序。
- **分片是推导出来的，不是写死的。** `scripts/test-shard.mjs` 从 `pnpm-workspace.yaml` 枚举带测试的 workspace 包，按一份写入仓库的权重表做最长处理时间优先的划分。其并集恰好等于 `pnpm -r test` 覆盖的集合，互不重叠且确定，由 `pnpm test:scripts` 里的 `scripts/test-shard.test.mjs` 断言——其中一项还拿 pnpm 自己的 workspace 视图做交叉核对。权重过期只会影响均衡，永远不会影响覆盖。
- **每个分片同时跑两个套件。** 每个套件运行器本身已经摊开到多个核上，因此在四 vCPU runner 上限制并发中的套件数是在约束超订；这也与覆盖率门禁早已采用的「有界并发、上限二」约定一致。
- **弹性检出。** 第一次尝试限时三分钟并允许失败，失败时删掉半个 `.git`，再以五分钟上限重试一次。这段步骤在每个检出的 job 里原样内联，因为 `timeout-minutes` 不是 composite action 步骤的合法键（官方 metadata 语法；[actions/runner#1979](https://github.com/actions/runner/issues/1979)），无法抽成一个共享 action。
- **mount 通道在 job 内安装钉版 CLI，并加守卫。** 三种更省的做法都在本次改动的 PR 上实测后否决。带 `actions/cache` 的前缀安装冷启动 41-44s，而朴素全局安装是 32s，且 PR 作用域的缓存不会在首次运行恢复（一次 `workflow_dispatch` 运行记录了 `Cache not found for input keys: dsh-cli-Linux-0.2.0-rc.2`）。把 CLI 作为 workspace devDependency 在本树里根本跑不起来：`dsh-app-boot` 顶层 import `@deepseek-ai/cordis-plugin-group`，却只把它声明为 peer，而本 workspace 设了 `autoInstallPeers: false`，于是 CLI 以 `ERR_MODULE_NOT_FOUND` 退出；满足该 peer（无论是根 devDependency 还是仓库既有的 `packageExtensions` 写法）都会确定性地打红 `packages/dsh-web-all` 的 `tests/shell-config-surface.spec.ts`，那是另一项改动的问题。剩下的是每个 workflow 一个 `DSH_CLI_VERSION` 钉版加一道守卫：`dsh` 必须能解析，且 `dsh --version` 必须恰好输出该钉版——`dsh` 缺失时冒烟会退回未钉版的 `npx`，而版本号（而非路径）才是不会在错误 CLI 上通过的判据。
- **CLI 解析守卫。** `dsh` 不在 `PATH` 上时 `scripts/e2e-mount.sh` 会退回 `npx -y --package @deepseek-ai/dsh`，那等于测试一个未钉版的 CLI；现在有一道步骤在 `dsh` 未解析到缓存前缀时直接失败，因此布局变化无法再悄悄削弱冒烟。
- **原生类型检查。** 十五个包的 typecheck 程序改由 `tsgo`（原生编译器）执行，逐包验证与 `tsc` 给出相同 program 集合与相同结论。三个 `typecheck` 为 `tsc -b` 的包保留 `tsc`：build 模式会产出，tsgo 的产出并非逐字节相同（打印器引号风格），其 `tsbuildinfo` 也无法被构建里的 `tsc -b` 复用，因此切换它们让构建慢掉的比 typecheck 赚到的更多。

### CI 优化清单

每次 CI 改动都要说明它推进了哪一条，或者说明该条为何在此不适用。编号对应本仓采用的这份清单。

| # | 条目 | 结论 |
| --- | --- | --- |
| 1 | 更快的运行器 | **不适用。** 公开仓库 + 免费个人账户：标准 runner 免费，更大的 runner 需要 Team 或 Enterprise Cloud 的组织，且无论仓库可见性都按分钟计费。只有拿到组织计划才重议。 |
| 2 | 原生类型检查器 | **已落地。** 十五个包改用 `tsgo`；本机热态 `pnpm typecheck` 由 7.66s 降到 2.63s。 |
| 3 | 去掉类型信息的 lint 规则 | **已落地。** 门禁集合本来就是不需要类型程序的语法级脚本；Oxlint 作为 linter 加入，按 correctness、suspicious、perf 三类配置，这三类都不需要类型信息。 |
| 4 | Oxlint | **当前先只报告。** 静态通道运行 `pnpm lint`，且该步骤容忍非零退出。扫描覆盖 966 个手写文件，报告 37 条规则下的 892 处发现——远超一次 CI 改动所能修完并验证的规模——因此该步骤只报告数量、不阻断。脚本用 `--format=unix` 输出：oxlint 隐式的 GitHub 格式会在一次绿色运行上为每条发现打一个 `##[error]` 注解，把真正的失败淹没；`unix` 让每条发现以 `file:line:col: message` 保持可见，900 行而不是代码框格式的 12170 行。四条规则带原因关闭：`unicorn/no-array-sort`（类型程序钉的是 `lib: ["ES2022", …]`，`Array#toSorted` 属 ES2023，且仓库里没有调用点）、`eslint/no-underscore-dangle`（命中的全是 `__` 前缀的全局量或构建占位符，而该规则针对的是成员访问）、`unicorn/require-module-specifiers` 与 `import/no-empty-named-blocks`（都命中仓库既有的环境增强写法 `import type {} from '<pkg>'`）。后续计划：按规则分诊，先修缺陷形态的大头（`no-await-in-loop` 189、`consistent-function-scoping` 167、`no-unused-vars` 112、`promise/always-return` 75、`no-shadow` 75），然后把该步骤转为阻断；或者采用 `scripts/test-standards.mjs` 已在用的基线棘轮，让逐文件发现数只减不增。 |
| 5 | 更轻量的检出 | **本来就满足。** `actions/checkout` 默认 `fetch-depth: 1`，十六个 workflow 里有十一个根本不检出，只有 `release.yml` 要完整历史（它生成 release notes 时回溯到上一个 tag）。 |
| 6 | 弹性检出 | **已落地。** `ci.yml`、`nightly.yml`、`release.yml` 的每一次检出都有限时首试加一次重试。 |
| 7 | 把缓存写入移出关键路径 | **本来就满足。** `setup-node` 的 pnpm store 保存与 `actions/cache` 的保存都发生在 job 收尾阶段，没有通道在等缓存写入。 |
| 8 | 在 CI 镜像里预安装 | **按字面不适用**——本仓不构建 CI 镜像。它的对应物实测后否决：把钉版 CLI 安装挂在 `actions/cache` 后面，冷启动反而更慢（41-44s 对朴素安装的 32s），而且 PR 首次运行不会恢复该缓存。 |
| 9 | 过滤安装 | **不适用。** 每条通道都需要完整 workspace 依赖图（`pnpm -r typecheck`、`-r test`、构建），而热缓存下安装只要 3s；过滤只会引入第二种解析方式，却不能让任何门禁少需要依赖。 |
| 10 | 移除昂贵的缓存 | **评估后保留。** 这一条的规则是「保留缓存前先测量」；本仓实测热 pnpm store 把安装变成 3s，因此缓存是收益而不是该条目所针对的负担。同一条规则随后又否决了缓存化的 CLI 安装（冷启动 41-44s，对朴素安装的 32s）。 |
| 11 | 用模式快照替代迁移重放 | **不适用。** 没有任何通道启动数据库或重放迁移。 |
| 12 | 批量小检查 | **已落地，方向相反。** 八道一致性步骤早已批量在同一个 job 里；由于本仓标准分钟免费，取舍方向是反的——用一个冻结的必需上下文，让真正独立的重活跑成并行通道。四分片通道加汇聚 job 让一次运行共九个 job 记录，这也是我们不再拆第五条通道（用于构建）的预算考量。 |
| 13 | 均衡分片 | **已落地。** 按实测权重表分四个分片（各分片权重 29/30/29/30s，总计 118s），最重的套件不再互相排队。 |
| 14 | 跨测试文件共享模块状态 | **不落地。** vitest 的逐文件隔离是这些套件的正确性边界，而 workspace 套件本就处在 Tier-1 预算之内；本仓等价的收益来自分片墙钟。套件超出预算时再议。 |
| 15 | 越过设置成本边界继续分片 | **已落地。** 每条通道的设置约 12s，一个分片只多付一次检出、一次环境安装与一次依赖安装，而必需检查的墙钟现在由静态通道而非套件决定。 |

## Measured effect

`origin/dev` 基线（run 38499514986）：`CI checks` 164s、`plugin-mount` 144s、整轮墙钟 168s。本次改动 PR 上的两次真实运行（38506503973、38506816812）：

| 实测对象 | 基线 | 第 1 次运行 | 第 2 次运行 | 第 3 次运行（两项修正后） |
| --- | --- | --- | --- | --- |
| 原串行门禁 job | `CI checks` 164s | `Static checks` 135s（慢 runner 上 checkout 47s 与文本门禁步骤 34s） | `Static checks` 92s | `Static checks` 71s |
| `plugin-mount` | 144s | 157s（CLI 冷安装 44s） | 165s（CLI 冷安装 41s） | 143s（CLI 安装 36s） |
| 必需上下文本体 | 164s | 汇聚 job 4s | 汇聚 job 2s | `CI checks` 73s（通道 71s + 汇聚 2s） |
| 其余通道 | （原单 job 的步骤） | 分片 39-53s、一致性 33s | 分片 46-80s、一致性 38s | 分片 47-57s、一致性 33s |
| 整轮墙钟 | 168s | 161s | 170s | 147s |

这次重构把必需检查的工作量从单个 164s 串行 job 挪了出来，而前两次运行没有墙钟收益，因为整轮由 `plugin-mount` 决定，而让该通道比基线更慢的恰好是本次改动随后收回的两个想法：文本门禁跑在安装之前（24-34s）与缓存化 CLI 安装冷启动（41-44s）。第 3 次运行带上两项修正——安装现在先于文本门禁，mount 通道恢复为朴素钉版安装加版本守卫——实测 `CI checks` 73s 对 164s、整轮 147s 对 168s：必需检查缩短 55%，整轮缩短 12%，瓶颈转移到 `plugin-mount`（143s，其中 CLI 安装 36s、mount 冒烟 36s）。下一步收益需要先修 `dsh-app-boot` 的 peer 冲突，好让那次 CLI 安装并入 workspace 安装——这正是本次工作交接出去的后续项。结构收益本身依然成立：此后新增任何门禁都不会线性拉长必需检查。

第 4 次运行只带一个文档提交，实测墙钟 173s、`Static checks` 86s、`plugin-mount` 169s，多出来的时间落在 36s 的 checkout 与 31s 的 build 上，而不是本次改动引入的任何步骤。因此墙钟收益应读作「四次运行中最好的一次 147s 对基线 168s」，落在共享 runner 约 ±25s 的波动之内；稳健的结论是必需检查 job 本身（71-86s 对 164s）与 emoji 步骤（安装前置后 1s，前置之前 24-34s）。

## Alternatives considered

- **保留单 job、只调步骤**（把文本规则前置、提高测试并发）：否决，因为步骤彼此独立，串行本身就是最大成本；那样类型程序、构建与套件依旧互相排队。
- **给三条通道各自命名并把三者都设为必需上下文**，同时改 ruleset：否决，那会把一次仓库设置写入变成此后每次 CI 改动的一部分，并让需要同步的上下文成倍增加；汇聚 job 让公开契约稳定在一个名字上。
- **用 matrix 表达三条通道而不是独立 job**：否决，因为每条通道需要自己的超时与自己命名的失败步骤，而 matrix 的一个 leg 表达不了这些差异。
- **把弹性检出做成 composite action**：依据证据否决——`timeout-minutes` 不在 composite 步骤的合法键里，而让重试有意义的正是这个超时。
- **分片超过四个，或单独为构建开一条通道**：否决，因为必需检查的墙钟现在由静态通道界定，多开 job 只会增加并发压力（免费账户的 job 预算）而不会缩短检查。
- **三个 `tsc -b` 包也切到 `tsgo`**：依据实测否决——typecheck 的收益（914/1191/645ms 降到 212/315/181ms）小于构建在缓存无法复用后的损失（121/120/118ms 涨到 973/1215/657ms），而且产出字节会改变。
- **移除 pnpm store 缓存**：依据实测否决；热态安装是 3s。
- **用 `isolate: false` 跨测试文件共享模块状态**：否决——套件规模太小，墙钟收益不足以抵偿当前由隔离排除掉的跨测试污染风险。

## Consequences

必需检查的墙钟现在是 `max(静态通道, 最慢分片, 一致性通道) + 汇聚`，而不是各门禁耗时之和，因此新增一道门禁不再线性拉长检查。代价是 runner 分钟：一次运行九个 job 记录而不是三个。这在公开仓库的标准 runner 上免费，但在私有 fork 上是真实开销——该取舍只在当前前提下成立，一旦仓库转为私有就需要重议第 12 条。

Windows 通道花掉的是每次符合条件的推送一条 job 记录——在公开仓库的标准 runner 上免费，且不在必需路径上——换来的是合并之后才拿到的覆盖：只在 Windows 上出现的回归会在 `dev` 或 `main` 上暴露，而不是在携带它的那条 pull request 上，因为它不是必需上下文。

汇聚 job 自身不报告任何门禁细节，因此读者必须点开各通道才能知道哪道门禁失败；各通道正因如此保留了自己命名的步骤。某个套件实质变化后需要重新测量 `scripts/test-shard.mjs` 的权重，但权重过期只会让分片失衡，绝不会让某个包从运行中被丢掉。

新的 lint 门禁已经产出真实发现：`shared/tsdown.client.ts` 在非数组类型上写了 `readonly` 修饰符（TS1354），位于第 131 与 168 行；而 `shared/tsconfig.json` 只 include 了 `client`、`host`、`core`、`types`，因此类型程序从未检查该文件。该错误当下是惰性的（编译器忽略该修饰符、打包器剥掉类型），因此不在本次改动里顺手修——修它会把一个构建预设的编辑和一整轮 `libs:write` 产物刷新拖进一次 CI 改动；它属于另一项把类型程序覆盖到 shared 根目录的改动。

## Testing

改动落地前的本地验证：`pnpm typecheck`、`pnpm test:standards`、`pnpm i18n:check`、`pnpm emoji:check`、`pnpm docs:check`、`pnpm sync-shared:check`、`pnpm libs:check`、`pnpm aggregate:check`、`pnpm runtime-deps:check` 与 `pnpm test:scripts` 全部通过；`scripts/test-shard.test.mjs` 15/15 通过，其中包含对 pnpm 自身 workspace 视图的覆盖完整性交叉核对，四次 dry run 把全部十八个包各分配一次，权重 29/30/29/30s。「无构建」实验（一棵 `lib/` 被证明与 `HEAD` 逐字节相同的临时树）在完全不构建的情况下跑绿了四个分片。重构后 `/opt/homebrew/bin/actionlint` 对全部十五个 workflow 报告零问题。四个分片在空闲机器上端到端跑完，墙钟分别为 15.1s、12.4s、12.3s、14.6s，十八个包全绿；`pnpm lint` 按设计报告 892 处发现并以非零码退出，静态通道的步骤容忍这一点。

无界的 `pnpm -r test` 路径对负载敏感：在满负荷并行下，它先后在 `dsh-task-board` 与 `dsh-liangshen` 上撞到 5 秒测试超时。两个包在单独运行与有界分片运行里都通过，且这些失败复现的正是覆盖率门禁的「有界并发」与本通道分片并发所要约束的行为；本次工作没有改动任何源码或测试文件。
