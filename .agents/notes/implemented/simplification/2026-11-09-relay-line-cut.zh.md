# Agent Note: Session revive relay line cut

Status: implemented

## Problem

`dsh-session-revive` 首批预留了 relay 线：`RevivalPolicy.bindRelay` 会把接力会话绑到源会话的额度链上，让新开的身体不能刷新旧会话的额度罐（设计 §4.2「relay 计入同一预算链」）。它出厂即未接线——`relayOf` 从没被写入、`bindRelay` 从没被调用——而 README 一直承诺 bot 的 relay 分支随 relay 线落地。2026-11-09 接力体制裁定（m-note ask 回执 id `q-bot`，「砍判据留兜底」）判这条线永不实现：300k 压缩闸之后接力的钱收益已削到日账 3-5% 且持续衰减，bot 交接走本插件之外的 taskbot 第四信号兜底（nudge 优先）。

## Decision

从包里移除预留的 relay 线。`RevivalPolicy` 删掉 `relayOf` 映射、`bindRelay` 与 `chainIdOf`；额度链坍缩到会话 id（`chainId` 保留为记录与快照的字段名，恒等于会话 id）。`forget` 无条件删除会话自己的额度罐，因为链随会话。波释放测试改为填被挂起会话自己的罐，不再借源链；`reserved relay chain field` describe 块随能力一并移除。README 已知限制行改为当前契约：本插件从不把停靠的会话接力到新会话。上下文水位闸未被本砍单触及（当时为 150k；2026-11-13 由 [水位抬升](../feature/2026-11-13-session-revive-watermark-300k.md) 抬到 300k）——被砍的只有 150k 选路分界与 relay 线。

## Alternatives considered

- 留占位加墓碑注（「已砍 2026-11-09」）：否决——`bindRelay` 会继续作为一个可调用方法存在，能把两个会话的额度链静默合并，测试也会继续为已不存在的能力作证。
- 保留 `chainIdOf` 作恒等函数：否决——残留间接层；内联后额度代码更诚实，字段词汇留在记录上即可。

## Consequences

- 行为零变化：生产从未写过 `relayOf`，三门证明的是等价而不是新路径。
- m-note 侧承载裁定：`content/tech/ai/dsh/session-auto-revival-design-1102.md` §二与 §4.2 加改判随注，裁定档 = `content/tech/ai/dsh/relay-regime-1109.md`，板行 = `content/tech/ai/dsh/tasks.md#revive-relay-line-cut-1109`（均主树）。
- [session-revive](../feature/2026-11-03-session-revive.md) 的裁定原样保留，同批只更新其中 relay 相关事实。
- 运行中的 dsh web 在用户亲手重启前继续服务旧 bundle；未碰任何会话生命周期 API。

## Testing

包内 `pnpm typecheck`、`pnpm test`（65 例）、`pnpm build` 全绿；README 双语同改后 `pnpm docs:check`、`pnpm i18n:check` 全绿。没有任何用例触碰真实会话生命周期。
