# Agent Note: 崩溃宿主的隧道子进程由下一次启动回收

Status: implemented

本记录拥有一个生命周期决定：自动隧道的 `cloudflared` 子进程在宿主未来得及拆除隧道就死掉之后怎么办。*运行中*隧道的监督由[运行中的隧道以公网 URL 为准](2026-09-25-tunnel-readiness-watchdog.md)拥有；本记录拥有的是那个活得比宿主更久的进程。

## Problem

`TunnelManager` 经 `cloudflared` 包的 `Tunnel` 拥有子进程。正常退出会走 `dispose()` -> `stop()` -> `teardown()` -> `handle.stop()`，子进程被杀掉，所以干净关停不留残留。崩溃不会走这条路：子进程被交给 `launchd`/`systemd` 收养，继续维持它的边缘注册，占着一个没人服务的域名；下一个宿主还会在旁边再起第二个连接器。

2026-10-17 在 0.2.1-rc.2 宿主连环崩溃之后实测（`dsh-task-board` 的 `assertPeerLive` 读 `signal` 抛 TypeError）：这样一个子进程以 pid 4548、`ppid 1` 存活，命令行是

```
cloudflared tunnel --url http://127.0.0.1:19387 --no-autoupdate --protocol http2 --http-host-header <hostname>
```

它已经毫无用处：19387 早没人监听，拥有它的宿主没了，它的 `trycloudflare` 域名也已注销——公网入口返回 HTTP 530，响应体里正是同一个死域名。唯一的出路是人工按命令行去匹配进程，而这恰恰是不能朴素自动化的一步：找出孤儿的同一条 `pgrep -f 'cloudflared tunnel'` 也会找出用户自己的隧道，任何按模式杀进程的做法都可能命中插件从未启动过的进程。

## Decision

管理器记录自己启动的那个子进程，并在下一次启动时只回收它。

- **启动之后立即记录。** `attempt()` 在工厂返回后第一件事就是把 `{ pid, command, ownerPid, recordedAt }` 写到 `$DSH_HOME/remote-web-ui-tunnel-child.json`（`0600`），其中 `command` 是子进程自己的 `spawnargs` 以单空格拼接，`ownerPid` 是宿主进程。不暴露 OS 进程的 handle 干脆不记录——记录是观测，不是猜测。
- **子进程停止时清除。** `stopHandle()` 停掉 handle 并删除记录，但只删本管理器写下的那条；兄弟宿主写下的记录不归它删。`fail()` 与 `teardown()` 都走这里，所以优雅路径依旧不留残留。
- **下一次启动先回收再拉起。** `attempt()` 在确保二进制之后、`factory()` 拉起之前执行回收，因此第二个连接器出现时孤儿已经消失。回收只结算一条记录：
  - 没有可信记录（文件不存在，或 `pid`/`ownerPid`/`command` 缺失、非正）-> 删除文件，判定 `none`；
  - 记录的 pid 已不存在，或该 pid 上的进程报出*不同*的命令行 -> 只删文件，判定 `stale`，不发信号。因此 pid 复用绝不可能让插件杀掉陌生人；
  - 记录的属主宿主仍然活着 -> 两个都不动，判定 `owned`。两个活着的宿主可以共用一个 DSH home（两个 profile，或一个宿主内的插件重载），各自拥有自己的子进程；
  - 其余情况对记录的 pid 发 `SIGTERM`，在有界宽限期（3 秒）内轮询存活，仍活着则 `SIGKILL`，删除文件，判定 `reaped`。
- **命令行才是进程的身份。** pid 只是一个会被复用的数字；`ps -ww -p <pid> -o command=`（Linux 用 `/proc/<pid>/cmdline`）必须逐字符复现记录的那一行。任何地方都不按进程名、端口、父进程或模式匹配。
- **失败要保守，不要吵。** 回收抛错只记一条 warning，绝不让隧道启动失败；既无 `ps` 又无 `/proc` 的平台（Windows）报「命令行不可读」，按 `stale` 处理并且不发任何信号。

## Alternatives considered

- **`pkill -f 'cloudflared tunnel'` 或任何模式匹配。** 直接否决：这是唯一能杀掉用户手工启动的隧道的动作，而且它分不清插件的子进程与只是提到该名字的包装进程。记录的 pid 加匹配的命令行，才是「插件确实启动过」的唯一判据。
- **只记录 pid。** 否决：pid 一旦复用，下一次启动就会杀掉一个无关进程。命令行比较才是把数字变成身份的那一步。
- **按它代理的端口去找孤儿。** 否决：孤儿的 `--url` 指向的是*已死*宿主的 loopback 端口（上面的 19387，早已关闭），下一次启动自己的端口也不同，按端口什么也找不到。
- **让子进程独占进程组（`detached: true`）再杀整组。** 否决：这会改变终端信号的投递对象（Ctrl-C 不再传给 `cloudflared`），而清理只需要一个被记录的 pid。
- **由宿主或插件管理器在启动时回收。** 否决：两者都不拥有这个子进程，也无从知道它是谁的；而本该动手的那个宿主刚刚崩溃。拉起子进程的管理器是唯一能写下诚实记录的角色。
- **每个 profile 一条记录。** 暂不采用：有了属主 pid 守卫之后，每个 DSH home 一条就够，而按 profile 落盘还需要隧道管理器本来并不持有的 profile 身份。

## Consequences

- 优雅退出不变：`dispose()` 仍然杀掉子进程，现在还顺手删掉记录，因此健康宿主绝不回收自己活着的子进程。
- 一次崩溃最多丢掉一次回收：记录被活着的兄弟宿主覆盖、或在拉起与写记录之间崩溃，都会留下那一个子进程。
- 记录是每个 DSH home 一份文件，所以先后崩溃的两个宿主只保留最后一条；更早那个子进程仍需按老办法手工处理。
- Windows 永不回收（没有 `ps`、没有 `/proc`）；Linux 的 `/proc` 分支在本机有单测，但没有在 Linux 宿主上实跑。
- 插件现在会在启动时给某个进程发信号。这是新的安全相关行为，已在包 README 双语对中披露。

## Testing

- `packages/dsh-remote-web-ui/tests/tunnel-orphan.spec.ts`（8 条用例，跑真实的 `node -e` 子进程与一次性 `DSH_HOME`）：属主已死的残留会在下一次启动被回收；pid 已消失、命令行已改变两种情况都只删记录不发信号；忽略 `SIGTERM` 的子进程会在有界等待之后被 `SIGKILL`；活着的属主同时保住子进程与记录；管理器绝不删除不是自己写的记录；Linux `/proc` 解析结果与 `ps` 一致。
- `packages/dsh-remote-web-ui/tests/tunnel.spec.ts` 继续固定优雅路径：dispose 杀掉子进程且不留下记录文件。
- 2026-10-17 在隔离 `DSH_HOME` 用真实二进制实测：自己拉起的 `cloudflared` 以死属主记录后回收结果为 `reaped`（进程消失、记录清除），命令不匹配的记录为 `stale` 且进程仍活着，属主为当前测试宿主的记录为 `owned` 且进程与记录都保留。
