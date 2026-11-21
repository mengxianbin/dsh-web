# Agent Note: 在 Windows 上串行化设备名册写盘

Status: implemented

## Problem

同一回合里的两次 APNs 投递可能同时失败，并并发注销各自的 Live Activity token。每次注销都会更新内存中的 `DeviceRoster` 并等待 `#persist()`，但这些写入此前没有先后顺序。在 Windows 上，两个同目录 rename 同时替换 `devices.json` 会报 `EPERM: operation not permitted`。现有失效 token 测试在这台宿主上稳定复现该失败，而顺序执行的 rename 探针可以成功。

问题不在名册 schema 或原子写保证。旧实现已经使用唯一临时文件、`fsync`、关闭、rename 和 `chmod 0600`，缺少的是并发写操作之间的互斥，导致持久性与最终 token 注销结果取决于文件系统时序。

## Decision

`DeviceRoster` 现在为每个实例维护一条 `#writeQueue`。`#persist()` 把实际写入追加到该队列，并把属于调用方自己的 Promise 返回。现有 `#write()` 实现保持不变：临时文件、`fsync`、关闭、原子 rename 和 `chmod 0600`。

队列尾部捕获失败写入，只是为了让后续写入继续；等待该写入的调用方仍会收到原始错误。内存变更继续按现有同步顺序执行，每个排队写入都序列化当时的名册，因此最终文件包含所有已被接受的变更。

现有 `tests/liveactivity.spec.ts` 中两个并发失效 token 的场景就是回归覆盖。没有新增依赖、schema、协议或公开 API 变更。该修复独立于[推送通知契约](../architecture/2026-10-21-remote-bridge-push-notifications.md)，是在 [SDK cohort rc.3 验证](../architecture/2026-10-24-sdk-cohort-0.2.1-rc.3.md) 中发现的，并非 rc.3 API 变更所致。

## Alternatives considered

**在 `EPERM` 后重试 rename。** 否决：任意重试只是掩盖竞争，而没有建立写入顺序；并发替换仍可能让持久化结果取决于时序。串行化才处理根因。

**记录日志并忽略持久化失败。** 否决：留在盘上的失效 token 之后可能再次发往 APNs，违背注销契约。调用方仍会收到原始错误。

**为所有名册使用一条进程级全局队列。** 否决：独立的实例和文件不需要互相阻塞。只有同一名册/文件对需要互斥，因此队列属于实例。

**改变盘上格式或只在内存中注销。** 否决：既有 profile 与持久化 schema 仍然有效，仅内存注销会在重启后丢失。

## Consequences

- 并发 token 注销不再与 Windows 替换 `devices.json` 的操作竞争，原先失败的 33 个 live-activity 测试全部通过。
- `pnpm --filter @linxin666/dsh-remote-bridge typecheck`、全包套件（42 个文件、583 个测试）以及 `pnpm --filter @linxin666/dsh-remote-bridge build` 均在修改后通过。
- 全工作区 `pnpm test` 也在 rebase 后的树上通过。另一个 task-board 挂载测试在并发负载下的超时，单独重跑即通过，随后一次全仓运行也通过；它不属于本修复。
- 无需迁移：既有 `devices.json` 仍按 version-2 schema 读取，临时文件与权限语义不变。
