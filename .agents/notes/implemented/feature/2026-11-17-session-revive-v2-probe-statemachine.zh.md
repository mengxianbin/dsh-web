# Agent Note: dsh-session-revive 增添复活 v2 探针门与三分诊状态机

Status: implemented

## Problem

裁定账（额度、断路器、波、水位）只能在死亡已经发生之后反应：复活 nudge
仅凭裁定名单排定，既没有「供应商路径还活着」的证明，也不区分「花了钱没进展」
与「根本没跑起来」，更没有任何机制保证死会话的工作真的能存下来。2026-11-16
设计（m-note `content/tech/ai/dsh/session-revival-v2-alert-inbox-1116.md`）
点名三处失败：在死路径上盲发（探针结果从不被观测）、把钱烧在不会进展的会话上
（没有花费 × 进展分诊）、以及接力 save 依赖的死会话转录从没有人证明过可读
（归档被假定、从未被检查）。施工单
（`content/tech/ai/dsh/tasks.md#revive-v2-probe-statemachine-1116`）把六项
钉在一个包里，fail-closed 首核即施工第一步。

## Decision

六件增量件，全部落在 `packages/dsh-session-revive`（仅宿主面）；裁定账的
参数、名单、状态端点 `quota`/`waves` 与健康面事实一律不动（翻裁项只写档
不改运行时）：

- **fail-closed 首核**（`src/v2-transcript.ts`）：激活时逐帧走读某个已归档
  会话的多帧 zstd 转录（按魔数切帧、坏帧为零、事件至少一条）。无 sessions
  根或空台账按「尚未归档」放行；台账非空但 id 解析不到可读转录即判 FAIL，
  此后每个 v2 入口只吐 `v2-halt` 记录——不开试、不建状态。
- **L2 探针门**（`src/v2-probe.ts`）：用全局 fetch 槽（调度器代理，与真实
  请求同一条出口）GET 当前路由的 provider baseURL。任何 HTTP 响应（4xx/5xx
  也算）都证明路径存活；只有连接层失败才 park。L1 TCP 归因
  （`local-egress-down` 对 `provider-path-down`）只归因、永不放行，也不做
  L3 花钱试探。节奏为事件驱动的 60–120 秒随机，且只在有会话被 park 时进行
  （零 park = 零探针）；`probeRedAlarmed` 的建议值 `N = 2h` 存于
  `PROBE_RED_ALARM_MS`，设计 §八 TODO 仍标 待拍板。
- **三分诊状态机**（`src/v2-machine.ts`）：把 §三 转移表实现为纯类——探针红
  即 park（不开试、零转录事件、按节奏重探）；0-token 失败冷却 10 分钟并记
  strike（3 次停在 `zero-cost-3strike`，归因探针假绿/分类异常）；花钱零进展
  打开结构化原因的归档-接力意图、接力 depth=1（再犯保留现场、停
  `relay-recidive`）；花钱有进展冷却并只批一次补试（再失败停
  `progress-retry-failed`）；任何完成轮清零全部计数。进展是两级布尔（L1 活动
  且 L2 有效），且按实际形态分诊——获批补试死于 0-token 会回到零成本通道。
- **归档-接力-代劳 save 链**（`src/v2-chain.ts`）：转录核验 → 落点解析 →
  结构化原因归档 → 派发接力（种子带 `relayDepth=1` 与代劳 save 第一步）→
  回写台账原因。预检不通在归档之前停链；派发成功后的原因回写为尽力而为。
  链走回环 REST，因为归档与派发是无进程内接口的兄弟插件。
- **假绿/假红保底**：三次连停携带假绿归因；`probeRedAlarmed` 每段超 N 的
  红只报一次；两者都进 §七 导出供告警信箱单读者消费。
- **状态导出**（`src/v2-state.ts`）：`<dsh-home>/session-revive-v2-state.json`，
  change-only（只比 `sessions` 载荷、`at` 随行）、字面 §七 字段集、临时文件 +
  原子改名、尽力而为——状态文件出岔降级为文件缺失，绝不半写。

接线在 `src/index.ts` 全为增量：每条复活判定——live 与 shadow 一律——先进
状态机（只有获批的尝试才发、且只在 live 发）；事件喂入涵盖 turn/end 死亡、
assistant 花费与结构化 refusal 探测、工具活动两半、持久路由与销毁；探针环与
状态机唤醒定时器同乘一个 cordis effect、随其一起拆除。

## Alternatives considered

- **用真实 1-token 调用探针（L3）**：否决——哪怕输入 token 也会在输出上
  计费，而任何 HTTP 响应已经足够证明路径。
- **把 4xx 当红**：否决——401/404 恰恰证明路由在应答；门回答的是「路径活不
  活」，不是「凭据对不对」。
- **不分状态固定定时探针**：否决——设计 §五 要求事件驱动 60–120 秒、零 park
  即零探针。
- **按尝试次数而非实际形态分诊**：否决——设计的纪律句（获批补试死于 0-token
  回到零成本通道）正是为了防「按通道记数」的错账。
- **只在 live 过门**：否决——shadow 必须走同一道门，其证据行才与 live 将要
  做的一致；副作用仍只在 live。
- **在 v2 里重建额度/波/断路器**：否决——翻裁项红线：裁定账是额度唯一来源，
  v2 只负责扣发。

## Consequences

- 只在用户重启 dsh web 宿主后生效：包已重建，但运行中的宿主仍持旧码——重启
  按仓规归用户，AI 永不代启。
- 首核不通期间任何地方都不复活：撕裂的归档转录会响亮停机，而不是冒险做半截
  代劳 save。
- park 在红路径上的会话零事件消耗直到探针转绿；baseURL 解析不出时带
  `route-unresolved` 归因 park，而不是发失败。
- 状态导出是新的双边文件；告警信箱单读者按字面消费 §七 字段集（其侧才容忍
  未知字段）。
- 仓级 `docs:check` / `i18n:check` 目前挂在**其他包**的既有问题上
  （dsh-better-sidebar 词条、dsh-auto-route 配对、dsh-i18n ru 缺键）；本包
  README 对已重录、两份失败清单里都没有本包文件。

## Testing

包级三门：`pnpm typecheck`（exit 0）、`pnpm test`（exit 0——11 个文件、
145 通过，其中 70 条是五个 v2 spec 新增：转移表逐行、首核先于任何尝试的
halt、链顺序与每一处预检停点、§七 字段集、change-only 自证、探针判定/L1
归因/节奏边界）、`pnpm build`（exit 0）。翻裁连带列零删改 grep：policy/
config/health-state/routes/sweep/selflearn 删除行 = 0；v2 源码里
quota/waves 只出现在「声明其未被改动」的合规句中。没有任何测试触碰真实会话
生命周期——沙箱 workspace 规则从未被触发。
