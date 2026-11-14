# Agent Note: An official plugin update is two phases, because the manager refuses to reinstall

Status: implemented

## Problem

在打包桌面客户端上，更新区块的批量操作对它列出的每个第三方插件都失败——`dsh-better-sidebar` 0.26.1 → 0.28.0、`dsh-free-search` 0.9.0 → 0.9.1、`dsh-llm-verifier` 0.9.5 → 0.10.1——报 `plugin-manager: 官方插件管理器更新失败：官方插件管理器拒绝执行（already-installed）`，profile 里的版本没有动。

三个已发布的事实合成这次拒绝：

- `@deepseek-ai/dsh-plugin-manager` 只暴露 `installBundle` 与 `removeBundle`，没有更新原语；而 0.2.1-rc.2 已是最新发布版本（npm `dist-tags`：`next = 0.2.1-rc.2`）。
- 它的 `installBundle` 开头有一道守卫：宿主挂了 `hmr` 服务、且 spec 解析出的包名已经是 profile 依赖时，在 pnpm 启动之前就抛 `ManagementFailure('already-installed')`。
- `@deepseek-ai/dsh-base` 在每个 profile 宿主上都挂这个服务（`id: hmr`，`disabled: !ctx.get('profileContext')`），因此只要有 profile，守卫就生效——官方插件页自己的更新按钮同样如此，它把 `officialBundleInstallTarget` 给出的 `name@version` 交给 `installBundle`。

于是应用自有 profile 上的更新没有实现路径：CLI 直接拒绝 `--profile desktop`，而[原生写入器](2026-09-26-plugin-manager-app-owned-update-path.zh.md)只是一次 `installBundle` 调用。那条路径上线时守卫还不存在——在 0.2.0-rc.2 上 pnpm 真的跑过 `dsh-better-sidebar` 0.22.1 → 0.24.1。

## Decision

`CliGateway.update` 仍先发一次 `installBundle`，并用「同一个官方管理器下的两阶段替换」来应答 `already-installed` 拒绝：

- `nativeManagerRefusalCode()` 从已 resolve 的判定里读出管理器的失败码——就是 `nativeManagerFailure()` 渲染给人看的那个判定——于是更新路径可以按 `already-installed` 分支，而不是匹配文案。
- 随后 `replaceInstalled()` 执行 `removeBundle(id)` 再执行 `installBundle(id@version)`。先移除才让安装成为可表达的：守卫读的是 profile，旧依赖消失后这个名字就是新依赖。`removeBundle` 在 pnpm 移除之前会先禁用该组合包并 reload，这也顺带通过了它的 `bundle-in-use` 检查。
- 管理器拒绝移除时，更新以该拒绝结束且不再写入。第二阶段失败时，装回运行时 profile 原有的依赖 spec（`id@<原 spec>`），并在错误里同时写明两件事：拒绝原因，以及旧版本是否已装回、还是需要手动重装。
- `bundle-in-use` 拒绝只应答一次，不重复抛出（issue #1905）。官方守卫是**先**取消勾选该组合包并 reload，**之后**才判定该组合包的行是否仍有活跃 fiber，所以拒绝到达时取消勾选已经落盘；`removeForReplacement()` 针对这个已稳定的状态再问一次，这条重试能清掉「真实占用，其 fiber 被那次 reload 卸掉」的情形。它对「同一次 reload 又把刚卸掉的行重建出来」无效——新 fiber 再次命中守卫——所以这条重试只值一次调用，绝不循环。第二次仍被拒时，用 `setBundleEnabled` 把选择状态还原，并在报告里点名需要重启；两阶段替换绝不留下半应用的 profile。
- 已经落地、但运行中的宿主加载不了的替换，报成「带上重启事实的成功更新」，绝不报成失败（issue #1905）。移除已经生效、而被替换组合包的行此时已从运行进程里消失时，管理器返回 `application: 'restart-required'`；`nativeManagerRestartRequired()` 读取该判定的方式，与 `nativeManagerFailure()`、`nativeManagerRefusalCode()` 读取拒绝判定一致。`runNativeUpdate()` 保持作业为 `done`，并把组合包名写进 `GatewayJob.restartRequired`；`/status` 的作业 wire 承带该字段；两个客户端面分别如实展示——单包区块与批量工具条在各自既有的重启入口旁渲染 `updateRestartRequired`（`已更新到 {version}，需重启 DSH 后生效`）。这个事实刻意不走 `job.error`：错误行会让批量更新在第一项就中断，而版本确实已经落地。
- 替换过程中组合包保持原有的层级位置。`removeBundle` 会把它从 `dsh.profile.bundles` 里删掉，而重装是把它追加到末尾，于是朴素的「先移除再安装」会把该组合包挪到所有原本在它之后的组合包后面——而 `dsh.profile.bundles` 正是 loader 套用 patch 的层级顺序。`restoreBundleIndex()` 把它放回原位，更新成功与回滚都走这一步。
- 单次调用保留在最前，因此上游哪天接受原地更新，这条路径无需改动；其下的版本校验不变，替换后没有任何位移仍然是 `更新未生效`。

