# Agent Note: LiangShen row ships enabled in the aggregate

Status: implemented

## Problem

聚合包对低频家族插件出厂默认关闭：`packages/dsh-web-all/aggregate.yml` 用 `inactive:` 列出行的 id，生成器为每一行渲染尾部的 `disabled: true` 覆盖，因此新装环境既不加载该行，也不显示它的设置入口（`web-ui-liangshen` 自 2026-09-09 起与 SSH、skill-explorer 同在该清单里）。

对 liangshen 而言，缺失不是观感问题而是整体消失：该行的宿主半区负责把内置的梁神 preset 声明给 agent preset 注册表，而首页拨杆正是从该注册表读取名册与选中状态；行被停用意味着新会话没有梁神模式，拨杆也没有可切换的对象。梁神模式是本部署面向新会话的常驻入口，因此新装环境必须就在位，而不必先绕道 设置 → 插件 → 插件管理。

## Decision

`web-ui-liangshen` 不在 `inactive:` 清单内，生成的 patch 不再带它的 `disabled: true` 覆盖：新装聚合环境加载该行，宿主半区在激活时声明 `liangshen` preset，首页拨杆在空白会话即在位。SSH 与 skill-explorer 保持按需开启的默认。

停用路径不变。用户关闭该行时写入显式的用户层 `disabled: true`，优先于包内默认；插件管理器按「用户行，其次包内默认，最后启用」合成生效状态（[effective-enablement 修复](../../implemented/bug-fix/2026-09-10-plugin-manager-effective-enablement.md)），开关仍与下次启动实际加载的内容一致。

## Testing

`node scripts/aggregate.mjs` 重新生成 `cordis.patch.yml` 且不再带该覆盖，`node scripts/aggregate.mjs --check` 报告无漂移，`scripts/aggregate.test.mjs` 仍断言 `inactive` 清单里剩余的行各自带覆盖。`pnpm docs:check` 与 `pnpm i18n:check` 在更新后的聚合 README 配对与架构图下通过。

## Alternatives considered

- 保持默认关闭，另做引导提示。否决：为单行引入新的宿主路由与面板，且该模式应当从第一次会话起就在位，而不是被推荐。
- 用 `patches:` 的播种配置表达该默认。否决：该段改写的是行的 config，而不是 loader 是否挂载该行，preset 依旧不会被声明。
- 首个空白会话打开时惰性启用该行。否决：行未加载时拨杆无法渲染，触发点没有落点；未经用户操作写入用户层，也会让产品默认看起来像用户的选择。

## Consequences

- 新装聚合环境多加载一行（宿主与浏览器半区各一份）与一张设置卡。
- 从未动过该行的既有安装跟随包内默认，模式随之出现；显式停用过它的安装保持关闭。
- 独立安装 `@linxin666/dsh-liangshen` 不受影响，聚合行 id `web-ui-liangshen` 逐字不变。
