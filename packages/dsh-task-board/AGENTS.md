# AGENTS.md — dsh-task-board

dsh Web GUI 的 Host 权威多列任务看板。任务通过真实 DSH 会话执行，浏览器只负责异步展示与提交动作。

## Host 账本、执行与调度

- 权威账本固定为 `$DSH_HOME/task-board/ledger-v2.json`（文件名为历史沿用），当前 schema 为 `{ schemaVersion: 6, revision, tasks, scheduler }`；旧 v2/v3/v4/v5 文档在 Host 启动时逐字段无损迁移为 v6 写回（v4 为 `ScheduleRule.timeZone` 盖章 Host 时区，v5 加执行验收块，v6 加调度计划类型与次数预算），迁移失败必须明确报错且保留原文件（不静默清零）；写入必须保持临时文件加原子 rename、损坏文件隔离和 revision 单调递增。
- 浏览器 `dsh.taskBoard.v1` 只用于一次性导入且必须保留；导入 marker 只能在 Host 确认后写。所有生产变更走 `protocol.ts` 的严格同源 action 协议，UI 不得先写未确认状态。
- 手动与 cron 统一走 `HostExecutionRunner`。钉住的 workspace、agent preset、permission 任一失效都在任务 Prompt 前 fail closed；未钉 workspace 且部署没有可解析的工作区时同样拒绝（原因写明「在卡片上选择工作区」，由浏览器半区按语言渲染），不把决定交给 `session.create` 的进程工作目录兜底，因此空 registry 的新部署需要先建/选工作区才能跑未钉住的卡片；默认每次 execution 创建独立会话，任务开启 `reuseSession` 后可复用上一次会话——复用条件由 `core/session-reuse.ts` 唯一裁定：上一执行已结算、该 session 仍在名册中且空闲（名册未知一律不复用），复用时重新应用钉住的 permission/model 再入队 Prompt，不重命名、不新建。名册由这次启动自己读取（`reuseSessionFor`），不沿用轮询缓存：空闲看板不轮询后，缓存的名册可能已经过期。命令派发（`/permission`、`/goal`）在目标会话尚未进入内存 `ctx.agents` 时经 `sessionController.resolveAgent` 按需唤醒持久化冷会话（issue #1861），与紧随其后的 `session/selectModel`、`session/prompt` 激活策略一致。
- 会话名册只在看板确有需要名册裁决的事情时读取（issue #1821）：`HostTaskLedger.runtimeView().needsSessionState` 为真，即存在待核对的执行，或运行列里有一张卡片（其结算可能来自本进程未观测到的写入）。空看板、无运行中卡片、无未结算执行、无已启用计划时不轮询，Host 不重建持久化会话行。节奏由配置项 `sessionPollSeconds`（默认 5，1..300，volatile，范围与换算的唯一来源是 `src/core/poll-cadence.ts`）决定；一轮读不到名册（抛错或 `known: false`）按翻倍延迟退避、上限一分钟，可读即清零，因此会话树故障时不会被按轮询间隔反复冲击。该闸门刻意不查扩展注册表：提供方能力面（`TaskBoardExtensionHost`）不含任何会话能力，把扩展算进来只会削弱修复。
- 目标执行由**全局总开关**与卡片的 `goalRun` 两级决定，两者都必须「要」：配置项 `goalRunEnabled`（volatile，默认 **false**）在读一次、按值带入 runner，因此实时改动只影响之后新开的执行；卡片级 `goalRun` 默认**关**，只有显式 `true` 才加入（缺席与 `false` 同样只跑单回合，从未动过该选项的旧卡片因此保持单回合）。两级都满足时 runner 才先入队 Prompt，再在同一会话执行 `/goal <组合 Prompt>`（目标文本经 `goalObjective` 规避 `/goal` 自身的关键字语法）；总开关关闭、卡片未加入、`/goal` 被拒或部署没有命令派发器时只告警并照常按单回合执行。总开关关闭导致的单回合执行记录为独立适用性 `goal-disabled`（不同于 `/goal` 被拒的 `goal-unavailable`）：既不算已验收通过，也不因缺少完成调用判失败；界面上的卡片级勾选框**始终可操作**（仅执行中 pending 时禁用），总开关关闭时只说明其暂不生效，绝不改写卡片已存的 `goalRun` 偏好。目标存活期间 `inspect` 读 `session/projections` 判定：目标 `active` 保持 pending、`blocked` 以目标自身原因判失败、`complete`/`paused`/无目标沿用回合判定；读取失败回退回合判定并告警，不得让读失败永久挂住执行。
- 交接包三元组在执行时覆盖普通钉住字段；有效权限高于权限基线的绑定必须先经 `confirm-permission` 动作人工确认（变更即重新武装），未确认卡片手动执行拒绝、cron 跳过并滚动 `nextRunAt`。基线取配置键 `sessionDefaultPermission`；未设置时跟随宿主自己的默认权限预设（可选服务 `permissionPresets` 的 `catalog().defaultPreset`，即 DSH 新会话的起始权限），按次实时读取，因此宿主设置变更无需重挂载即生效；部署不提供该服务、或它的默认值不是三种沙箱模式之一（如仅限当前会话的 `auto`）时回退 `read-only`。
- cron 使用规则自身的 IANA 时区（`ScheduleRule.timeZone`，缺省跟随 Host 时区）：墙上时间由 `core/schedule.ts` 经 `Intl.DateTimeFormat` 在目标时区解析，夏令时空洞跳过、重复时刻取更早者；日期/星期遵循 Vixie 语义（两个字段都受限为 OR，其余组合为 AND）。账本 schema v4 迁移把 Host 时区盖到未存时区的规则上，使既有规则的触发时刻不随 `TZ` 变化移动。Host 首启或长暂停后的过期出现全部跳过；同任务 running 时不排队、不并发，只滚动下一触发点。
- 调度规则有两种计划（`ScheduleRule.mode`）：`cron` 为循环（`cron` 表达式 + 可选 `maxRuns` 上限，缺省不限次），`once` 为单次（`at` 一个未来时刻，隐含预算 1，不写 cron）。预算由账本内部唯一写入者执行：`openScheduled` 对已用尽的规则拒绝开启，并在同一笔原子提交里把 `runCount` 加一；已到达上限或一次性执行后规则自行 `enabled=false` 并记 `endedReason`，不依赖执行 agent 自关闭。计次只按调度器真正开启的执行（人工执行不消耗、失败不自动补跑）；权限未确认、卡片 running、计划无可达时刻、停机错过时刻都不消耗次数，只记 `skippedReason` 或终态 `endedReason`（一次性错过即 `missed` 终态、不补跑）。重新启用已停止的规则或切换计划类型会重置预算，编辑在跑规则的表达式/时区/上限保留已消耗计数。详情页与新建对话框提供计划类型、带时区时刻、次数上限、已执行/剩余与结束状态，并提供显式取消。
- 重启恢复时，有 session id 的 running execution 继续观察；无 session id 的启动中断标为 cancelled，禁止自动重发。启动恢复与每次会话轮询都会先折叠已可裁决的运行：历史账本里残留的团队执行按 Lead 判定收口，成员全部结算的父子链一并终结（幂等，已折叠的运行不再写入）。会话历史读不到的 execution 不再等同「仍在进行」：名册已判定该会话空闲后仍连续读不到历史达到上限（24 次轮询，约 2 分钟）即带原因判失败，避免无限 pending 把卡片永久留在运行列。
- 子任务层级由 Host 唯一裁定：`TaskRecord.parentId` 的深度上限是配置项 `maxSubtaskDepth`（1..3，默认 1），创建、`set-parent` 关联与导入修复共用 `src/core/subtask.ts` 的存在性/环/深度判定，浏览器只据此启停控件。一次执行开几个会话与树深无关：单卡执行只开它自己一个会话，子任务由这个会话自行派发（见上节「父卡自治派发」）。权限门只看被运行的那张卡自身解析出的绑定：父卡不因子卡钉住未确认的高权限被拒，因为子卡根本不启动；子卡自行执行时，继承来的权限仍按祖先链解析，并连同提供它的祖先的人工确认戳一起过确认门，而权限绝不在创建时复制到子卡卡片上，workspace/模式/模型按用户看到的预填值存卡。配置项 `runLaunchWidth`（1..16，默认 3，volatile，范围与换算的唯一来源是 `src/core/launch-width.ts`）只决定多张卡同时要执行时，同一刻最多几个执行被准入创建会话，其余排队：队列在 run group 之间轮转、组内 FIFO，排队中的 execution 若已被结算则不再启动，Host 停止时仍在排队的执行记为 `cancelled`（退回调度次数，与中断恢复同义）；单卡执行只开一个会话，所以它不改变单卡的执行形态。已在运行的任务不进入新的 run group（cron 同样），且运行中的参与者不能被 `set-parent` 改挂或解除关联——它的链接可能仍是某个运行中 run group 的父指针。

