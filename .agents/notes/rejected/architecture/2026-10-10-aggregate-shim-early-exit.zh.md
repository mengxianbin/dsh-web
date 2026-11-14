# Agent Note: Aggregate boot shim early exit (C1) — no provably safe early exit at a meaningful scale

Status: rejected — every provably safe early exit needs a shared hub contract change, and the measured upper bound stays below 0.1 ms per flush at realistic match counts

## Problem

每个 body mutation 批次（每个带 childList 变更的动画帧一个）都会让聚合包 boot shim 重扫 frame。`applyShims()`（`packages/dsh-web-all/src/client/index.ts:412`）先跑三条 `COLUMN_SHIMS` 的文档级查询（`:414-415`）、一次 `document.querySelector('[class*="sidebarCol"]')`（`:424`），再跑 `stampSemanticParts(frame)`（`:430`）——其中包含四次 frame 级 `querySelectorAll`（`:335-338`，composer 组里就含 `textarea[data-phase]` 与 `[contenteditable="true"]`）加三次 header/scrollport 查询（`:340-345`）。它的 `changed` 返回值在 `:482` 与订阅回调（`:506-509`）里都被丢弃。真实页面上的 CDP CPU profile 拟合显示 flush 成本与 frame 内匹配数成线性：斜率 2.615e-4 ms/match，截距 0.023 ms，R² 0.991（206 匹配 → 0.098 ms，806 → 0.213 ms，3206 → 0.868 ms）。因此重扫正是唯一可优化部分，每次 flush 值 slope × matches。

## Proposal (declined)

缓存「本 frame 已全部打标」，对没有新增待打标节点的批次跳过重扫。该提案有一条硬要求：在任何真实序列（新建 frame、frame 被 React 重建、批次中途移除节点、匹配数增长）下，DOM 上最终的属性集合必须保持等价。

## Evidence

**属性派生的匹配直接推翻了这个前提。** 共享 hub 只观察 `{ childList: true, subtree: true }`（`shared/client/body-mutations.ts:111`），shim 又走 invalidation-only 订阅路径（`:59-63`、`:47-52`），因此拿不到 `addedNodes`；更关键的是，一个**因为属性写入**才开始命中 shim 选择器的元素，对任何只处理 addedNodes 的增量遍历都是不可见的。在真实探针页面实测（Playwright 驱动系统 Chrome 连隔离宿主，脚本 `/tmp/dsh-perf-survey/client/c1-attr-probe.mjs`，原始输出 `/tmp/dsh-perf-survey/client/out/c1-attr-probe.json`）：

1. 插入一个不带 `data-phase` 的 `<textarea>` → flush → 未打标（此时还不是匹配）；
2. 对同一已存在节点设置 `data-phase="idle"`（仅属性变化）→ 该节点此刻已命中 composer 选择器，但连续五帧仍未打标 —— 属性批次根本到不了 hub；
3. 追加一个无关节点（childList）→ flush → 该 textarea 变成 `data-dsh-responsive-part="composer"`。

第 3 步之所以成立，正是因为这个批次重扫了整个 frame。若改成只遍历 `addedNodes` 的增量路径，该节点将永远不打标，最终属性集合与今天不同；`[contenteditable="true"]` 以及其他任何对已存在元素的 React 属性切换都属于同一形状。

拿到 `addedNodes` 的唯一途径是把 shim 切到 hub 的 records 路径（`subscribeBodyMutations`，`:66-72`）。这会让 `needsRecords`（`:47-52`）变为 true，于是 hub 为整页保留每一条 mutation record 与已分离子树（`:105-109`）—— 这是另外两个订阅者（dsh-usage、dsh-plugin-manager）共同承担的成本，且正好逆转该模块头部注释所记录的优化。即便如此，它仍覆盖不了属性派生的匹配。

让 hub 同时观察属性是完整修法，也是错误的取舍：那会让每一次 class/属性写入都产生一个回调批次（仅 mobile-adapt 就以 600 ms 周期切换 body class），即为至多 0.26 ms/flush 的收益换来一条按属性写入触发的事件流。

**规模核算**（slope × matches，每次 flush，且假设增量路径零成本的上界）：100 匹配 → 0.026 ms；300 → 0.079 ms；1000 → 0.262 ms —— 分别占 60 Hz 帧预算的 0.16%、0.47%、1.57%，也分别是 shim 自身 flush 成本的 53%、77%、92%。真实区间（一次会话的代码块加侧栏树项）约 100-300 匹配，即每个 flush 低于 0.1 ms；而真实流式期间的 childList flush 频率从未实测 —— 唯一测到的空闲频率 2.1 批次/秒全是属性批次，根本不会到达 hub。

被既有契约钉住的另一条更便宜的路也被排除：`packages/dsh-web-all/tests/responsive-contract.spec.ts:17` 要求新内容必须在同一帧内完成打标。

## Alternatives considered

- **records 路径 + addedNodes 增量打标**：否决 —— 会漏掉属性派生的匹配（上文实测），并且付出 hub 级记录保留的共享成本。
- **只缓存 frame 元素**（`ensureMobileDismiss` 已在用的 `resolvedFrame` 模式，`:480-486`）：安全，但只省下一次文档查询，四次 frame 级 `querySelectorAll`（即被实测的那部分成本）依然存在，收益不足。
- **合并/去抖重扫**：否决 —— 破坏 `responsive-contract.spec.ts:17` 钉住的同帧打标契约，且延迟打标会改变响应式 CSS 开始生效的时刻。
- **在 shim 里自建 frame 观察者**：否决 —— 重新引入了共享 hub 本来要消除的「每插件一个 body observer」。
- **收窄选择器作用域**（树项只扫侧栏 pane、composer/code 只扫会话 pane，而不是整个 frame）：唯一剩下的安全方向。它在不依赖任何 addedNodes 信号的前提下降低每次 flush 的常数，且最终属性集合不变。本轮不实现，因为它需要自己的一套 A/B 测量（同一 CDP 拟合口径）与真实浏览器的属性集合差异对照，属独立任务。
- **确定性守护「无新增节点 ⇒ 查询次数 O(1)」**：自我否定式方案 —— 这条断言恰好会把实测第 3 步证明有害的那次跳过固化成契约。

## Remaining uncertainty

- 真实会话的匹配数是从隔离宿主里的注入块外推的（无模型凭据）；1000 以上匹配需要超大侧栏加超长会话。
- 真实流式期间 childList 驱动的 flush 频率未测；唯一测到的是空闲期全为属性批次的 2.1 批次/秒。
- 属性派生路径是用注入节点演示的，不是真实回合。`textarea[data-phase]` 与 `[contenteditable="true"]` 都是可能存在的实时切换，一次真实回合即可定论。
- 斜率是在无布局的合成块上测的；更深的真实子树可能改变常数，不改变线性。
