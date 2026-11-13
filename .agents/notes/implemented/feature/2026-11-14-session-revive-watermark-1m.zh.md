# Agent Note: dsh-session-revive 把上下文水位闸从 300k 抬到 1M

Status: implemented

## Problem

2026-11-13 的抬闸把水位从 150k 抬到 300k、落在压缩阈值上，但 300k 依然会停靠压缩器处理得动的会话。2026-11-13 23:56 的 boot sweep 以 `context-limit` 跳过了 `session-b7496aad`，`contextTokens: 312397`，而它的 surface 只有约 194.6k；该会话一直死到 00:02 人工 attach 才醒，醒来后一次压缩就把它压到 76.5k surface / 116.5k 压力。压力口径（`inputTokens + cacheReadTokens`）系统性地比 surface 高约 1.6 倍，所以任何真正干活的会话都会在 surface 到达压缩线之前很久就越过 300k 压力——这道闸停靠的是本可叫醒的会话，把它们排进人工 `continue` 队列，正是上一次抬闸要消灭的失败形态（用户裁定：「把复活闸调到 1M 吧」）。

## Decision

- **`CONTEXT_LIMIT_TOKENS` 从 300_000 移到 1_000_000**（`src/config.ts:89`），即整个上下文窗口。闸的语义不变——达到或超过该线即零消耗停靠，低于该线其余闸照常裁决——但落在窗口边缘后，停靠只拦真正装不下下一个请求的上下文，压缩器处理得动的会话全部自动叫醒。
- **这依然是 §四 中唯一移动的裁定参数。** 常量上的 JSDoc 记录了本次裁定（2026-11-14）与该线的历史（150k → 300k → 1M）；其余 §四 数字（4h × 4 额度、10 分钟断路器、波窗/冷却、错峰地板）全部未动，水位保持不可配置的可 grep 字面量。
- **一个常量、两处检查点**：boot sweep（`src/policy.ts:436`）与错误路径（`src/policy.ts:690`）同读 `CONTEXT_LIMIT_TOKENS`，一处改动两处生效——重启复活与错误复活之间没有行为分叉。
- **文档与测试随值走**：README 双语与 `package.json` description 都写 1M，README 配对哈希重录，水位测试继续从 `CONTEXT_LIMIT_TOKENS` 派生边界——下次改值只动一行。
- **m-note 设计档承载裁定**：`content/tech/ai/dsh/session-auto-revival-design-1102.md` §4.2 同批写入 2026-11-14 改判随注；本改动是同一裁定的 dsh-web 半边。

## Alternatives considered

- **维持 300k 线**：否决——压力与 surface 的口径差（触发会话实测约 1.6 倍）意味着 300k 压力会停靠 surface 远低于压缩线的会话；312,397 token 那次跳过正是 2026-11-13 抬闸要清空的「可叫醒孤儿队列」。
- **整条删掉水位闸**：裁定否决——把字面量保留在窗口边缘，用一个常量的代价换来对真正满上下文的零成本 fail-safe，且改动更小。
- **把水位做成可配置**：否决——§四 裁定参数按设计就是固定字面量（仅两份码表是可配置面）；旋钮会把裁定变成偏好、招致漂移。
- **取 300k 与 1M 之间的值（如实测压力带）**：否决——任何中间值都只是把同一个判断题挪到新数字上；用户裁定选窗口边缘，那是唯一不需要随压力/surface 比率变化而重调的值。

## Consequences

- 达到或超过 1M 压力的会话停靠；实践中停靠不再触发（300k 处的压缩把会话压得离窗口很远），boot sweep 应当彻底不再产出 `context-limit` 跳过。
- 生效需用户重启 dsh web 宿主：插件 `lib/` 已重建，但运行中的宿主在重启前一直持有旧 bundle——按仓规重启恒归人，AI 从不发起。
- 其余闸（额度、断路器、波、错峰）与零消耗停靠契约不变；status 端点与日志行形状不变，无消费方破坏。
- 重启后行为判据：boot sweep 的 `context-limit` 跳过数为 0，任何残留停靠必须带 `contextTokens ≥ 1000000`。

## Testing

包级门：`pnpm typecheck`、`pnpm test`（65 通过——水位用例断言 `CONTEXT_LIMIT_TOKENS`：贴线停靠、低 1 token 复活、缩容解除停靠）、`pnpm build`。仓级 `docs:check` / `i18n:check` 覆盖本批触及的 README 配对与 note 三件套。没有测试触碰真实会话生命周期，沙箱规则未被触发。
