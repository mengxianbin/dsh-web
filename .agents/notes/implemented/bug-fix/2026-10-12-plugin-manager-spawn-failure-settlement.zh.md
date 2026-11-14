# Agent Note: Plugin-manager 把失败的 CLI spawn 结算掉，而不是拖垮 dsh 宿主进程

Status: implemented

## Problem

两个各自独立的 Windows 缺陷在同一个功能里相遇，而第二个把第一个放大成了宿主级故障。

每个 `.cmd` shim 都必须经由命令处理器执行，而 `spawnDsh` 用裸名字去要它。裸名字要走宿主 `PATH` 解析，因此 `PATH` 里没有 `%SystemRoot%\system32` 的宿主——打包版桌面启动、服务账户、被裁剪过的环境——会得到一个磁盘上明明存在的二进制的 ENOENT。于是在一个本来健康的宿主上，所有走 CLI 的插件操作同时失败。

更糟的是，包里没有任何 spawn 出口挂着 `error` 监听器。没有监听器的 `ChildProcess` 会把 spawn 失败变成未处理的 `error` 事件，也就是未捕获异常：一次失败的 CLI 调用就把整个 dsh 宿主进程带走了。等待点带着镜像的缺陷——它们只按 `close` 结算，而 spawn 失败经常根本不会产生 `close`——于是宿主活下来的场合，调用方会永远等下去，channel 探测或安装任务卡住而不是报错。

`restart.ts` 里那个 detached relaunch helper 对「调用返回后才发生的 spawn 失败」有同一个未处理 `error` 漏洞，而它的重试循环只认退出码，因此一个根本没启动起来的 helper 被读成「启动了、干净地退出了」。

## Decision

本包 spawn 的每个子进程都会解析出真实的二进制，并在失败时完成结算。

- **命令处理器来自环境，而不是来自 PATH。** `windowsCmdPath(env)` 先读 `ComSpec`——按大小写不敏感匹配并忽略空值，因为 Windows 自己会根据写入方（启动器、服务、用户自己的 shell）拼出好几种写法——再读 `SystemRoot`，再读 `windir`，最后退回约定俗成的 `C:\Windows`，并把 `System32\cmd.exe` 拼到它找到的那个根下。优先 ComSpec，是因为它正是 Windows 为此保留的变量，且直接给出真实二进制路径。POSIX 分支不动：POSIX 宿主直接 spawn CLI，根本不需要命令处理器。
- **每个 spawn 出去的子进程都在 spawn 处被守卫。** `guardSpawnFailure` 挂上此前缺失的监听器：它把失败原因记在该子进程上，并在子进程尚未关闭时自己补发 `close(-1)`。因此只等 `close` 的调用方既不会挂死也不会崩溃。`SPAWN_FAILURE_EXIT_CODE` 就是那个 `-1`，且只有真正的 spawn 失败会触发它——错误对象的 `syscall` 以 `spawn` 开头。诸如「kill 没有落上」这类更晚的生命周期失败仍走正常 close 路径，因为那时子进程确实启动过，它的退出码才是真实判决。
- **一个等待辅助函数服务所有出口。** `awaitChildExit` 自己挂一对监听器，因此即便子进程是从注入的 spawn 缝进来的、跳过了守卫，它依然安全。`awaitCliExit(child, output, timeoutMs?)` 把它包起来：装配可选的 kill 定时器，把失败原因追加进有界输出捕获，返回退出码。五处各自手写了同一套「定时器 + `close` promise」的站点——官方安装器 channel 探测（`detectOfficialChannels`）、`CliGateway.runCli`、共用任务执行器 `CliGateway.runInner`、`CliGateway.rollbackInstall` 与安装后的启动预检 `CliGateway.verifyBoot`——现在共用它，因此一个从未成为进程的子进程与其他任何非零退出以完全相同的方式被报告。
- **relaunch helper 把 spawn 失败记进日志，而不是死在它上面。** `startRelaunchHelper` 挂上一个 `error` 监听器，把原因追加进它的日志，并容忍日志缺失；detached 启动器的重试循环现在把 spawn 错误与退出码同等对待：在尝试预算内重试，放弃时点名原因，而不是为一个从未运行过的 helper 报一次干净的停止。