- 新建卡片的执行目标默认值由看板设置卡的「新建卡片默认值」专题给出，四个键 `cardDefaultMode` / `cardDefaultPermission` / `cardDefaultModel` / `cardDefaultReasoningEffort` 都默认空 = 不设置，且都是 volatile：改动即时生效、只作用于之后新建的卡片，留空时创建行为与未配置一致。它们只是预填，不改变任何既有语义——取值优先级为「新建对话框的显式选择 > 复制卡片的源卡或新建子任务的父卡已钉住的值 > 看板默认值」，父卡权限永不参与（权限不在创建时复制到卡片上，见上一条）；思考档位默认值只在卡片最终钉住的模型就是 `cardDefaultModel` 时才生效，未配置默认模型时失效；高于会话权限基线的默认权限仍只是预填，执行前的人工确认门照旧。Host 创建路径按 opt-in 补齐：创建动作带 `applyCardDefaults: true` 时只填调用方没有给的值，目前由 `task_board_create` agent 工具设置；扩展提供方的 `tasks.create` 与旧数据导入不传该标志，行为不变。契约见[新建卡片默认值决策](../../.agents/notes/implemented/feature/2026-10-14-task-board-new-card-defaults.md)。

- 思考档位的模型绑定、清空与继承以[思考强度决策](../../.agents/notes/implemented/feature/2026-10-11-task-board-reasoning-effort.md)为准。

