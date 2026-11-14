# Agent Note: Session attention classification and one-time default pin

Status: implemented

## 问题

侧栏把「给人看的会话」和「bot 干活的会话」摆在同一套平铺排序里，人工置顶/取消全靠手点；而「这个会话为谁服务」从来没有被记下来过。taskbot 持续派发任务会话（用户 2026-10-29 裁定，m-note decision-log），每来一批，人的注意力面就被新 bot 工作压下去一截；宿主启动时也没有任何 pass 能把它捞回来——派发从不声明发起方，快账不存出身，注册表不存分类。

## 决策

- **`POST /api/session-dispatch` 新增可选字段 `sessionClass: 'human' | 'bot'`**（`parseDispatchBody` 校验；缺省即 `human`）。缺省方向朝注意力兜底：调用方忘了传字段，得到的是被置顶的会话，而不是被埋掉的会话。
- **新增 host 模块 `src/host/attention.ts`**——`AttentionLedger` 落 `$DSH_HOME/session-attention.json`（临时文件 + fsync + rename 原子写，损坏文件隔离为 `<path>.corrupt-<epoch>` 后重建，与旁边的快账账本同形）。记录以规范 id 为键，字段为 `{ class, defaultApplied, source, updatedAt }`。
- **每会话只套一次默认**，由同一内部队列上的三个触发器串行完成：**启动 pass**（当期工作区成员中无记录者 → 按 `human` 分类并置顶；`defaultApplied: false` 的记录 → 按其记录的分类重试）、**派发声明**（`declare` 在创建之后、首条提示词之前执行，`bot` 声明不可能输给首条消息的竞态）、**首条真人用户消息**（`session/event` 中 `type === 'user/message'` 且 `data.source.kind === 'user'`）兜底覆盖运行中 UI 新建的会话。一旦 `defaultApplied: true`，任何代码路径都不再改这个会话的置顶——人工置顶/取消跨重启永久有效（用户裁定 A，2026-10-29）。
- **分类规则**（用户裁定 A，2026-10-29）：人工派发的任务会话 = `human`；bot 值班会话（轮换新班、看门狗接管班）= `human`；bot 派发的任务会话 = `bot`；无声明者（UI 新建、或早于本账本的存量）= `human`。
- **工作区成员门**：只对「在某个工作区 `sessionIds` 中且不在 `archivedSessionIds` 中」的会话记录与置顶（子代理子会话、侧线程、分叉从不入成员表，天然出局）。置顶用工作区列出的 id 拼写——那正是客户端拿去和 `pinnedSessionIds` 匹配的行 id。
- **`src/index.ts` 接线**：以 `workspaceRegistry` 的结构化视图构造账本（与 `sessionController` 同款 cast 惯例），启动 pass 在任何路由可服务前入队，派发路由注入 `attention`，`session/event` 订阅跑首条消息兜底。账本写入失败回报 `attentionRecorded: false`（与 `bindingRecorded: false` 并列），绝不让派发本身失败。

## 备选方案

- **harness fork patch（出身进 workspace registry 状态、bootstrap 套默认）**：否决。所需能力——枚举成员、pin/unpin、观察会话事件——本插件全都能摸到；改宿主多出 fork patch 治理、前端/宿主重建，却换不来任何额外能力，registry schema 继续归上游所有。
- **每次宿主启动都重套默认**：否决。重启会覆盖人工置顶改动；用户裁定明确选了「每会话一次、人工改动跨重启存活」。
- **记「人工已动过」标记、只跳过人工碰过的会话**：否决——多余状态外加归因竞态（最近一次置顶集变化是我改的还是人改的？）。一次性套用让这个问题根本不存在。
- **挂载即分类（创建就置顶）**：否决。空白/从未有过消息的占位行会立刻被置顶，放大幽灵行杂乱；首条真人消息触发器保证有内容才置顶，`defaultApplied: false` 的记录留给启动 pass 或后续消息落定。

## 后果

- 分类只活在 sidecar 里；文件丢失时下一次启动 pass 降级按 `human` 处理（朝置顶方向兜底），永不崩溃。
- 插件无法替 bot 拉起的会话推断「值班还是任务」：由派发方声明。约定落在调用侧（m-note 的 `dsh-session-dispatch`、`taskbot` skill 与 guard 脚本）：任务派发 → `bot`，轮换/接管 → `human`，人工发起的派发 → 省略或 `human`。
- 升级后首次启动会把所有无声明的存量成员都置顶（包括早于账本的在跑 bot 任务会话——手点取消一次即可，且不会再被置顶回来）。
- 无任何 UI 面展示分类；效果只体现在置顶排序上。
- 死掉或从未有过消息的 `defaultApplied: false` 记录每次启动廉价重试（一次被拒的 pin，无变化不写盘）。

## 测试

`tests/attention.spec.ts`（16 例）覆盖文档解析器、启动 pass（human 默认、跳过归档、按列出拼写置顶、pending 记录重试、pin 失败保持 pending、损坏文件隔离）、跨账本重启的每会话一次保证、`declare`（human/bot/账本写失败拒绝）与 `ensureFirstMessage`（human 兜底、非成员门、已套用记录不动）。`tests/routes.spec.ts` 新增 5 例：`sessionClass` 校验、线上缺省 `human`、`bot` 声明先于 prompt 的顺序、账本失败回报 `attentionRecorded: false`、未挂 attention 服务的形态。包级 typecheck、`vitest`（83/83）、`tsdown` 构建全过；`verify-docs.mjs --write` 重录 README 双语对（2026-10-29）。
