# Agent Note: OpenCode Go 计划探针改读 console go/status 绝对计量表

Status: implemented

## Problem

OpenCode Go 计划适配器此前探针 `https://opencode.ai/zen/go/v1/usage`，该端点每窗只报 `percent` 与 `resetsAt`。绝对水位——某个池子已消耗多少美元、限额多少——在该端点无从取得，任何消费方都无法渲染 consumed/limit 对，也无法对真实未取整比值做阈值判定。于是 dsh web 侧栏 glance 的 usage-glance v3 需求（周窗或月窗达到池子 85% 时该行标红，依据 2026-10-22 OpenCode Go 方案重估；其中 `$used / $limit` 直读本身于 2026-10-24 裁定不上屏）失去了数据依托。绝对计量表存在于 console 状态端点之后。

## Decision

适配器计划探针改为 `https://opencode.ai/console/api/go/status`，仍用同一把解析后的 bearer key，读取 `access.meters.{fiveHour,week,month}`——各含 `{limitMicroCents, usedMicroCents, resetsAt}`。微分除以 1e8 即美元；`percent` 经共享的 `usedPercent` 助手从同一 `used/limit` 对导出，百分比与绝对读数因此永不相左。`PlanWindowView` 新增可选 `used`、`limit`、`currency` 字段承载绝对对（USD）；其余适配器一概不填，导线保持向后兼容。计量表的 `resetsAt` 无条件透传，延续 [keep resetsAt at percent 0](../bug-fix/2026-10-17-usage-opencode-zero-percent-keeps-resets-at.md) 的 keep 语义——used 为 0 的计量表仍携带真实下一次重置。2026-10-24 实测：该端点仅凭 bearer key 即回 HTTP 200（无需会话 cookie、无需 `x-org-id` 头），三张计量表与当时屏上仅百分比读数对账吻合（周 26.30/30.00 = 87.7% 对上报的 87）。

## Alternatives considered

- **保留仅百分比探针、由百分比合成美元。** 否决：百分比不含池子容量，美元对只能靠编造（假定限额一换套餐即漂移），85% 扳机也只能读到取整整数而非真实比值。
- **一次适配器运行同时探两个端点。** 否决：探针管道每个事实只有一对 `build`/`parse`（见 `ProviderAdapter`），加第二个请求等于为状态端点已独家覆盖的数据拓宽宿主契约；双源还会在百分比与美元之间打开分歧窗口。
- **把 `go/status` 代理成插件之外的宿主端点。** 否决：它把 opencode 专有的凭据处理搬进通用宿主、在本插件 overview 旁另开一条数据支路，且本插件自己的计划页反而拿不到绝对对。2026-10-24 裁定落点留在本适配器。

## Consequences

- `opencode-go` 的 overview 窗口在 `percent` 之外新增 `used`/`limit`/`currency`；忽略未知字段的消费方（含只渲染 `percent` 的内嵌客户端计划卡）行为不变。
- `percent` 由上游整数变为导出浮点；消费方展示前本就取整，色调阈值比较原始值。
- 探针依赖从长期稳定的公开用量端点迁至 console API 面：console 侧一旦改版，整个计划视图静默降级（窗口整行消失、glance 行不见）——与旧端点探针失败时的失效模式同类。
- 已安装的 `@linxin666/dsh-usage` 副本只在包更新时才拿到本改动；先于发布做的本地补丁在任何 `pnpm` 更新 `@linxin666/*` 后必须重打。

## Testing

- `pnpm --filter @linxin666/dsh-usage test`：重写的 opencode-go 套件断言 go/status 探针 URL、计量表到窗口的映射与美元对（1.05692364/12 与 26.29702489/30）、percent 由同一对导出、used-0 的 keep-at-0 重置、以及缺计量表的降级。
- 2026-10-24 实测探针：bearer key 请求回 HTTP 200，返回文档即 Decision 所引三计量表。
