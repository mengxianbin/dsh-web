# Agent Note: OpenCode Go 配额窗口在 percent 0 时保留 resetsAt

Status: implemented

## Problem

OpenCode Go 适配器此前在配额窗口 `percent === 0` 时丢弃 `resetsAt`，理由是 0% 窗口的重置时刻只是占位值（now + 窗口长度）。上游端点的实际行为与此相反：刚重置的窗口仍携带真实的下一次重置时刻（2026-10-17 对 `https://opencode.ai/zen/go/v1/usage` 实测：percent 0 的 monthly 报告 `2026-11-17T10:29:32Z`，恰好一个月后）。字段被丢弃后，所有从重置时刻推导周期位置的下游消费者在整个新周期内都是空白。dsh web 侧栏的套餐用量 glance 正好命中：月周期刚重置，天数进度条渲染成 `— / —` 加空轨道，因为 glance 从窗口的 `resetsAt` 推导已过/总天数，而那里没有任何可推导的数据。

## Decision

适配器现在无条件透传 `resetsAt`（`toIso(row.resetsAt)`），percent 0 也包含在内。重置时刻是提供方报告的数据；它是否有用由消费者决定。`toIso` 已将缺失或不可解析的值归一为 `undefined`，确实不带重置的窗口的降级行为与之前一致。

## Alternatives considered

- **保留丢弃，让 glance 侧合成一个时刻兜底。** 否决：这等于伪造提供方本就报告了的数据，且合成值（now + 窗口长度）会与真实重置边界漂移。
- **保留丢弃，接受 percent 0 时天数条空白。** 否决：新周期恰恰是「剩余天数」读数最重要的时候，且上游给的是真值不是占位。

## Consequences

新重置（0%）的窗口现在把重置时刻带进 overview 文档。展示重置倒计时或周期天数条的消费者在重置后立即正确渲染。若有消费者依赖「percent 0 时 resetsAt 缺失」这一信号，需要相应更新——本仓库内不存在这样的消费者：overview 路由是唯一导出方。

## Testing

- `pnpm --filter @linxin666/dsh-usage test`：7 个文件、85 例通过，含重写后的 opencode-go 解析用例——现在断言 percent-0 窗口保留其 `resetsAt`。
- 重写后的断言在修复前的适配器上会失败（旧实现对该窗口期望 `resetsAt: undefined`），修复后通过。