在应用自有 profile 上官方管理器仍是唯一写入器，其他运行时仍由 CLI 唯一写入——这里没有任何地方直接写 `package.json` 或自行跑 pnpm。

## Alternatives considered

- **只报告拒绝并停下。** 否决：更新区块的意义就是推进插件版本；在桌面运行时这样做等于让它永久成为摆设，而官方页自己的更新按钮同样会失败。
- **宿主挂了 `hmr` 时禁用更新入口。** 否决：那是每个 profile 宿主，等于为了描述一个上游缺失的原语而在所有地方关掉该功能。
- **由 host 半区自己写依赖并用启动器自带的 pnpm 安装。** 否决：这会成为同一 profile 的第二个写入器——两者会竞争锁、组合包 patch 的落盘，以及官方管理器在变更前后自己做的 reload；仓库规则是一个 profile 只有一个写入器。
- **先让上游提供更新原语，什么都不修。** 否决：这道守卫按其目的而言本身是对的，已发布版本也没有放宽它，所以无论更新 API 何时出现，这个绕过都必须存在。
- **在插件被短暂卸载前向用户再要一次确认。** 否决：更新本身已经是用户确认过的动作、并有可见作业，而且替换失败时会装回旧版本；多一次弹窗只是把作业错误报告里已有的风险信息提前。

## Consequences

- 桌面端更新现在会卸载插件、reload profile、安装新版本、再 reload 一次——插件在两个阶段之间处于缺失状态；持续轮询作业的客户端只会把它看成一次正常的进行中更新。
- 失败报告的范围比以前宽：错误会指明是哪个阶段拒绝（`已安装版本无法移除（…）`），以及在替换失败后 `id@<原 spec>` 是否已装回、还是必须手动重装。用范围 spec（`^0.9.5`）回滚恢复的是依赖关系，不一定恢复当时安装的确切版本。
- 第一次调用仍花在当前运行时必然拒绝的一次运行上：因为守卫在 pnpm 之前，不耗 pnpm 时间，但宿主安装状态流里会多出一个状态。
- 所有非桌面运行时的更新不变：CLI 路径不会碰到这道守卫。
- 批量更新结束时 profile 的组合包顺序与开始时一致，因此一连串更新中各行始终从同一批层级继承。
- 「版本落地但当前进程加载不了」的更新现在会如实这么显示。此前作业以干净成功结束，客户端显示为原地更新完成，而插件的行其实在下次重启前已经不在了。

## Testing

`packages/dsh-plugin-manager/tests/gateway-jobs.spec.ts` 用脚本化的官方管理器钉住这些结果：拒绝后成功移除并重装、替换失败后装回旧 spec、移除本身被拒、一次会话内两个插件都更新成功、应答 `bundle-in-use` 的那次单次重试、两次判定都被拒时报告点名重启并还原选择状态，以及更新后组合包保持的层级位置。

重启事实另有自己的覆盖：同一份 spec 读取各种判定形状上的 `restart-required`，钉住「移除以 `restart-required` 落地」与「重装以 `restart-required` 落地」两种情形——两者都以 `done` 结束并由 `restartRequired` 点名该组合包——同时钉住原地更新不携带任何重启事实。`tests/plugin-list-toolbar.spec.tsx` 与 `tests/PluginUpdatePatch.spec.tsx` 钉住两个面上的文案、以及批量更新继续跑完并把该插件仍计入已应用；`tests/protocol.spec.ts` 钉住该列表的容错读取。

#1905 的复现装置在 DSH checkout 里，不在本仓：`packages/boot/plugin-manager/tests/manager.spec.ts` 会启动真实的 profile Include、真实的 Loader 与真实的 `hmr` 服务，那是唯一能端到端观察官方守卫的地方。在那里把两阶段序列在一次会话里连跑两遍，第二个组合包会被正常移除，同时也暴露出本网关现在会纠正的层级重排。
