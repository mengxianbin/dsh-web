# Agent Note: 梁神预设把人类 /goal 命令与目标工具一起挂载

Status: implemented

本笔记拥有梁神预设 composition 的目标段（`packages/dsh-liangshen/presets/liangshen/agent.cordis.yml`），以及固定该结构回归的 `packages/dsh-liangshen/tests/preset-composition.test.ts`。这些行消费的宿主侧目标域属于 dsh 自身的目标包，不属于本仓库。

## Problem

issue #1961：梁神会话没有 `/goal` 命令。该预设的目标段只声明了模型侧 `tool-goal` 行，注释还断言 `/goal` 命令留在宿主平面。这个断言与宿主 composition 相反：Web bundle 把目标服务与目标轮次驱动器留在宿主，同时禁用 base 的命令生产者、把它交给 agent 预设，dsh 自己的 `dsh-command-goal` 文档也用一句话写明——standard、ptc、cordis 预设挂载该生产者，minimal 不挂。那三个预设都在 `tool-goal` 之前声明一条顶层 `command-goal` 行，name 为 `@deepseek-ai/dsh-command-goal`。于是梁神交付了同一个目标域的模型面，却没有它的人类面，而注释用一个与 bundle 相反的事实解释了这处缺口。

## Decision

1. `packages/dsh-liangshen/presets/liangshen/agent.cordis.yml` 的目标段把该域的两个消费方声明为两条普通顶层行：`- id: command-goal`（`name: '@deepseek-ai/dsh-command-goal'`），以及原有的 `- id: tool-goal`（`name: '@deepseek-ai/dsh-tool-goal'`）。两条都不带 realm，与内置预设一致：命令行消费宿主的 `commands` 服务与宿主目标服务，entry-local realm 会把它们藏起来。
2. 该段注释按现状陈述分工：目标服务与其 session driver 留在宿主平面，命令与工具由预设挂载。
3. `packages/dsh-liangshen/tests/preset-composition.test.ts` 通过预设自己的 composition reader 结构性固定这一对：恰有一条顶层 `command-goal` 行且 name 为 `@deepseek-ai/dsh-command-goal`、`tool-goal` 行仍在、文件里只出现一次该命令声明、没有任何组内副本，另加一条非空洞检查——删掉该行后守卫会把行读成缺席。

## Alternatives considered

- **按被删掉的注释那样，让宿主挂载命令生产者。** 否决：Web bundle 禁用 base 生产者正是为了让预设拥有它，因此省略该行的预设所跑的会话根本没有 `/goal` 命令——即本次报告的缺陷。
- **把两条行一起放进带 entry-local realm 的组。** 否决：内置 standard、ptc、cordis 预设都把它们声明在顶层，而本文件头部把 realm 留给预设自己发布的 service；这两行消费宿主服务，realm 会藏掉 `goals` 与 `commands`，两条都注册不上。
- **加 `command-goal` 并去掉 `tool-goal`，与 minimal 预设对齐。** 否决：issue 要求补上人类命令同时保留已有的目标工具，而驱动器靠模型自己的 `update_goal` 结算会话，删掉工具行等于把它拿掉。

## Consequences

梁神会话用与内置预设相同的那一行提供 `/goal`，因此创建、编辑、暂停、恢复、清除与查看都在 composer 里完成、不消耗模型回合，`update_goal` 也照旧可用。预设不再带着一条与宿主 composition 相反的注释。其他都不动：该行与早已如此声明的 `tool-goal` 一样，解析宿主自己安装的那份副本，因此没有包依赖或锁文件条目变化。

## Testing

在 `packages/dsh-liangshen` 下执行 `npx vitest run tests/preset-composition.test.ts`：13 项通过，包含新增的目标段场景，以及解析这份已改动文件的既有 composition 合法性场景。
