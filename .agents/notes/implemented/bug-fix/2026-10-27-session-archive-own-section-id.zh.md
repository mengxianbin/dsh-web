# Agent Note: 会话归档使用自己的设置 section id

Status: implemented

## Problem

设置外壳对每条 `settings.section` 注册各渲染一个导航项、不合并同 id 的 section；注册表按「同一 id + 同一 priority（缺省 0）」拒绝重复注册，order 只决定排序。`dsh-session-archive` 此前注册官方的 `archived-sessions` id，这是它在官方页面已不再挂载的 cohort 上把归档入口保持为一条的办法。当 profile 里同时运行第三方归档插件时——已有多个第三方插件挂载一级归档 section——同一个 id 与同一个 priority 重复占位：其中一条注册抛错，或两条入口中的一条从设置里静默消失。两种情况都让同时启用两个插件的用户丢掉一个自己并未移除的归档面（issue #1955）。

## Decision

插件注册自己的 section id —— `dsh-session-archive`（即插件 id）—— 位置仍是 order 25。

- 该 id 是本插件自己的命名空间，绝不占用属于官方页面或其他插件的座位。两个归档插件可以同时启用、各有一条入口，任一方都不需要探测或让位。
- 保留 order 25，入口仍落在归档管理原本所在的位置：紧邻官方 `archived-sessions` 行，而不是挪到导航列表的新位置。
- 只装一个归档插件的 profile 仍然只有一条入口。插件既不需要官方页面缺席，也不退役、不停用任何外部行。
- 入口文案仍取本插件自己的 `arch.nav`，跟随命名空间的当前语言，语言包照旧能落到它。

[接管决定](../architecture/2026-09-15-sdk-cohort-0.1.6-alpha.1-alpha-branch.md)对需要它的那个 cohort 仍然有效并保留在案。它「只保留一条入口」的前提现在靠 id 归属而不是 id 接管成立：每个归档插件各有一条入口，任何两个插件都不会争同一个座位。

## Alternatives considered

不换 id、只把接管做得更精细——换一个 `order`，或仅在观测不到其他注册时才占用官方 id——被否决。判重键是 `id` 加 `priority`，换个 order 只是把入口挪到列表别处、座位照样被占；`settings.section` 也不提供注册前可读的占位仲裁，插件无法证明座位是空的；相撞只会转移到某个加载顺序与某个恰好撞 id 的第三方插件上，而静默消失正是本次要修的失效形态。

保留官方 id、要求用户自行停用其中一个插件也被否决：这把组合问题变成支持工单，而那个第三方插件不归我们改。

整体删除本插件改用官方页面被否决，理由已记录在接管那条 Note 里：原生没有删除、没有批量操作、没有保留策略，删除即为能力回退。

## Consequences

同时启用两个归档插件时会出现两条归档入口——一插件一条——这是已接受的取舍：每条入口承载各自插件的行为，互不压制。单归档插件安装在条数与位置上都保持不变。

该 section id 是插件自有标识符，不再跟随官方 id，上游重新挂载或改名自己的页面时无需协调。

`packages/dsh-web-all/aggregate.yml` 的归档入口注释记录同一事实，包的双语 README 改为陈述 id 归属，不再声称没有其他归档插件注册该座位。

## Testing

`pnpm --filter @linxin666/dsh-session-archive exec vitest run tests/section-identity.spec.ts` 通过：注册的 id 为 `dsh-session-archive`，不再注册官方 `archived-sessions` id，order 保持 25，入口文案可解析，且每次挂载只取一次注册、卸载时释放。`tests/section-identity.spec.ts` 还会在已有一条外部 `archived-sessions`（缺省 priority）注册的情况下挂载本插件，断言两条入口并存；其替身注册表按外壳的规则拒绝重复的 `id` 与 `priority` 组合，并有一条 guard 证明换 `order` 也躲不开这次拒绝。

包级 `test`、`typecheck`、`build` 通过，`node scripts/aggregate.mjs --check` 无漂移。同一 profile 同时启用两个归档插件的真实 GUI 轮次不在本次变更范围内，留待 QA。
