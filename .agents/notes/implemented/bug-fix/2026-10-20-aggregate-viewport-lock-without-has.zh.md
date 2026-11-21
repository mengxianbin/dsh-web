# Agent Note: 聚合包 compat 样式表的根视口锁不再使用 :has()

Status: implemented

## Problem

聚合包 compat 样式表用两条以 `:has()` 定作用域的规则锁住滚动根：

```css
html:has([data-dsh-frame]),
html:has([data-dsh-frame]) > body { height: 100%; width: 100%; overflow: hidden; }
```

`:has()` 会对每一个发生样式失效的节点的整条祖先链求值，直到根元素。因此任何一次
大规模同步 DOM 重建都要为每个插入的节点付一次代价，且代价随**页面总节点数**增长，
而不是随匹配数增长。可见症状出在使用 xterm 的终端插件上：改一次 `fontSize` 会重建
行元素，重建本身很便宜，但 compat 样式表把它变成多帧卡顿，且只在安装了聚合包时出现
（issue #1913）。

issue 把成本归因到共享的 body `MutationObserver` hub
（`shared/client/body-mutations.ts`）。这一归因不成立：hub 的每一个消费者都通过
`subscribeBodyInvalidations` 订阅，因此 `needsRecords` 恒为 false，
`MutationRecord` 从不被保留，hub 自己的回调只是一个安排一帧的空操作。

## Decision

- **视口锁以根属性定作用域，不再用 `:has()`。** 样式表改为
  `html[data-dsh-frame-active]`（以及
  `html[data-dsh-frame-active] > body`），这是普通属性选择器，每次样式失效只花一次匹配。
- **该属性由 shim 在它本来就会跑的那一趟里维护。** `applyShims()` 在打完帧之后调用
  `syncFrameLock(frame !== null)`，因此属性只在帧被打上时存在；React 重建 shell、
  下一趟找不到帧时属性被清除。锁不会比它所锁的帧活得更久。
- **`applyShimsForTest()` 作为测试接缝导出**，让 spec 不必等 hub 的动画帧就能断言
  单趟扫描的效果。生产代码仍然只经 hub 触达这一趟。

## Evidence

在一个 shell 形状的页面上量测（1500 条 `role=treeitem` 侧栏行加代码块，共 108,009
个节点），用真实 `@xterm/xterm` 5.5.0 在 Chromium 中改 `fontSize`，两个已提交的聚合
bundle 各交替跑三轮，避免漂移偏心：

| Bundle | 修法 | `fontSize` 赋值（同步） | 稳定后 |
| --- | --- | --- | --- |
| `origin/main` | `:has()` 根锁 | 17.0 / 17.0 / 16.6 ms | 58.3 / 59.9 / 55.7 ms |
| 本次改动 | `html[data-dsh-frame-active]` | 13.3 / 13.1 / 13.2 ms | 27.0 / 26.9 / 27.1 ms |

两种情况下锁都仍在：`getComputedStyle(document.documentElement)` 与
`getComputedStyle(document.body)` 都报告 `overflow: hidden`，帧也都打上了。

只去掉那两条 `:has()` 规则、其余样式表原样保留，复现出同样的恢复（稳定耗时 48.0 ms
降到 22.7 ms）；而改成去掉移动端 `@media` 块则没有变化（50.5 ms），由此把那两条根
规则单独锁定为全部成本。

两种作用域随节点数的伸缩，同一套 harness，每个规模跑一次：

| 页面节点数 | `:has()` 稳定耗时 | 属性稳定耗时 |
| --- | --- | --- |
| 22.5k | 12.3 ms | 12.5 ms |
| 64.5k | 31.5 ms | 13.1 ms |
| 127.5k | 58.1 ms | 24.2 ms |

只有 `:has()` 变体随页面规模增长；属性变体跟随的是终端自身重建的成本。

## Alternatives considered

- **收窄 `MutationObserver` 作用域或去掉 hub。** 依证据否决：同一套 harness 在保留
  观察器且 shim 照常运行的情况下没有可测差异（无观察器 2.4 ms / 12.5 ms；hub 加一趟
  shim 2.2 ms / 12.5 ms；hub 加八趟 2.3 ms / 12.6 ms）。issue 提议的修法不会挪动这个数字。
- **保留 `:has()` 但改挂到更小的祖先上。** 否决：失效路径上只要有 `:has()`，祖先链
  遍历就还在，而这条规则必须锚在根上才能锁住文档滚动。
- **去掉视口锁。** 否决：这把锁正是 issue #1135 的修法（被聚焦的折叠控件会把整页向下
  滚）。属性方案保留锁，只去掉它的成本。
- **收窄 `stampSemanticParts` 那四趟全帧 `querySelectorAll`。** 实测 13.5k / 45k /
  108k 节点分别为每趟 0.7 / 2.6 / 6.0 ms，确实存在但比 `:has()` 的成本低一个量级，
  且收窄它们要重做每一个 DOM 挂载插件都依赖的 compat shim。本次未纳入；用谓词等价的
  单趟 `TreeWalker` 实测**更慢**（1.4 / 5.0 / 14.0 ms），所以扫描形状不是这里的杠杆。
- **在 body 上观察 `attributes` 以响应式维护属性。** 否决：帧可能变化时 shim 本来就会
  跑一趟，再加一个属性观察器正是共享 hub 存在的目的所要消除的每插件 body 观察器。

## Consequences

- 安装了聚合包时，终端式的 DOM 重建不再随页面节点数放大。剩下的成本是 shim 自身每帧
  的扫描，与 issue 报告的数据无关。
- 锁现在跟随一个由 shim 维护的属性，而不是一个 DOM 事实。自行打上 `data-dsh-frame`、
  不经过 shim 的页面不再获得这把锁；仓库里没有这样的代码（帧只在 `applyShims` 里打）。
- 样式表仍保留一条用于折叠栏设置弹窗的 `:has()` 规则（#1510）。它锚在弹窗子树而不是
  根上，本次改动不涉及它。

## Testing

- `packages/dsh-web-all/tests/responsive-contract.spec.ts` 断言锁的作用域是
  `html[data-dsh-frame-active] > body`，且样式表里不含 `:has([data-dsh-frame])`；
  新增一例先挂上帧，再把 shell 换成不含帧的 body，断言根属性被清除。
- 门禁：`pnpm typecheck`、`pnpm test`、`pnpm test:standards`、`pnpm docs:check`、
  `pnpm i18n:check`、`pnpm aggregate:check`、`pnpm libs:check`。
