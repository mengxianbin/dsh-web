# Agent Note: dsh-session-revive boot sweep 列表绑定解包 SessionListValue 信封

Status: implemented

## Problem

[boot sweep](../feature/2026-11-08-session-revive-boot-sweep.md) 上线时，列表绑定把 `sessionController.list()` 声明成返回裸行数组，但 Host 方法实际返回 `SessionListValue`——行包在 `{ items }` 里。绑定经 `as unknown as` 结构断言接入扫描器，TypeScript 从未真正比对两侧形状；单测又直接以裸数组注入 `listRows`，没有一条测试越过绑定层。于是 Host 重启后的首次真实激活（2026-11-08 启动 11:01:42、失败行 11:02:04）在第一个 `for...of` 处以 `TypeError: rows is not iterable` 当场失败，落一条 stage `sweep` 的 `boot-sweep-failed` 行，扫描会话数为零——失败即关闭（fail-closed），没有误叫醒任何会话、没有造成损害，但重启复活功能在它专为而建的那次重启上静默失效。

## Decision

- **信封在消费处如实声明。** `src/sweep.ts` 的 `SweepListApi` 把 `list()` 类型定为 `Promise<{ items: readonly SweepRow[] }>`——Host 实际返回的形状——而不是靠断言才能编译的裸数组承诺。
- **解包只此一处且被测。** `makeListRows(controller)` 同时持有裁定过的行域请求（`includeArchived: false`、`trimHeavyProjections: true`）与 `.items` 解包；`src/index.ts` 只剩 `listRows: makeListRows(...)` 一行绑定，不再自声明列表视图。绑定缝变成测试可直接驱动的纯函数。
- **回归测试打在绑定层本身。** `tests/sweep.spec.ts` 三例：信封解包出行、请求携带两个裁定开关、经 `makeListRows` 以信封形状的控制器驱动 `runBootSweep` 全程零 `boot-sweep-failed`。

## Testing

包级 `pnpm typecheck` 绿、`pnpm test` 65 例全过（原 62 + 新 3）、`pnpm build` 绿（`lib/index.js` 2026-11-08 重建）。端到端一例复现生产失败形状：返回 `{ items: [...] }` 的控制器必须走到 `decide` 而不出失败行——修复前的绑定面对同样输入正是 `rows is not iterable`。

## Alternatives considered

- **只改类型声明、解包仍内联在 `index.ts`**：否——原缺陷的要害恰是绑定层落在测试面之外；把逻辑挪到导出的纯函数后面，回归测试才可能存在。
- **在 `runBootSweep` 里两种形状都收（数组探测）**：否——双形状会让未来信封再变时静默漂移而非响亮失败，而响亮的 fail-closed 行正是本包契约；一个诚实形状加一条钉死的测试胜过运行时猜测。
- **改用已安装的 `@deepseek-ai/dsh-api-session-controller` SDK 类型而非结构视图**：否——已安装 SDK 落后于运行中的 Host（其 `SessionSummary` 缺 `agentAvailable`，而扫描器要读它），SDK 类型会错描这台 Host；按观测到的线形状做结构视图是本包既有惯例（`ReviveSessionApi`、dispatch 的 `DispatchSessionApi`）。

## Consequences

- 修复要到下一次重启才抵达运行中的 Host（link 安装在激活时加载 `lib/index.js`）；重启恒归人，因此重启后判据保持为「无 stage `sweep` 的 `boot-sweep-failed`，且 `boot-sweep` 汇总的 `rows` 非零」。
- 若 Host 将来再改列表信封，编译期仍拦不住（结构断言按惯例保留），但钉死的测试记录了期望形状，任何运行时失配依旧失败即关闭、响亮留痕，而不是半工作。
- 扫描器其余接缝（`sessionPersistence.open/read/close`、`agents.get`、`prompt`）在同一次核查中对照 Host 源码逐一对上，声明无误；`{ items }` 信封是唯一的错配。
