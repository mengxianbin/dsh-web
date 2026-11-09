# Agent Note: dsh-session-revive 影子先行的会话自动复活（4h x 4 额度、10 分钟断路器、同因波探针、150k 水位）

Status: implemented

## Problem

三层会话连续性模型的第 1 层（设计档为主树 `content/tech/ai/dsh/session-auto-revival-design-1102.md`）是机械复活：被传输类抖动打死的会话应当在几秒内自己醒回来，不惊动人。裁定背后的统计同时说明了为什么值得做、又为什么必须带刹车——56 天里 1556 个会话共 314 次失败轮次，其中 68% 是可复活类（TRANSPORT 168 + TIMEOUT 45 = 213），风暴时 11 个会话在同一波里同灭；对每个错误裸发 nudge 会反复砸向正在抖动的 provider、在循环里烧穿额度，把第 1 层自己变成一场复活风暴。缺的是一个统一的决策账——额度、撞墙、断路器、波、水位都在这里判定——默认只观测不动作，并写出一份能拿来调参的结构化日志，之后才谈得上开开关。

## Decision

- **影子先行的宿主侧包 `dsh-session-revive`**，落在 `packages/dsh-session-revive`（不声明 `dsh.client` 面，与 dsh-session-dispatch 同款链装形态，不进 bundle 聚合清单）。`mode: 'shadow'` 为默认（`src/config.ts:117`），发送门只有一行（`src/index.ts:106`）：影子跑完整决策账、只扣住 `prompt` 调用，所以一夜影子日志就是 live 本该做出的全部动作。
- **`src/policy.ts` 纯函数、时间显式**：每个入口都收事件时间戳（测试喂假时钟，宿主传 `event.time` / `Date.now()`），定时器只在插件外壳里（每个波冷却一个 `nextWakeAt` 唤醒定时器），状态更新与模式无关——影子与 live 共用同一本账。
- **按设计 §4.2 分类**：可复活类 = `TRANSPORT`/`TIMEOUT`（`src/config.ts:50`）；撞墙类 = 设计逐字名单加上其 `AUTH` 族与模型配置族（`src/config.ts:58`）；其余码只观测、只记日志。撞墙死亡零消耗并挂起到 `resetsAt`——即 provider 报的 `providerRetryAfterMs`；没报就是未知复位，挂到一次成功轮次证明恢复为止，这是 2026-11-01「撞墙不烧重试」裁定的保守侧。
- **复活流顺序**：断路判定（每会话永久停用并留证据记录）→ 撞墙挂起 → 150k 水位 → 波挂起 → 分罐额度 → 带错峰 `plannedAt` 的复活。断路器对「10 分钟内任意再死」触发（设计第 3 行原文只说「再死」不限码；撞墙再死同样意味着复活没能把会话留住），且断路优先于波——疑似循环的会话是被停下，而不是被延后。
- **同因波 = 同错误码**：15 分钟内同码错误达到 2 次成波；之后同因死亡一律零消耗挂起，静默满 5 分钟才释放——释放段走完整检查、且不再折返挂起，因为静默期本身就是释放判据（`src/policy.ts:299`）——复活经全局错峰槽排期（`plannedAt = max(now, lastPlanned + staggerMs)`，地板与初值 10s，可向上配）。
- **裁定参数是可 grep 的字面量**，集中在 `src/config.ts`：4 小时窗口 `4 * 60 * 60 * 1000`（:33）、每链 `4` 次（:35）、10 分钟断路（:37）、15 分钟波窗（:39）、5 分钟冷却（:41）、`10_000` 错峰地板（:43）、`150_000` 水位（:47）。额度链随会话（session-scoped）；本批预留的 relay 绑定（`relayOf` + `bindRelay`）已由 [relay 线砍单](../simplification/2026-11-09-relay-line-cut.md) 移除。
- **水位折取 `assistant/message` 的 usage**：`inputTokens + cacheReadTokens`（与设计统计扫描同一上下文口径），最新观测覆盖旧值；读不到就不加该分界，判定里记 `contextTokens: null`。达到或超过 150k 时 human 与 bot 一律停靠；不存在 relay 分支（由 [relay 线砍单](../simplification/2026-11-09-relay-line-cut.md) 移除）。
- **留证面**：每条记录经宿主 logger 落一行结构化 JSON，`dsh-session-revive ` 前缀加当前 mode 标记（检测 / 含额度、resets、水位、波与断路字段的判定 / 断路触发 / 波开启与释放 / 状态清除），外加仅回环的 `GET /api/session-revive/status` 回答方式、计数、挂起/停用/断路状态与分罐额度，供重启后验证。