包 README 的安全模型承载这件事面向用户的那一半：命令处理器按绝对路径寻址，仍然失败的 spawn 会结算成一个带原因的失败任务，而不是拖垮 dsh 宿主。

## Alternatives considered

**保留裸名字 `cmd.exe`，指望启动器去拼 PATH。** 否决：出问题的恰恰是 PATH 没被启动器拼过的宿主。二进制位置已经是环境里的一个事实，读它严格比让 PATH 再找一次更可靠。

**改为把 `%SystemRoot%\system32` 前置进子进程环境。** 否决：那是补一个缺失目录而不是修解析本身，它改变了每次 CLI 调用继承的环境（以及那次调用里其他所有依赖 PATH 的查找），并且把裸名字依赖留给下一个调用方。

**对 shim 的 spawn 使用 `shell: true`。** 否决：那会让 shell 重新解析参数向量，而 `windowsCmdShimArgs` 与 `windowsVerbatimArguments` 存在的意义正是避免这一点，并且会扩大本包刻意收窄的注入面。

**让每个调用方自己的 `error` 处理器去做结算。** 否决：Node 是异步发出 `error` 的，而且没有监听器时，在任何调用方代码运行之前进程就已经没了。结算必须挂在创建子进程的地方，在事件发出之前。

**让 await 的 promise 在 spawn 失败时 reject。** 否决：每个出口都已经有一条定义好的非零退出路径会渲染捕获到的输出，把失败变成被 reject 的 promise 只会给五处调用点各加一条控制流分支，去到达它们本来就能表达的状态。`awaitChildExit` 仍然把失败作为值暴露出来（`spawnError`），因此想分支的调用方仍然可以。

**对每个 `error` 事件都结算，而不只对 spawn 失败。** 否决：已经关闭的子进程，其真实退出码会被补发的 close 覆盖，于是把一个跑过并因自身原因失败的进程误报成 spawn 失败。

**守卫宿主而不是守卫子进程。** 否决：未处理的 `error` 事件会杀死进程，因此 spawn 之上没有任何能捕获这一点的恢复点。

## Consequences

- PATH 里没有系统目录的 Windows 宿主照常运行每一个走 CLI 的插件操作，因为命令处理器是从环境解析的，而不是靠名字查找。
- spawn 失败降级的是那一个插件功能，而不是 dsh 宿主进程：该操作通过它本来就会渲染的输出一条可读地报告原因，也没有出口会永远等待。
- `spawnDsh` 两条分支都返回被守卫的子进程，因此新的调用点会继承这份结算，而不必记得自己加上。通过 `spawnImpl` 缝注入的出口则由 `awaitChildExit` 覆盖。
- 失败以退出码 `-1` 报告，没有任何真实 CLI 退出码会与它相撞，因此调用方无需解析文本就能区分「从未启动」与「启动了但失败」。
- 起不来的 relaunch helper 仍然意味着重启没有发生；现在日志会说明原因、宿主也能活着把它报出来，而不是死在 `error` 事件上。
- 五个出口共用一条等待路径，因此它们的超时与输出处理不会再像五份手写副本那样各自漂移。

## Testing

`packages/dsh-plugin-manager/tests/spawn-failure.spec.ts` 通过 spawn 任何 PATH 都解析不出的名字来制造失败，因此这些失败是确定性的、与宿主 PATH 无关，并在每个用例期间记录未捕获异常。它覆盖 `windowsCmdPath` 的五种解析结果（ComSpec 路径、小写 `comspec`、空 ComSpec 回退到 `SystemRoot`、只有 `windir` 的环境、以及不指名任何根的环境）、结算本身（失败退出码加上捕获里的原因、没有未捕获异常、只等 `close` 的调用方被结算而不是挂死）、真实 `detectOfficialChannels` 探测在其 CLI 无法 spawn 时降级为「无官方 channel」、CLI 无法 spawn 的 `CliGateway` 安装结算为点名 ENOENT 的 `error` 任务且宿主安然无恙，以及 relaunch helper 在报告没有 helper 启动的同时把 `helper spawn error` 记进日志。包测试套件通过（338 项）。