## 父卡自治派发

- 执行一张卡片只开它自己一个会话：父卡执行不为任何子任务创建 execution，子卡也不进入运行列，这次运行开出的 run group 恒为单成员。直接点某张子卡执行时它自己就是这次的 root，照旧单独开一个会话——即使它有父卡、自己也有子任务，也不展开。
- root 存在未完成后代时（任一后代不在「完成」列且未归档，口径唯一来源是 `src/core/subtask.ts` 的 `hasOutstandingDescendants` / `outstandingDescendants`），这次执行在启动时强制改用 `LIANGSHEN_PRESET_ID`（`liangshen`，梁神模式，预设来自 `packages/dsh-liangshen`）：这是执行时的覆盖，绝不写进卡片的 `mode`。强制生效时跳过 session 复用、新开会话。部署没有注册该预设时 fail closed：卡片进失败列，原因写明缺少 `liangshen` 预设。没有未完成后代的卡不受影响，执行形态与平常一致。
- 启动 Prompt 多一段派发指令：列出各未完成子卡的标题、任务 id 与状态，说明本次不为它们额外开会话，要求先用 `task_board_get` 读子卡，再用 `subagent` 按依赖顺序派发（互不依赖的可以并发），完工前用 `task_board_manage({action:'record-external-outcome'})` 一次性回填结论。
- 结论兜底：root 自身执行终结时，对本次运行仍未回填、且属于 root 未完成后代的卡片，Host 写一条 external 记录（`initiatedBy` 前缀 `parent-run:`，说明「本卡未单独开会话执行、结论继承自父卡运行」）。同一张卡已有本 run group 的 execution、仍有未结算执行、或已有更晚的终态记录时跳过，因此幂等；`cancelled` 的父判定不写。
- 为什么这样定：子任务之间有串行依赖，Host 侧并发开会话只能把依赖顺序变成运气；Agent Team 的 teammate 同样是一次性全派生，解决不了串行，还在看板上多压一层语义。因此该模式整体退役：协议的 create/patch 团队字段、快照里的团队可用性标志、agent 工具的团队运行参数、团队 provider 配置项与 Host 侧 `spawnTeammate` 调度面全部移除；`TaskRecord.teamRun` 只为读历史保留，不迁移、不写新值。
- 历史账本里已有的 team run group 仍要能收口：启动恢复与每次会话轮询先折叠已可裁决的运行——Lead 已记录自身结果时，Team 仍挂着的成员一并按 Lead 判定结算；成员全部结算的父子链一并终结。折叠幂等，已折叠的运行不再写入，因此旧运行不会挂死。

