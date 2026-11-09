# Agent Note: dsh-session-revive 把 content_filter 与 MALFORMED_RESPONSE 准入可复活类

Status: implemented

## Problem

复活插件只把 `TRANSPORT` 和 `TIMEOUT` 分为可复活类；`content_filter` 与
`MALFORMED_RESPONSE` 蹲在裁定撞墙名单里，因此被这两者杀掉的会话只被零消耗
挂起、永不续跑。2026-11-08 的语料复跑（`~/.dsh/sessions` 下 1875 份转录、
352 个错误轮）实测撞墙前提——「复活了也再撞同一堵墙」——对这两码不成立：
人工 continue 后 6/8 个 `content_filter` 会话跑完下一轮（事件级 55%，与
`TRANSPORT` 的 59% 同档），`MALFORMED_RESPONSE` 是 6/8（75%）；而撞墙名单
真正护住的码（`INVALID_REQUEST` 27%、`AUTH` 29%）维持低位。更糟的是，
harness 根本不产出 `content_filter` 这个失败码——`classifyPiAiError` 没有
内容过滤分支，该停轮以兜底码 `PI_AI_ERROR` 到达、成因只活在消息里
（`Provider finish_reason: content_filter`）——也就是说撞墙名单里的
`content_filter` 是条永远匹配不上的死字面，这些会话被分成 `other`：只观测、
只跳过、永不续跑。

## Decision

- **两码从 `WALL_CODES` 移入 `REVIVE_CODES`**（`src/config.ts`，设计 §4.2
  修订，拍板⑬）。它们与网络死因共用同一条 4h x 4 额度、断路器、波、错峰与
  150k 水位；撞墙名单保留语料实测仍不可恢复的码。
- **分类前做消息级精化**：`refineFailureCode()` 把 `PI_AI_ERROR` + 消息命中
  `/\bcontent_filter\b/i` 映射为 `content_filter`，其余码原样通过；
  `src/index.ts` 把精化后的码喂进 `policy.onError`。范围刻意只限这一个兜底桶
  ——语料 11/11 例都落在这里，而真码（`INVALID_REQUEST` 等）即使消息里出现
  这些词也保持自己的分类。分类本身仍完全由裁定（可配置）名单负责；精化只
  决定名单看到哪个码。
- **裁定背后的准入条件**（设计档 `session-auto-revival-design-1102.md`
  拍板⑫）：一码进入可复活名单须同时满足 ① 人遇到该停轮的默认动作就是朴素
  continue、② continue 单独即可恢复且带语料数据、③ 续跑无害。恢复依赖
  先决条件先变化的码（QUOTA 等 auto-route 切路由、AUTH 要登录）不进——它们
  各有专属通道（拍板⑩ 路由释放、人工动作）。

## Testing

本包 `pnpm typecheck` 绿、`pnpm test` 66 通过（65 既有 + 1 新增
`refineFailureCode` 例，覆盖 PI_AI_ERROR 桶、repetition_truncation 不命中、
消息缺省、非兜底码、以及精化→分类为 revive 的端到端路径）、`pnpm build` 绿
（`lib/index.js` 2026-11-08 重构建，49.89 kB）。`config.spec.ts` 与
`policy.spec.ts` 的裁定默认值断言按新四码可复活名单逐字更新；
`policy.spec.ts` 的撞墙夹具改用 `INVALID_REQUEST`——`MALFORMED_RESPONSE`
已不再停靠会话。

## Alternatives considered

- **给 harness 分类器加 content_filter 分支**：否——本包的纪律是零 harness
  改动（设计 §七 实施边界），且消息本来就在链路上；在消费侧精化把修复留在
  唯一需要它的单包内。
- **把精化放宽到任何消息命中的码**：否——带这些字样的 `INVALID_REQUEST`
  应保持其 27% 恢复率的撞墙分类；只精化 harness 实际折叠该停轮去的那个桶。
- **`content_filter` 留在撞墙名单当死字面**：否——它永远匹配不上任何东西，
  留着等于记录一个代码表达不出的意图；准入裁定把它移到能生效的地方。

## Consequences

- 运行中的 Host 只在下次重启时拾取本改动（link 安装在激活时加载
  `lib/index.js`）；重启恒归人。在此之前旧名单继续生效、这些会话继续被跳过
  ——重启后的判据 = `content_filter` 消息产出 `cls: "revive"` 的 `detect` 行
  而非 `other`。
- profile 配置（m-note `.dsh/profiles-web-cordis-patch.yml`）显式钉了两张
  名单，必须同步这次搬家否则会把新默认值覆盖回旧行为；两处落在同一裁定批次。
- `repetition_truncation`（`PI_AI_ERROR` 的另一占据者，n=5 恢复 40%）刻意
  不精化；未来语料数据若达标，走同一条消息精化通道。
