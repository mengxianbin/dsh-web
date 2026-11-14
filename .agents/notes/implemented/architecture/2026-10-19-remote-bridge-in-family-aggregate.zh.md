# Agent Note: 远程桥接以家族聚合行的形式挂载

Status: implemented

## Problem

`@linxin666/dsh-remote-bridge` 原本是一个独立安装的插件：它自己的 `cordis.patch.yml` 插入 `remote-bridge` 行，而 `packages/dsh-web-all/aggregate.yml` 里没有它。因此装下整个家族聚合包并不会带上桥接，而桥接 README 早已声称聚合包会装上它——那是一个关于并不存在的行的承诺。两条通道还必须同时成立：一个 profile 可能同时带着聚合行与同一个 npm 包的独立行，而两个来源注册的是同一份进程级面——`/ios/v1` 升级路由与 `/remote-bridge/pair/token` 路由。协议面本身另有归属——见[桥接协议笔记](2026-10-16-remote-bridge-protocol-v1.md)——行机制见[故障隔离壳笔记](2026-09-01-aggregate-plugin-fault-isolation-shell.md)；本笔记只负责桥接怎么安装。

## Decision

桥接是家族成员了。`packages/dsh-web-all/aggregate.yml` 在 `patchFrom` 与 `deps` 两处列出 `../dsh-remote-bridge`，于是生成器产出 `web-ui-remote-bridge` 插入行，`name` 为 `@linxin666/dsh-web-all/remote-bridge`、`config.plugin` 为 `@linxin666/dsh-remote-bridge`，并写入 `workspace:*` 依赖、维护 `./remote-bridge` 子路径导出（`icon`、`locale/{en,ru,zh}.json`）与 `shellNotes` 说明。该行排在远程访问面（`remote-web-ui`、`update`）之后：桥接是家族的第二条远程面，但它只注入官方服务——宿主侧的 `typertGateway` 与 `webServer`，浏览器侧的 `dsh-client-locale`、`dsh-client-ui-renderer` 与 `dsh-client-ui-sidebar`——因此不欠任何家族行一个席位，也不会拆散 `update` 与 `remote-web-ui` 之间的相邻关系。不需要 `familyIds` 覆盖：派生出的行 id `web-ui-remote-bridge` 与子路径 `remote-bridge` 既不撞官方行名册，也不撞独立行 id。

宿主半区被家族的守卫包住：`mountOnce('@linxin666/dsh-remote-bridge', applyImpl)`，副本来自 `packages/dsh-remote-bridge/src/mount-once.ts`（`sync-shared` 从 `shared/host/mount-once.ts` 生成）。没有它，第二个来源会在同一个宿主上再注册一遍同一条升级路由与同一条 token 路由。有了它，先挂载者持有包名，第二次挂载被排队而不是丢弃，并在持有者 dispose 时被重放——那正是重载场景（新 loader 条目先挂载、旧条目后拆除）下丢弃会一直丢到下次宿主启动的情形。

独立安装通道仍然敞开。包保留自己的 `cordis.patch.yml`（行 id `remote-bridge`）与 `dsh.bundle.patch` 声明，仍在 npm 发布流程里，因此 `dsh plugin --profile <name> add @linxin666/dsh-remote-bridge` 无需聚合包即可挂载它，并跟随本包自身的版本而不是聚合包的版本。两条通道加载的是同一个 npm 包，这正是守卫以包名为键能生效的前提。

本机 desktop profile 删掉了桥接的独立 `link:` 条目与它在 `dsh.profile.bundles` 里的行，于是这台机器上重新只剩一个安装来源；同两个半区由聚合行提供。

## Alternatives considered

- **只改 README、让包继续独立安装。** 否决：那样这句话会变成「聚合包不带桥接」，事实为真，却让装了整包的场景仍然缺少家族的第二条远程面——操作者还得额外知道有第二个包。
- **把桥接写进聚合包的 `dependencies`，但仍只经它自己的 patch 行挂载。** 否决：聚合包的依赖清单是生成器唯一维护的入口，被依赖却从不插入正是本次要消灭的状态——包会把代码装上却什么都不挂。它还把「聚合包声称拥有的一行」留在 profile 手里。
- **带上家族行但不加单实例守卫。** 基于已发生的故障形态否决：两行同时存在时，第二次挂载会重复注册 `/ios/v1` 与 `/remote-bridge/pair/token`，宿主 web server 会报重复注册，并且一个进程里出现两个名册持有者。守卫正是家族为这种配对定下的惯例（`packages/AGENTS.md`），其余每个家族包都已带着它。

## Consequences

- 聚合包从此要为桥接的浏览器半区负责重建：聚合内联仓库内子插件的客户端源码，改动后需 `pnpm build` 加 `pnpm libs:write` 刷新 `packages/dsh-web-all/lib`。
- 同时带着聚合行与独立 link 行的 profile 仍能工作，但两行就是同一个插件：第二个在第一个 dispose 之前是空操作，同时开启除了让行列表更慢之外没有收益。
- 包自带展示元信息，这正是挂裸包名的行所渲染的内容：`icon.svg`（家族素材的字节拷贝，所以每张家族卡片都是同一头鲸鱼）与携带 `meta.title`、`meta.description` 的 `locale/{en,ru,zh}.json`，两者都在 `files` 白名单里，因此 npm tarball 会带上它们。`locale` 那些键是承重的而非装饰：宿主读取器经包的 export map 解析每种语言，所以只有 `locale/` 目录而没有对应 `exports` 条目时会被静默忽略，行退回包名与 npm 描述。聚合包的 `shell-metadata` 目录仍然只是 `web-ui-*` compat 子路径的展示来源；把桥接文案复制过去会让同一个插件有两个互相矛盾的展示来源。

## Testing

`packages/dsh-remote-bridge/tests/plugin.spec.ts` 在套件已有的假宿主上挂载插件两次：第二次挂载两条路由都不注册；dispose 第一个挂载会重放排队的那次，随后两条路由才出现在第二个宿主上。两条用例在 `apply` 未被包裹时都失败，加上守卫后通过。`node scripts/aggregate.mjs --check` 钉住生成的行、依赖与 shell 元数据。
