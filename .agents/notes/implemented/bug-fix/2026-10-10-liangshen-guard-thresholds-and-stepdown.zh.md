# Agent Note: 梁神 guard 在出厂路径上的阈值，以及降档停在何处

Status: implemented

已被[退场记录](../simplification/2026-10-17-liangshen-guard-retirement.zh.md)取代：这些阈值所属的熔断器已移除。

## Problem

梁神预设的运行时退化熔断器（`packages/dsh-liangshen/presets/liangshen/guard.mjs`）有三处已确认缺陷，均记录在该包当时维护的已知问题清单第 1–3 条。

**1. 自适应阈值与灵敏度旋钮在出厂路径上完全失效。** `resolveThresholds` 让显式细调值优先于按推理档位的自适应表与灵敏度预设，而插件 Config 把 `guardStallReasoningChars: 8000`、`guardGlobalStallCap: 4`、`guardEchoFailures: 3` 声明为 schema 默认值，`resolveConfig` 又按 `DEFAULT_CONFIG` 兜底，`applyPresetOverrides` 把这三个值无条件写进所声明预设的 `guard` 行，而出厂 `agent.cordis.yml` 本身也带着同样的三个键。任何一层单独存在就足以把取值钉死，四层叠加后 `effort` 与 `sensitivity` 两个输入对熔断器完全无效。出厂配置实测：`effort` 取 max/high/low 全部得到 8000，conservative/balanced/aggressive 也全部得到 8000。于是 `low` 档会话实际跑着比设计严 2.5 倍的阈值——正是抬高误中断率的方向，而熔断器自己写明的原则（「误中断真实长思考比漏报更伤体验」）禁止这一点。

**2. 降档可能掉到推理甜区以下，而空转信号拿到了不对症的动作。** 阶梯原本是 `max -> high -> low`，于是用户显式选择 `high` 的会话会被降到 `low`——低于官方 effort 成本曲线标出的、已恢复大部分精度的 60–80 区间。支持降档的两条证据（r/DeepSeek 1whgo3e 现场报告与该成本曲线）都只说明「max 过量」，没有任何一条支持降到甜区以下。另外，停摆与空转共用同一套动作，而只有停摆是推理预算过剩的症状：空转是调用本身失效，此时降档只会削弱一个本就卡住的模型，真正要求它换动作的是那条注入的熔断消息。

**3. STALL 检测在脱敏路由上结构性失明。** 两条停摆梯都以推理块字符数为度量。provider 若持久化带签名而文本为空串的推理块（`tools/analyze-session.mjs` 正是为这一形态而存在），所有计数恒为 0，两条梯永不触发，只剩空转一条腿。

## Decision

**guard 的三个细调字段默认未设置，而出厂预设携带的正是「未设置」。** `Config` 把 `guardStallReasoningChars`、`guardGlobalStallCap`、`guardEchoFailures` 声明为不带 `default` 的 `z.number().volatile()`；`ResolvedConfig` 与 `DEFAULT_CONFIG` 将其类型定为 `number | undefined` 并解析为 `undefined`；`applyPresetOverrides` 仅在值不为 `undefined` 时写入对应的 guard 键；出厂 `agent.cordis.yml` 的 guard 行只声明 `enabled` 与 `sensitivity`。这三个字段是「运维者设置时才生效」的覆写值，自适应表与灵敏度倍率才是出厂行为。

**降档阶梯停在甜区。** `EFFORT_LADDER` 为 `['max', 'high']`：`stepDownEffort('max')` 返回 `'high'`，`stepDownEffort('high')` 返回 `undefined`，因此任何会话都不会被降到官方曲线测得的精度恢复区间以下。

**只有停摆信号降档。** 触发熔断一律注入熔断消息；只有 verdict 的 signal 为 `'stall'` 时才设置 `state.stepDownLeft`。空转只拿消息。触发日志会写明实际采取了哪个动作。

**空转消息携带重试安全性二分。** ECHO 裁决的熔断消息按失败调用的工具名分类（guard.mjs 的 `RETRY_SAFE_TOOLS` 白名单）：只读或幂等工具报 `effectState none`——没有留下副作用，修正参数后重试安全；其余一切（shell 命令、写操作、可能中途停止的批处理、未识别工具）报 `effectState unknown`——先用只读工具验证真实状态再决定下一次调用，不得照原样重试。shell 工具刻意不在白名单内（同一 `bash` 既可能是 `ls` 也可能是 `git commit`）。`foldGuardSignal` 的 echo 裁决为此多带一个 `tool` 字段，只作消息分类证据，不改变任何触发逻辑；停摆消息不含此二分。词汇取自 dsh-ops 的 effectState 错误契约。

