# Agent Note: Sysmon chip 兜底座位——conversation header leading 单元格

Status: implemented

## Problem

sysmon chip 只坐在 `conversation.session.header.actions`，而这个 session 级槽
只在「有会话且非空白、头部 chrome 可见」时才渲染。两种状态完全没有读数：无会话
（头部只渲染 `headerLeading` 和空 title 行，session header 槽根本不挂载）和空会话
（`hideChrome` 把整个 title 簇连同动作行一起丢掉）。用户在会话整理期盯机器健康——
恰恰是啥都没跑的时候——反而在最需要的时刻丢了 chip。

## Decision

把同一枚 chip 体坐进第二个 root 级位置：`conversation.header.leading`——无会话时
仍渲染、空会话隐藏动作行时仍可见的头部单元格。两个座位共享一个模块级挂载信号
（`src/client/presence.ts`）：主位副本用 `useLayoutEffect` 上报挂载，兜底位订阅该
信号、只要主位副本存在就返回 null，因此任何时刻只画一份，两者都会挂载时动作行
座位优先。挂载上报放在 layout 阶段，让交接落在同一个 commit 内——被动 effect 的
信号会让会话打开时闪一帧双份。

信号是挂载计数而非布尔值，React StrictMode 的双调用 effect 无法把它卡死。每个座位
保留各自的轮询循环和各自的 404 隐藏契约；宿主半区关闭时两位各自独立隐藏，两种状态
都不需要设置界面。

## Constraints

- 不改 harness：该座位是 harness 已声明、已在每种头部状态下渲染的 root 级槽，
  插件像其他占用者一样注册进去即可。
- 固定的 SDK cohort（`dsh-client-ui-conversation` ^0.1.2-rc.1）的 `SlotMap` 早于
  该槽，因此 client 入口带一个类型垫片，逐字镜像 harness 声明。仓库 cohort 追上后
  该垫片即删，注释已标明。
- 兜底副本落在 `.titleRow` 之外，chip 的 `@container` 让位阶梯（620px 掉单位标签、
  440px 整条隐藏）对它不生效；该单元格改由头部自身布局管。

## Alternatives considered

**在 harness 里加一个恒显 root 座位（所有状态单一位置）。** 因成本否决：它改核心
头部布局加 snapshot/e2e 套件还要重建 harness，而两座位方案已经提供了同样的可见性
保证。接受的代价是 chip 跨状态会移动（无会话在左边缘、有会话在 preset 标签旁），
README 已记录为已知限制。

**只注册兜底座位、砍掉动作行座位。** 否决：这会把常见场景的 chip 从四案裁定选中的
座位（「会话头部【标准模式】右侧空白」）挪走，去修一个角落场景。

**用 DOM 探测主位可见性代替信号。** 否决：轮询/observer 是 hack——挂载生命周期本
就在同一棵 React 树里跑，模块级信号精确、同步、零 observer 开销。

**等 SDK cohort 升级继承 harness 侧互斥。** 没有这样的 harness 行为可供继承——
互斥本来就是插件本地设计——等一个不存在且未列入计划的东西。

## Consequences

- chip 现在三种头部状态都可见；空会话与无会话屏上它出现在头部 leading 边缘。
- 会话开/关时两座位在同一个 commit 内交接；会话切换瞬时会挂载两棵 React 子树
  （最多一次轮询重叠），随后兜底位归于 null。
- `tests/sysmon-seats.spec.tsx` 钉住两种挂载顺序下的互斥、主位卸载时的交接、以及
  presence 计数器的订阅/退订契约（包级 45 测试全绿）。
- README 双语、包级 AGENTS.md 与本笔记描述两座位安排；类型垫片是下次 SDK cohort
  升级时唯一需要复审的部分。
