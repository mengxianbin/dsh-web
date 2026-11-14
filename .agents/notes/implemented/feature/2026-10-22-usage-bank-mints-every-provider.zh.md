# Agent Note: Token 银行从全部 provider 铸造鲸元

Status: implemented

## Problem

Token 银行页签只从 DeepSeek 官方家族铸造鲸元，于是用量落在别处的 profile 面对的是一张空票券，而台账里明明记着它的 tokens。issue #1831 用一条网关路由暴露了这一点：当时的修法是在官方家族旁枚举那一个路由 id，于是下一位用户——按 Kimi For Coding、GLM 编程计划或 MiniMax 付费，或经别的 provider 中转的人——仍然看到空票券。铸造集合是写死在代码里的路由 id 清单，每加一个 provider 都要发一次版本才能铸造，而任何一次路由改名都会让银行重新变空。

## Decision

`packages/dsh-usage/src/client/voucher.ts` 的 `voucherData()` 对窗口 `providers` 的每一行求和 tokens 与 calls。`EXTRA_MINT_ROUTE_IDS` 白名单与 `mintsWhaleYuan()` 谓词删除：银行铸造的是这个 profile 花掉的用量，因此不再有任何会过期的路由枚举。零 token 台账仍然返回 `undefined`——永不铸出零面额票券。

`cost` 仍锁在 `isDeepSeekProviderRoute()` 上：

```ts
for (const row of window.providers) {
  tokens += totalTokens(row.totals)
  calls += row.totals.calls
  if (isDeepSeekProviderRoute(row.provider)) cost += row.totals.cost
}
```

### 记账决策与探测决策依旧分离

[账号路由笔记](../bug-fix/2026-09-30-usage-account-route-family-without-probe.md) 立的常设规则是：记账类决策读 `isDeepSeekProviderRoute()`，余额探测、凭据回退与 alias 折叠读 `adapterFor()`，两者不能一起变宽。铸造是针对台账行的记账决策，放宽它不碰任何 adapter——把网关路由塞进 adapter，等于白送它余额探测与凭据回退。这条规则今天的具体形态是一个测试：让中转路由的行铸造，同时断言 `adapterFor()` 不认领它们。

### 消费仍只属于有价家族

订阅与中转路由没有价目表，折叠时盖章本就让它们的行 `cost` 为 0，所以对全部行求和加上的仍是 0。仍然锁这一行：边界从「碰巧如此」变成结构性的，并且可以用一个带非零非官方 `cost` 的夹具证明。因此消费行依然读「官方余额实测花费」，永不变宽成订阅总额。

### 银行文案

zh 与 en 的提示 / 空状态文案写的是「所有模型」口径，ru 镜像位于 `packages/dsh-i18n/src/client/ru/usage.ts`。没有新增任何占比明细：铸造覆盖全部 provider，但票面只保留那一个累计数字，不写「其中订阅 X tokens」这类行。

## Alternatives considered

- **保留白名单并追加新的路由 id。** 否决：每加一个 provider 都要改代码、发版本才能铸造；包一旦改路由 id，白名单就静默失配（旧笔记正是接受了这个失效方式）；而只有订阅用量的 profile 依旧看到空银行。目标既然是「全都铸造」，路由 id 清单只能退化成一份例外清单。
- **做成可配置的 `bankMintRoutes: string[]` 设置项。** 否决：它把改动面扩到配置 schema 与设置卡，而配错的路由会在没有价目表的情况下静默铸出 tokens。既然每一行台账都铸造，这个设置唯一能决定的只剩「少铸一点」。
- **把非官方路由加进 DEEPSEEK adapter 的 `familyOnlyIds`。** 否决：`familyOnlyIds` 描述的是「不用 API key 但仍属于有价家族」的路由；订阅路由根本没有价目表，那会让定价与探测路径把它当成 DeepSeek。
- **在票面上画出订阅在铸造总量中的占比。** 所有者否决：全部铸造，但不写「其中订阅 X 亿 tokens」；票面只保留一个累计数字加消费行。
- **面额改为从消费派生而非 token。** 否决，与银行最初的决定一致：用户要的就是 token 数，消费已有单独一行。

## Consequences

- 购买订阅或在别处中转的 profile 现在也能铸造；只有台账里完全没有 tokens 时才出现空状态。`faceValue()` 仍把任何非零总量抬到最小面额 1。
- 因为消费仍只算官方家族，只有订阅用量的 profile 铸出的票券，消费行在出现官方余额观测之前读 ¥0.00。文案说的是「消费估算」，包 README 写明了这个分界，所以票券从不声称订阅的价格。
- 「铸造家族 / mint family」不再是代码、测试或文案里的概念：包 README（中英）、根 README 中英、zh / en / ru 银行文案，以及 [Token 银行笔记](2026-09-10-whale-yuan-voucher-token-bank.zh.md) 都改为「全部 provider」，官方家族限制只在消费行上陈述。
- 取代关系：本笔记整体接管已被完全取代的白名单笔记（2026-10-07，「Token 银行铸造走显式路由白名单」）——路由 id 而非 adapter 家族的取舍、记账 / 探测分离的常设规则、结构性的 cost 锁定都并入此处——该笔记三件套删除；没有其它文件链向它。

## Testing

- `packages/dsh-usage/tests/voucher.spec.ts`：全 provider 求和（只有订阅用量的窗口按自己的 tokens 铸造、中转行计入 tokens 与 calls 但不计消费、官方别名仍合并成一张票）、零 token 与缺窗口返回 `undefined`、缓存桶计入面额，以及「铸造不授予 adapter」的保证。
- `packages/dsh-usage/tests/section-card.spec.tsx`：空台账的空状态、整台账票券把官方行与订阅行合并计入 tokens 而消费行仍是官方估算、以及中转行在官方家族旁铸造却不进消费行。
