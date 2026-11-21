# Agent Note: 梁神运行时退化熔断器退场

Status: implemented

取代[以熔断触发恢复动态推理档位的记录](2026-09-20-liangshen-guard-triggered-reasoning-stepdown.zh.md)与[修正其出厂阈值与降档终点的记录](../bug-fix/2026-10-10-liangshen-guard-thresholds-and-stepdown.zh.md)。两者描述的机制已被本记录移除，均不再代表当前行为；它们所依托的 persona 反思熔断，以及它们约束过的推理档位删除决定，保持不变。

## Problem

`liangshen` 预设曾携带一个运行时退化熔断器——`presets/liangshen/guard.mjs`、预设组合中的 `guard` 行，以及五个插件设置键。它从持久会话事件流折叠出停摆、空转与「呈现误用」三种裁决，在下一个 pre-step 注入 `[Circuit Breaker]` 消息，并且只在停摆信号下经 `agent/request` 把推理档位下调一档。它回应的是 DSH discussion #5976：在极长上下文与 max 档下，模型可能连续多轮输出零产出的自我催促式思考，而 persona 的反思熔断无法阻止它——在该状态下，纪律文本本身已经离开有效上下文。

该机制在这条路由上从未被测量。它的五个键是一张卡片里最大的调参面，而卡片其余字段只是两个开关和一次呈现选择；实际使用中每个字段都停在继承/自适应，卡片更多是在记录一个子系统，而不是让运维者改动它。所有者要求删除这组设置，并在「保留一个藏在固定默认值后面的不可调熔断器」与「整体退场」之间选择了后者。这是产品决定，不是重叠实现的清理：已安装的 0.2.1-rc.2 宿主没有原生退化熔断（发布包中不存在熔断、停摆检测或档位下调表面），因此没有任何官方能力替代它。

## Decision

熔断器已从插件、预设、设置 schema、客户端卡片、语言字典与包文档中移除：

- `presets/liangshen/guard.mjs` 及其 `tests/guard.test.ts` 被删除，`presets/liangshen/agent.cordis.yml` 不再有 `guard` 行，因此没有任何会话挂载 pre-step 通道或 `agent/request` 降档。
- schema 只声明四个 volatile 字段——`enabled`、`announceToAgent`、`presentation`、`dispatcher`——`ResolvedConfig`、`DEFAULT_CONFIG` 与 `resolveConfig` 同样只携带这四个；`applyPresetOverrides` 只覆写 `tool-catalog` 的呈现与 `minimal-prompt` 的调度者开关。
- 设置卡片、zh/en 字典与集中式 ru 字典不再携带熔断键、灵敏度选项与「自适应」占位文案。
- 「呈现误用」打包提示是熔断器的第三个信号，本身没有设置项；它随模块一起退场。persona 的 Parallel Inspection 一行仍要求模型把同类步骤打包进一个 `run_code` 程序，因此静态纪律保留，只是不再有运行时消息。
- `docs/liangshen-known-issues.md` 随其最后一条记录（熔断缺少升级阶梯）一起删除。
- 仍带 `guardEnabled` 或其他已退场键的 profile patch 继续可加载：schemastery 的 object schema 非严格，会保留未知键，且没有任何代码读取它们。它们是「被忽略」，不是被迁移或被拒绝，设置表单也不再渲染它们。

保留退场机制的原始理由，以便将来读者用同一份证据判断是否重新引入：