## Agent 工具面

- 八个模型可见工具 `task_board_list` / `task_board_get` / `task_board_create` / `task_board_update` / `task_board_set_parent` / `task_board_run` / `task_board_manage` / `task_board_schedule` 定义在 `src/host/agent-tools.ts`，经 `ctx.tools.register` 注册。它们只调用同一个 `TaskBoardHostService`（账本 action + 快照），不复制业务规则：fail closed 钉子、权限确认门、子任务深度门禁、运行中任务锁在工具面全部照旧生效。`task_board_manage` 另有 `settle` 动作：把看板已无法观察的运行中卡片（含它辖下的成员 execution）强制结算为 cancelled，原因里记录调用者，卡片回到待办列，供人工/agent 解卡——移动、归档、删除都拒绝运行中的卡片，这是运行中卡片此前唯一的出口。
- 注册跟随 `enabled` 主开关（关闭时不注册）；工具注册表按可选服务解析而不写入 `inject`，因此运行时不提供注册表的部署仍会挂载看板，只失去工具面（与可选 `llm` 的容忍度一致）。
- 析构只释放、不重注册：cordis 在 fiber 运行 disposer 前先标记 UNLOADING，届时 `Fiber.effect` 拒绝任何新注册，所以 `setToolsEnabled(false)` 不碰扩展工具注册表（只有启用路径重绑），`syncTools` 也把 `INACTIVE_EFFECT` 视为「宿主正在退场」而不上报——其他拒绝仍按 error 记录。提供方的 `active` 是「看板 x 扩展」这道闸，不是宿主生命周期，两者不可互相推断。
- 刻意不提供 `confirm-permission`：高于权限基线的绑定只能由人工在界面确认。工具面同样不接受命令、可执行路径或 shell 文本。
- 工具描述是面向模型的英文文案（含中文触发词），不进 locales 字典；领域拒绝以 `ok:false` 值返回，便于模型自行纠正。

## 外部提供方扩展契约

