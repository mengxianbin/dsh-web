# Agent Note: profile 行跟随如今承载该 id 的包

Status: implemented

## Problem

include 的补丁语义会跳过 `name` 与「某个 bundle 在该 id 下插入的那一行」不一致的行，
而这一跳过带走的是整行：profile 里一行 `config:` 于是什么都不再配置，一行
`disabled: true` 于是什么都不再禁用；loader 只在每次启动时留下一行
`patch: name mismatch for "<id>" … skipping` 的日志，而没有任何产品界面读它。

[issue #1901](../architecture/2026-10-18-aggregate-family-rows-mount-real-packages.zh.md)
把聚合包的每个家族行从 `@linxin666/dsh-web-all/<family>` 子路径改成
真实包名（`@linxin666/dsh-client-ui-task-board` 等）。行 id 仍是 `web-ui-*`，
所以按 id 定位的覆盖仍然命中——但凡是同时带着旧 `name:` 的 profile 行，都被整行跳过。
在发现这个问题的那台机器上，任务看板的 GitHub 提供方正是通过聚合行配置的：它的仓库
列表不再生效，`assignee` 通道随之消失，仓库自动指派给本账号的 issue 全被过滤掉，
看板上显示零个 open issue，而产品里没有任何一处报错。

## Decision

插件管理器修复 profile 自己的行：行 id 仍被某个已安装 bundle 认领、但记录的行名与该
bundle 那一行携带的名字不一致时，把行名改写成现在的名字。

- 现在的名字取自已安装 bundle 自己的 `cordis.patch.yml`——loader 插入那一行时读的
  正是这个名字——因此被修复的行指向的正是 loader 会在该 id 下挂载的包。
- 行 id 没有被任何已安装 bundle 认领的行不动：它的包可能仍由本管理器看不到的某一层
  携带，而证明不了的名字就不能写下去。
- 修复是幂等的，只有行确实变了才落盘：健康的 profile 不会被重写、不会被备份、不会
  被重新加载。
- 修复在两处运行：一次在启动稳定之后（宿主重写该层、loader 热重载，被修复的配置
  无需重启即生效），一次在升级后的清理通道里，于是「在插件更新时撞上改名」的情形
  在那次更新进行中就被修好。

这是修复，不是迁移：它把 profile 自己对一个仍然存在的行所说的内容恢复回来。它不新增
行、不删除行，也不替行决定内容。

## Alternatives considered

**让聚合包保留旧的子路径名。** 否决：那等于回退 #1901 中去掉 2.9 MB 内联客户端包的那
一半，而那正是改名的全部理由。

**在本仓库里提供一个一次性迁移脚本。** 否决：故障是静默的，没有人知道要去跑脚本；
一个必须手工运行的脚本不能是「没人察觉」这类缺陷的唯一修复手段。

**让各家族插件容忍配置缺失。** 否决：那只修掉了普遍故障的一个症状。同一次改名也会
静默丢掉 `disabled: true` 覆盖，于是用户关掉的插件又回来了；插件层面的绕开办法
管不到这一条。

**请宿主写 profile 行时不带 `name:`。** 本仓库做不到：宿主配置编辑器是那个写入器，
而 loader 侧的名字检查属于宿主行为。

## Consequences

- 某个 bundle 改了行名的 profile，在下一次启动后拿回该行的配置与启停状态，修复本身
  记在宿主日志里（`已修复 profile 中失效的行名`），于是这次变化是可见的，而不是
  静默的。
- 插件管理器多写了一个它此前不写的文件（profile 层）。这次写入走的是它其余所有
  profile 写入同一条「备份 + tmp + rename」路径，并且只在行名可证明地过期时才发生。
- 修复覆盖 profile 装了的那些 bundle 的行。包名被 profile 之外的 bundle 改掉的行
  仍带着过期的名字，loader 仍会跳过它：管理器只从读得到的 bundle 里证明名字。
- loader 自己的 `name mismatch` 警告仍是 loader 的事。修复消除的是 profile 行制造出
  那个处境的原因；它不替 loader 闭嘴。

## Testing

`packages/dsh-plugin-manager/tests/rows.spec.ts` 钉住这个修复：过期的配置行被指向
现在的包并保留其配置，过期的启停覆盖同样被修复，没有任何已安装 bundle 认领的行与
不带名字的行原样不动，而行名已经正确的层原样返回、调用方因此什么也不写。
`pnpm --filter @linxin666/dsh-client-ui-plugin-manager typecheck` 与
`pnpm --filter @linxin666/dsh-client-ui-plugin-manager test` 通过。