- 为什么存在：#5976（V4.1-Flash 在长上下文与 max 档下退化且无自动熔断）、官方档位成本曲线（max 的轨迹长度约为甜区的 1.6-1.8 倍），以及 r/DeepSeek 1whgo3e 的现场报告（降档后死循环恢复）。
- 阈值按请求的推理档位自适应（max 8000 / high 12000 / low 20000 字符），再按灵敏度预设缩放（保守 ×1.5、均衡 ×1.0、激进 ×0.5）。单步暴走梯在一步零产出且超过字符下限时触发；慢烧梯要求连续四步有推理但零产出；空转梯要求同一工具以相同参数连续失败三次。
- 降档阶梯停在 `high`（`max -> high`，`high` 不动），因为官方曲线把 60-80 档位放在精度恢复区间，且没有任何证据支持降到其下。只有停摆降档；空转只注入消息。
- 空转消息携带重试安全性二分（可证明只读的工具报 `effectState none`，其余报 `unknown`）。在只持久化带签名、文本为空的推理块的路由上，会话退化为按连续零产出步骤计数检测停摆，并对每个 agent 告警一次。
- 呈现误用信号在连续四次模型直调 shell 且期间没有 `run_code` 时触发（随灵敏度缩放为 6/4/2），wire 上没有 `run_code` 时整体静默。

## Alternatives considered

**保留熔断器，只删除它的设置。** 否决：所有者要求删除这组设置，并在「常开的固定阈值熔断器」与退场之间选择了退场。一个隐藏且不可调的熔断器也无法按部署关闭，而那正是旧 schema 提供的唯一控制。

**保留熔断器，只删除三个数值覆写。** 否决：同一决定——所有者选择整体退场，而保留开关与灵敏度预设仍然是给一个被本改动判定为不在范围内的机制保留设置面。

**把熔断器搬到 harness 的请求路径上，做成与插件无关的能力。** 否决：那是一项新的官方能力，不是本仓的简化；已安装的 0.2.1-rc.2 包不暴露这样的表面。

**把已退场的键保留为墓碑，或显式拒绝它们。** 否决：这些键已无作用且在表单中不可见，保留墓碑等于为一个不再存在的机制保留设置面；非严格校验已经让旧 patch 正常加载。

**随被取代的 note 一并继承的备选结论。** 不再重新讨论：恢复分阶段的 `reasoning-effort.mjs` 及其卡片控件（2026-09-20 note 否决，本记录维持）；把 schema 默认值钉死为 8000/4/3（2026-10-10 note 否决，因为它同时遮蔽了档位自适应表与灵敏度预设）；用 0 或 -1 之类的哨兵值表达「自适应」；让 `high` 继续降到 60-80 区间；在熔断器仍存在时整体去掉降档；在脱敏路由上只告警而不退回步骤计数；把任何连续零产出步骤都计入盲兜底。

## Consequences

- 预设上的会话不再收到熔断消息、档位下调或打包提示。对抗 #5976 形态的最后手段只剩 persona 反思熔断与人工中止——这是被记录下来的刻意缺口，不是疏漏。
- 该命名空间的设置页现在显示四个字段，schema 也是四个 volatile 字段；卡片镜像与三份语言字典一致。
- 旧 profile patch 中的已退场键保留为惰性数据；不会有任何告警，将来若重新引入，需要自行决定是否读取它们。
- `packages/dsh-liangshen` 不再有已知问题条目，也没有 `docs/liangshen-known-issues.md`。
- 2026-09-20 与 2026-10-10 两条记录仍留在活跃树中，作为该机制的历史并由本记录链接；它们不代表当前行为。

## Testing

- `pnpm --filter @linxin666/dsh-liangshen test` 通过 20 个文件 / 360 项，包含退场围栏：`tests/preset-composition.test.ts` 断言组合中不再有 `guard` 行，`src/announce.test.ts` 断言所声明的预设没有 `guard` 行，`tests/settings-card.spec.tsx` 断言卡片只渲染存活的四个字段、没有熔断控件。
- `pnpm --filter @linxin666/dsh-liangshen typecheck` 通过。
- 随机制一起删除：熔断器自己的单测、两个设置卡用例，以及两个钉住熔断键的覆写用例；`src/index.test.ts` 与 `src/composition.test.ts` 不再携带熔断字段。
- 无实测会话证据：本改动移除预设行与设置键，需要插件重新声明预设后新建的会话才生效；运行中的 `dsh web` 宿主未被重启。
