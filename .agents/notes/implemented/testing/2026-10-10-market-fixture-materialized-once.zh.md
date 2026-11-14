# Agent Note: One materialization of the market clean-checkout fixture

Status: implemented

## Problem

`pnpm test:scripts` 的墙钟几乎全花在 `scripts/market-build-clean.test.mjs` 一个文件上。它的八个用例各自调用 `fixture()`，把整棵已提交的 market 树物化进一个新的临时目录，而真正的开销是这次复制，不是被它验证的门禁。在本机空闲窗口（`loadavg` 2.5-6.7，10 核）实测：

- `.market-inputs/{pet,community,presets}` —— 35421 个文件，6.3-7.9s
- `market/dist` —— 4678 个文件、519MB，1.3s
- `.market-inputs/skins` —— 789 个文件，0.26s
- `node scripts/market-build --check` 本身 —— 2.0-2.2s

也就是说，直觉上最贵的 4678 文件 dist 只占约 15%，主导成本是抓取下来的内容缓存。八个用例因此在一个 67s 就结束的门禁里花掉 65-75s，而这个门禁每个 PR 都跑。

## Decision

`scripts/market-build-clean.test.mjs` 每个测试文件只物化一次这棵昂贵的树（在 `before` 钩子里），所有用例共用它：

- 用例必须声明**它可能创建、修改或删除的每一条路径**（`borrowFixture(t, scratch)`）。helper 先对这些路径做快照（内容加时间戳），再由 `t.after` 钩子恢复——node:test 在用例失败时同样会跑这个钩子。
- 恢复之后，helper 用建树时记录的快照校验整棵树（路径集合、类型、大小，以及逐路径时间戳）。写到未声明位置的用例会在这里按路径名失败，而不是悄悄污染后面的用例。
- 唯一那个跑完整构建的用例会重写 `market/dist` 下的每个文件，因此不能直接借用共享树：`borrowWritableDist` 先把共享 dist 改名让开，交给该用例一份副本，结束后再把原件改回来。原 dist 的 inode 从未被写入，而 36k 文件的输入缓存保持共享，于是这个用例的代价是一次 1.3s 的 dist 复制，而不是 9s 的整树物化。
- `market-build --check` 会把它的比对树物化到 `.market-check-tmp`，在所有走到比对环节的路径上都会清理；但在那次 emit 之后才抛出的拒绝（`verifyTryonManifest` 遇到 tryon 目录里的未声明文件）会把它留在原地。过去它会随每用例的副本一起消失，所以共享树在每个用例之后清掉它。
- 最后一个用例断言物化计数：共享树恰好建了一次，另一处遍历只有那次 dist 复制。守护用计数而不是时间预算，因为本仓没有计时校准，预算会随机器变化。
- 物化时会跳过抓取下来的 community 目录里的包管理器缓存（`node_modules`）。该目录只通过一个 JSON 文件（`community.json`，`scripts/market-build:87`）读取，门禁从不遍历它，而开发者检出里的一次本地安装就给这份拷贝多加了 29458 个文件。skin、pet、preset 三个目录会被门禁遍历（`listFiles`），因此那里不参与过滤；守护同时断言这次排除的两半：community 输入下没有 `node_modules`，以及门禁确实会读的 `community.json` 存在。
- 物化守护接收自己的测试上下文，因此在没有 `.market-inputs` 的路径上——所有不抓取输入就运行 `pnpm test:scripts` 的车道——用例是跳过而不是因未定义的上下文失败。

隔离性由机制保证而不是靠约定：恢复在失败时也会执行的 after 钩子里进行，快照校验把任何未声明的漂移变成一条指名道姓的失败断言。

## Measured

`node --test scripts/market-build-clean.test.mjs`，在同一窗口内交替采改造前后样本，每侧三个样本：

| 抓取下来的输入缓存 | 改造前 | 改造后 |
| --- | --- | --- |
| 3793 个文件（已抓取的检出） | 13.40 / 13.56 / 14.25s，中位数 13.56s | 13.98 / 13.68 / 14.42s，中位数 13.98s |
| 33252 个文件（community 输入里带着包管理器缓存的检出） | 30.60 / 28.74 / 29.28s，中位数 29.28s | 13.75 / 14.81 / 15.53s，中位数 14.81s |