## Ruled parameters and interpretations

- 设计 §四 逐字落地（实施不改值）：上列全部数字；本批刻意没有启用 `live`——转正开关只存在于配置里。为设计合规记录的解释：同因即错误码——TRANSPORT 与 TIMEOUT 各自成波，两码都凑不到 2 次的混合风暴改由 4h x 4 额度兜底；成波中的第一个错误在波成形前就已判定，因为探针需要第二次观测（损失由断路器与额度封顶，并会在影子账里显形）；挂起单调不回缩（后来报的复位不会缩短更早的未知挂起）；子代理子会话保留在范围内（设计覆盖全员），`session.header.origin` 记入证据；半途静默死亡归看门狗链，不在本线。

## Alternatives considered

- 按统计扫描的方式做时间聚类波（15 分钟内任意错误算同一波）：运行时否决——任务书写明按同因，分因挂起才能让 TIMEOUT 抖动不去扣住 TRANSPORT 会话（反之亦然），混合码场景仍由额度封顶。
- 每个第一个错误都先挂起等探针确认（「探针先行」的最严读法）：否决——波规模 p50 就是 1，常见孤立错误会一律交 5 分钟冷却税，打破第 1 层秒到分钟级的时延目标。
- 把决策账落 `$DSH_HOME` 文件（重启不丢、直接喂晨报）：v1 否决——设计把结构化日志定为留证线，内存账也让插件不碰共享文件面（无需 sync-shared 复制 dsh-home）。
- 只在 provider 报了 `providerRetryAfterMs` 时才挂起：否决——凭据与授权类撞墙通常不报重试时间，而那正是下一个裸奔的 TRANSPORT 错误会烧掉一次复活的墙。
- 不做状态端点（只留日志）：否决——重启后验证清单需要一个回环答案证明 `mode: shadow` 且计数在动，与 dsh-session-dispatch 的 health 面对齐。

## Consequences

- 宿主重启会清空断路、挂起、额度与波状态；日志流是唯一持久记录，所以晨报读取方是真后置项而非锦上添花（README 已列为已知限制）。
- 拨到 `mode: 'live'` 后发出的是 `继续` nudge，走的结构 prompt API 只在假会话控制器上被单测过；转正批次自带验证清单（状态端点、决策行、nudge 结果），通过前不无人值守信任。
- 忘记已释放会话会连带删掉它的额度罐：罐随会话——预留标示归属链清理的 `relayOf` 映射已由 [relay 线砍单](../simplification/2026-11-09-relay-line-cut.md) 移除。
- sync-shared 清单本批新增三个目标（mount-once、loopback、http），副本计数基线随之 105 → 112；该基线在 origin/dev 上本就停在 109（早前批次未同步断言），清扫一并记在此处，不留红。

## Testing

`tests/policy.spec.ts`（14 例，显式时间戳假时钟）覆盖全部门测——滚动 4h x 4 窗口与分罐隔离、撞墙类零消耗加挂起与未知复位清除、断路触发留证与窗后不触发、波开启/挂起/冷却延长/错峰释放且释放时重跑完整检查、150k 水位折取——外加成功清除挂起、forget 与检测边界。`tests/config.spec.ts`（5 例）钉死影子默认、10s 夹取告警、schema 拒绝与码表分类；`tests/routes.spec.ts`（3 例）钉死状态端点的 200/403/405 契约。合计 22 例，`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm docs:check`、`pnpm i18n:check` 与 `node --test scripts/sync-shared.test.mjs`（4/4）全绿。没有任何用例触碰真实会话生命周期，沙箱规则自始未被触发。