- 看板声明三个子席位 `task-board.detail.section`（props `{ task, dispatch }`）、`task-board.settings.section`（props `{ dispatch }`）、`task-board.card.decoration`（props `{ task }`）；注册组件在 `register` 选项声明 `children` 并在组件内用 `renderSlot` 消费，经内部 React context 穿透到详情页、设置卡与卡片；跨包扩展只在自己包内同形 `declare module` 声明这些键，不得 value import 看板。看板不再出现提供方名字：`src/tool-surface.ts` 是 `scripts/sync-shared.mjs` 生成的副本，家族 tool-section 顺序表只登记宿主插件的 order，外部扩展用家族自己的 `EXTENSION_TOOL_SECTION_ORDER` 槽位排在宿主之后，因此副本里没有提供方 id；`grep -rn github packages/dsh-task-board/src` 为 0。
- host 与 client 各发布一份 cordis 服务 `taskBoard`，API 版本常量为 `TASK_BOARD_API_VERSION = 1`；provider 按该常量协商，版本不匹配即可见拒绝，且不影响看板继续服务。
- provider 只见宿主能力面 `tasks.{ list, get, create, patchContent, setStatus, linked }`、`integration.{ read, write }`、`events.{ onStatusChanged, onExecutionSettled, onTaskDeleted }`、`publish`、`registerTool`，以及客户端能力面 `dispatch` / `registerVisibility` / `subscribe` / `snapshot`；`HostTaskLedger` 不进服务面。
- 载荷不透明：`TaskRecord.integrations` 是 `Record<string, unknown>`，只校验纯 JSON 对象且单条不超过 64KiB；协议只有泛化的 `{ kind: "extension-action", extensionId, action, taskId?, payload? }`；快照只有 `extensions?: Record<string, unknown>`；不做账本 schema 迁移，远端语义的归一化不再被看板核心引用。
- 不变量由看板上收执行：`patchContent` 复用 `canEditTaskContent`（执行过或已归档的卡内容冻结）、`setStatus` 走既有列与权限门禁、事件回调 try/catch 隔离且绝不打断执行；远端身份的索引归 provider，看板不提供 `findTaskByGitHubIdentity` 或 `updateTaskIntegrations`。
- 开关三态：loader 行禁用（需重启，最重）> 扩展 `enabled`（volatile，默认 true，即时惰性：停轮询、停写回、注销工具、撤下详情区与徽章，不清数据）> 看板总开关；扩展的设置区块必须保持可达（它是重新开启的地方），只收放其中的配置表单。契约全文见 [Agent Note](../../.agents/notes/implemented/architecture/2026-09-30-task-board-extension-contract.md)。

## 电源保护

- `preventIdleSleep` 默认 `false`。开启后，全部 DSH running session、任一已启用 cron 或未知 session 状态都构成持锁理由；仅在已确认无运行会话且无计划时释放。
- macOS 只允许 `/usr/bin/caffeinate -i -w <pid>`；Windows 只允许从 `SystemRoot` 解析的 Windows PowerShell 固定 helper 和 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`。Linux 只允许绝对路径 `systemd-inhibit` 的 `idle`/`block` lock，不得请求 `sleep`、显示器或 lid-switch inhibitor。
- helper 必须 `shell: false`、固定参数、不依赖 PATH、失败有界退避，并在设置关闭、插件卸载和 Host 退出时清理；不得修改电源计划或要求管理员权限。无 systemd-logind 的 Linux 和其他平台只报 `unsupported` 或可见错误。

## 文件归属与测试

- Host 协议、账本、runner、scheduler 编排和 power 状态机放 `src/`；浏览器 transport 与 UI 放 `src/client/`；纯 cron、任务转换与子任务层级规则（`src/core/subtask.ts`）留 `src/core/`。
- Host 功能只依赖官方 `@deepseek-ai/*` NPM SDK，不得导入 DSH 源码。`src/dsh-home.ts` 与 `src/loopback.ts` 是 `shared/host/` 经 `scripts/sync-shared.mjs` 生成的副本，禁止手改。
- 变更账本、协议、runner、cron 或 power 时补对应单测；原生 helper 只在 `DSH_POWER_SMOKE=1` 且平台为 Windows/macOS/Linux 时运行 smoke，Linux 无可用 logind system bus 时显式跳过原生部分。

## 提交前检查

```sh
pnpm --filter @linxin666/dsh-client-ui-task-board typecheck
pnpm --filter @linxin666/dsh-client-ui-task-board test
pnpm --filter @linxin666/dsh-client-ui-task-board build
pnpm docs:check
```