**整场会话没有任何推理文本时，退化为步骤计数。** fold 汇报一个会话级事实 `blind`——观测到了推理块，却一个字符的推理文本都没有；该事实成立时，连续零产出且带推理块的步骤按 `blindStallCap` 触发 STALL（默认取慢烧梯的上限，因此灵敏度预设以同样方式缩放它）。盲梯对步骤的判定只看「带推理块且零产出」，不看大小；完全没有推理块的事件流不算盲——字符梯只是还没轮到机会。该事实首次成立的请求上，guard 每个 agent 告警一次，说明本会话的停摆检测已降级为步骤计数。

## Testing

- `packages/dsh-liangshen/tests/guard.test.ts` 覆盖全部三项：`resolveThresholds` 按档位与按灵敏度、阶梯两端（`max -> high`、`high` 不动）、同一条四步事件流上的盲会话与非盲会话、盲梯的重置与上限，以及在假 context 上驱动 `apply` 的「信号到动作」分派（空转注入消息且不动 max 档请求；停摆注入消息并恰好按配置窗口把 `max -> high`；降级告警每个 agent 一次，且带推理文本的会话永不告警）。
- `src/index.test.ts` 钉住三个字段从空配置与 schema 都解析为 `undefined`；`src/composition.test.ts` 钉住未设置时 overlay 不写入任何 guard 键；`src/announce.test.ts` 钉住所声明的 guard 行只携带真正设置过的键。
- `pnpm --filter @linxin666/dsh-liangshen test` 通过 21 个文件 366 项；`pnpm --filter @linxin666/dsh-liangshen typecheck` 通过。
- 无实测会话证据：本改动改的是预设行与设置 schema，需插件重新声明预设后新建的会话才生效。运行中的 `dsh web` 宿主未被触碰。

## Alternatives considered

- 保留 schema 默认值，改为不把它们写进预设行。否决：设置卡仍会把 8000/4/3 显示为已存值，「未设置」在界面上无法表达，运维者也就永远看不到、也恢复不了自适应行为；只有 schema 能表达「无值」。
- 给这三个字段用 `default(undefined)` 或哨兵值（0、-1）表示「自适应」。否决：哨兵需要在每个读取点解码，且非法值与故意设置的值无法区分；`undefined` 本身就是 schema 的缺失态，经 `readField` 原样流过。
- 让 `high` 降到 60–80 区间的中位而非保持不动。否决：本路由不暴露数值档位（阶梯只有 `max` / `high` / `low` 三个具名档），没有中位档可降；在证据只显示 `max` 过量的前提下，保持 `high` 不动是对证据最保守的读法。
- 既然只有一个信号支持降档，就整体去掉降档。否决：r/DeepSeek 的现场报告正是「预算降下来即恢复」的活例，而[拥有该机制的 note](../../simplification/2026-09-20-liangshen-guard-triggered-reasoning-stepdown.zh.md) 正是为这一形态刻意恢复了该机制；把它收窄到真正对症的信号，既保住证据又去掉误用。
- 在脱敏路由上只告警「停摆检测不可用」，不加兜底度量。否决：这让会话在无保护状态下运行，而步骤计数虽粗，测的仍是同一形态；且任务书要求的是保守兜底而非告警。
- 让盲兜底对任何连续零产出步骤生效，不看是否带推理块。否决：那会把裸工具回执与空回合也算进去，抬高普通会话的误报率——与本熔断器立足的保守方向相反。

## Consequences

- 设置界面的三个数值字段含义变为「留空即自适应」：中英双语 hint 都如此说明，卡片占位符显示「自适应」，清空字段后不会再写回任何键，自适应表随即恢复生效。
- 灵敏度旋钮在出厂配置下有了可观测效果：conservative 把 max 档下限解析为 12000，aggressive 解析为 4000，慢烧上限解析为 6 / 2。
- 脱敏路由会话由 STALL 覆盖，而不是只剩空转一条腿；代价是每个 agent 一条告警，且度量比字符数更粗——因此兜底上限取与慢烧梯相同的保守步数，而不取任何更紧的值。
- 降档窗口仍在已触发 episode 内经 `agent/request` 水位生效三个请求，其余时间 guard 仍是纯 pass-through，因此[恢复该机制的 note](../../simplification/2026-09-20-liangshen-guard-triggered-reasoning-stepdown.zh.md) 对前缀缓存与显式档位的约束依然成立。
- [2026-09-20 note 形态表](../../simplification/2026-09-20-liangshen-guard-triggered-reasoning-stepdown.zh.md)中「降档目标」一行（当前档位下一档，max→high→low）由本 note 取代；该表其余各行——仅在熔断时介入、降档作为熔断动作自动发生、接受一次性缓存破坏、设置卡不恢复、载体为 `guard.mjs`——维持不变，该 note 仍是本 note 只做收窄的那个机制的拥有者。