第一行体现共享本身的效果：一棵夹具取代八棵，把缓存为 35k 文件时的该文件从 99.27s 降到约 24s；随后的排除让「被污染的缓存」与干净缓存落到同样的 15s——同一棵树上不做过滤的对照运行是 26.06s，第二行的收益来自这里。缓存未抓取时整个文件约 0.1s 跳过。

`pnpm test:scripts`：改动后 384/384 通过，在已抓取缓存的工作树里单次运行 16.5s。

文件内剩下的就是门禁自身的工作：四个用例各跑一次完整 `market-build --check`（每次约 2.1-2.6s，各自物化对照树并把 529MB 的 dist 哈希两遍），跑完整构建的用例复制一次 dist（2.75s），三个提前拒绝的用例各约 0.2s，初始化加清理约 3s。要再压下去就得改 `scripts/market-build` 或裁剪夹具内容，两者都会削弱门禁所证明的东西。

## Alternatives considered

- **reflink / clone 复制**（macOS 的 `cp -c`、Linux 的 `cp --reflink=auto`）：否决。reflink 依赖文件系统（不支持 reflink 的 ext4 会退化成按字节复制），而 darwin 专用捷径在 Linux CI 车道上跑不了。
- **每个用例对共享树做硬链接农场**：否决。通过硬链接写入会改写共享 inode，就地修改文件的用例会污染后面每个用例的基准，而且这种失败是静默的——正是隔离要求所禁止的失败方式。
- **把树里不可变的部分符号链接进每用例的覆盖层**：否决。`market-build` 从 `path.resolve(__dirname, '..')` 推导自己的根，而 Node 会把被符号链接的脚本解析到真实路径，于是被软链的 `scripts/market-build` 会构建进共享树而不是该用例的覆盖层。
- **只复制用例要改的那几个文件，其余从仓库读取**：否决。门禁的每条路径都从它自己的根解析，夹具必须是一棵自包含的检出；残树验证的是门禁根本见不到的布局。
- **把夹具的输入缓存裁剪到目录实际读取的那些文件**：暂不采用。它能把夹具进一步缩小，但会改变「干净检出」门禁所证明的东西，而上面的共享已经去掉了实测指认的重复。
- **把各个 check 用例并行跑**：作为本项成本的解法否决。实测里物化（每用例 6.3-7.9s）远高于 check（2.0-2.2s），并行 check 会留下主导项，还会在共享树上引入数据竞争。

## Consequences

八个用例现在共用一棵树，新用例必须声明自己的 scratch 路径；忘记声明的用例会在快照校验里按路径名失败，而不是静默通过。快照校验每用例一次 stat 遍历（约 0.2s），初始化再多一次整树遍历。跑完整构建的用例仍要复制 519MB 的 dist，这是该文件内部剩下的最大单项成本。`scripts/market-build` 没有任何改动：门禁语义、清单字段与 pin 守卫行为都与之前一致。

## Testing

`node --test scripts/market-build-clean.test.mjs` 9/9 通过（八个用例加物化守护）。两个负对照跑在 `/tmp` 下用符号链接搭出的检出副本上，因此没有触碰仓库状态：

- 共享之前的文件加上物化守护后，该守护以 `actual: 8` 失败，而它原本的八个用例仍然全过——说明守护能失败。
- 当前文件在一个用例里注入一处未声明写入后，该用例自身的断言全部通过，随后隔离守护以 `scripts/scratch.txt` 指名失败——说明隔离守护能失败。
- 当前文件去掉 community 过滤后，在带缓存的检出上运行：八个用例全过，守护在 `node_modules` 断言上失败——说明这次排除是被断言的，不是想当然的。
- 当前文件在没有 `.market-inputs` 的检出上报告九个跳过、零失败，而忽略测试上下文的旧回调报告 `ReferenceError: t is not defined`——每条未抓取缓存的车道所走的跳过路径都被覆盖。

`pnpm test:scripts`（383 个用例）、`pnpm test:standards`、`pnpm typecheck`、`pnpm emoji:check`、`pnpm docs:check` 均随本次改动通过。
