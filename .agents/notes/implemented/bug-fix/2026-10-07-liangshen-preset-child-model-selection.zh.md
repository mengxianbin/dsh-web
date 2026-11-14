# Agent Note: 梁神预设的子 agent 模型选择开关

Status: implemented

## Problem

`packages/dsh-liangshen/presets/liangshen/agent.cordis.yml` 的委派工具行照抄内置预设时漏掉了子 agent 模型选择开关：`tool-subagent` 与 `tool-subagent-fork` 都没有携带它。开启后的全部效果都挂在它上面：

- 委派工具不发布 `provider` / `model` / `reasoning_effort` 参数，显式指定子 agent 路由会在调用时抛 `child model selection is disabled for this tool instance`；
- 工具描述里永远不会出现子 agent 选择那句，`list_subagent_models` 也从不注册，模型没有发现入口；
- 于是 Web 设置界面的子智能体模型选择开关在本预设下形同虚设，尽管宿主侧的服务是存在的（`subagent-model-selection-settings`，由官方 `dsh-web-app` 宿主 bundle 挂载）。

凡是带委派行的官方预设都在 spawn 行开启了该开关（`standard.patch.yml`、`ptc.patch.yml`、`cordis.patch.yml`），出厂的梁神清单是唯一的例外。

这个开关后来在上游被拆开：`modelSelection` 发布路由字段，`modelDiscovery` 注册 `list_subagent_models`，而拆分前的 `modelSelectionSettings` 在本仓库运行所对的 harness cohort 中已退役。加载器 schema 未声明的字段不会被任何代码读取——Schemastery 会保留这个未声明字段，同时把已声明的布尔量填成 `false`——因此只带旧键的预设会再次失去开关，而且既没有加载报错也没有告警。`devDependencies` 钉住的 cohort（`0.2.1-rc.3`）仍然只声明旧键，所以任何单一写法都伺候不了两代。

## Decision

`tool-subagent` 行同时开启两个现行开关 `modelSelection: true` 与 `modelDiscovery: true`，并在它们旁边保留拆分前的写法 `modelSelectionSettings: true`：每一代只读自己声明的键，另一个原样放着不被读取，从而让开关跨过这次拆分。等到再没有受支持的 cohort 早于拆分时，该行收回到现行的一对键。

`tool-subagent-fork` 行两个都不开，而且发现工具不能挪过去：

- 上游以固定名 `list_subagent_models` 注册发现工具（`packages/subagent/tool-subagent/src/list-models.ts` 的 `registerListSubagentModels`），注册进该行所合入的那个 scope；
- 预设 scope 的行是通过 `candidate.ctx.inject(...)` 按每个已组合 Agent 分别安装的，因此同一组合 scope 内的每一个发现所有者都会把同一个名字注册进同一个 Agent scope；
- 工具注册表拒绝同一 scope 内的同名重复注册：`NamedEntries.insert` 由其重复工厂抛错，消息为 `tool "list_subagent_models" is already registered in this scope`。第二个发现所有者因此会直接让会话组合失败，而不是多出一份能力。

因此出厂的不变式是：同一组合 scope 内只允许一行委派工具开启发现，而 fork 行恰恰是维护者会顺手补齐的那一行。这条约束写进了预设文件中该行旁边；`tests/preset-composition.test.ts` 也不再只钉 spawn 行的文本，而是在解析后的组合上（递归进入 group 行）按结构统计发现所有者，并额外做一次变异校验：给 fork 行注入第二个所有者后统计结果必须变成两行，从而保证这道守卫不会空过。

单看路由字段是按实例的，所以 `modelSelection` 放在 fork 行上并不会与任何东西冲突；该行仍然两个都不开，因为官方 Standard、PTC、Cordis 清单在那里都不开，本预设与它们保持同一形状。子 agent 路由选择需要提供方声明 `agentOptions`，进程内的 Spawn 与 Fork 都声明了。harness 的 `/model-selection-settings` 服务在 Agent 创建时采样用户偏好，与工具安装无关，因此没有任何预设行去挂载它。

## Testing

- `packages/dsh-liangshen/tests/preset-composition.test.ts` 断言 spawn 行带现行的一对键加退役写法、fork 行一个都不带、解析后的组合恰好只有一个发现所有者（`['tool-subagent']`），以及给 fork 行注入 `modelDiscovery: true` 后必须报出 `['tool-subagent', 'tool-subagent-fork']`，保证守卫不会空过。
- 在本仓库运行所对的 cohort 上实测过旧键是惰性的：用该 checkout 自己的 `Config` 解析该行，`modelSelectionSettings` 被保留，而 `modelSelection` / `modelDiscovery` 停在 `false`；已发布的 `0.2.1-rc.3` 则声明 `modelSelectionSettings` 且两个新键都不存在。
- `pnpm --filter @linxin666/dsh-liangshen test`（364 个测试）通过。
- 无 GUI 实测证据：预设改动在新会话中才生效，运行中的宿主未被触碰。

## Alternatives considered

- spawn 行与 fork 行同时开启，让每个委派工具都能选路由。就发现工具而言否决：这正是让整个会话以 `tool "list_subagent_models" is already registered in this scope` 失败的配置。单看路由字段放在 fork 行是安全的，但官方清单在那里本来就不开。
- 在上游把发现工具的注册改为幂等，或改成按工具命名。这才是正解，但它属于 `@deepseek-ai/dsh-tool-subagent`，而本仓库从不修改 harness 或其 SDK 包。因此改为向上游提 issue；在其落地之前，由预设侧的注释与测试保证本地清单正确。
- 只写现行的一对键、删掉退役写法。否决：`devDependencies` 钉住的 SDK 只声明旧键，这会静默夺走本包自身 cohort 的开关——正是本记录要防的缺陷，只是挪到了下一代。
- 在预设里声明 `agentOptions` 块来钉住默认子 agent 路由（真实字段名是 `provider` / `model` / `reasoningEffort` / `maxTokens`，已在安装的 schema 中核实），而不开启模型侧选择。否决：它并不能修好 issue 指向的设置开关，反而会为每次委派强行钉死一条子路由。该键保持不设置；对确实想要固定路由的运维者，它仍是另一个独立可选项。
- 不加开关、只在文档里写明限制。否决：这等于把已报告的缺陷留在出厂预设里，而它的上游对照物本来就带着这个键。

## Consequences

- 梁神模式下 Web 设置界面的子 agent 模型选择开关真正生效：宿主设置开启后，模型能在 `subagent` 上看到路由参数并调用 `list_subagent_models`；显式路由按会话允许清单校验，没有已记录的策略时退回父 Agent 当前路由。
- 两套写法并存直到受支持的 cohort 越过这次拆分，预设文件在它们旁边写明了删除条件。
- 「只允许一个所有者」现在只约束发现工具。想要可 fork 的子 agent 走另一条路由的维护者，可以给 fork 行开 `modelSelection` 而不破坏组合，但出厂清单不开，与官方预设一致。
