# Agent Note: 用量套餐窗口条的色调类保留填充几何

Status: implemented

## Problem

个人套餐页签把每个配额窗口渲染为轨道（`bar`）加一条内层填充 span，其宽度即已用百分比。填充的类名来自 `toneClass(percent)`，原实现只返回一个类：低于 70% 返回 `barFill`，70-89% 返回 `barWarn`，90% 及以上返回 `barLow`。而 `barWarn` 与 `barLow` 只声明 `background`；让 span 可见的几何属性（`height: 100%`、`border-radius`、`transition`）只在 `barFill` 上。于是 70% 以上时空的行内 span 没有高度、塌陷为零，该行只剩轨道和百分比文字、没有填充——重度使用账户的每月窗口（75%+）必然命中，而 70% 以下的 5 小时与每周窗口显示正常，缺陷因此看起来时隐时现。

## Decision

`toneClass` 现在始终返回 `barFill` 并追加色调类（`barFill barWarn`、`barFill barLow`），使每个档位都保留几何类。CSS 保持原样：`barWarn`/`barLow` 仍是纯背景覆盖，且因在 `usage.module.css` 中排在 `barFill` 之后，同特异性下由它们赢得 `background` 级联。回归测试在 12.5%、75%、95% 三档断言填充 span 的精确类名顺序（对照 CSS 模块对象），因此未来任何丢失几何的色调类、或改变背景胜出顺序的重排，都会让套件变红。

## Alternatives considered

- **在 CSS 里给 `barWarn`/`barLow` 各自补 `height: 100%`（及圆角/过渡）。** 否决：几何声明变三份，且下一个同样「只加背景」的色调类会再次无声引入本缺陷。几何只放一个类、色调类保持纯覆盖，不变量才可机械陈述。
- **用修饰用的自定义属性把色调色并进 `barFill`。** 否决：为一个渲染缺陷重写整套样式表，且除类名断言已锁定的契约外没有任何测试可见的契约变化。
- **改为夹取或归一化 `percent`。** 否决：宽度本来就是对的，缺陷纯粹是缺几何类，动数值处理什么也修不好。

## Consequences

70% 及以上的窗口重新渲染出填充（70-99% 琥珀色、90%+ 红色，几何不变）。色调档位下填充 span 现在固定携带两个类；若有皮肤或消费方选择器依赖「填充上只有一个类」则需跟进，但该表面锚定的是 `data-dsh-part="plan-window"`，皮肤锚定它而非填充的类列表。

## Testing

- `pnpm --filter @linxin666/dsh-usage test`：7 个文件、85 个测试全通过，含新增的三档断言。
- 新断言在修复前的 `toneClass` 上会失败（已用 stash 验证：3 档中 2 档失败），修复后通过。
- `pnpm --filter @linxin666/dsh-web-all build` 重新生成受版本管理的聚合客户端 bundle 并携带修复；`packages/dsh-web-all/lib/client.js` 中的 `toneClass` 可见双类返回。
