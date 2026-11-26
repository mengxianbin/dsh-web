# fsm-rebind-1126 施工进度账（dsh-web 仓）

> taskRef = `content/tech/ai/dsh/tasks.md#fsm-rebind-1126`（父单 `#fsm-dispatch-1125` 分期④ 子单）
> 规格单源 = m-note 设计档 `fsm-dispatch-design-1126.md` §3.1 / §3.2 / §1 P2
> worktree = `.wt/fsm-rebind-1126`，分支 `local/fsm-rebind-1126`，基线 `dev @ 36c652eb5`
> 日期 = 2026-11-27（系统时间实读 `date`，CST）

## 一、环境准备

| 步骤 | 命令 | 读数 |
|---|---|---|
| 建 worktree | `git worktree add -b local/fsm-rebind-1126 .wt/fsm-rebind-1126 dev` | exit 0（仓内约定 = `dev` 集成基线 + `local/<slug>` 分支，13 个既有 worktree 同构；任务书字面 `main` 本仓不存在） |
| 装依赖 | 重型闸 `heavy-io-gate.ts "pnpm install --prefer-offline"` | `INSTALL_EXIT=0`（2m49s；裸发被矩阵 10 拦，改闸排队） |

## 二、三件施工 + 每步读数

### ① rebind 端点 `POST /api/task-fsm/rebind`（判据 1/2/3）

- `src/host/routes.ts`：三段式——Phase A 只读前置校验（存在 404 `not-found` / A 非终态 `a-terminal` / 双向唯一 `dual-bound`，线性反查 = `GET /session?id=` 口径内联）→ 拒即零写入；Phase B §3.2 seal-check 硬拦（挂点 = `store.update` **之前**，`DONE|N_A` 放行 / 其余 `seal-required` 带 verdict+detail；`force+forceReason` 同在才跳过判读且入 A history）；Phase C **一个** `store.update()` 内复校（TOCTOU）+ B 绑 `session{id,mode:'active'}` + `rebind-in` + A **直删** `session`（⛔ 不复用 `sessionMode:'cleared'` 效果）+ `rebind-out`（forced 加 `kind:'forced'+forceReason`）。409+kind+detail 照 `fsm.ts:29-44` 形；`from===to` → 400。
- seal-check 通路 = `FsmRouteServices.sealCheck` 可注入缝（archive-leg fetchImpl 同形），缺省 = loopback `POST /api/dsh-session-archive/seal-check`（现成端点零重造），读不到/非 200/体畸形 → `UNKNOWN`（查不清即拦）。
- `src/core/schema.ts`：`HistoryEntry.event` 扩 `RebindEvent`（`rebind-in`/`rebind-out`，⛔ 不入 `EVENTS`/`EVENT_LABELS` 轴封闭）+ 可选 `kind:'forced'`/`forceReason`；`HistorySchema`/`parseFsmFile` 语义检同步（E99 仍拒，schema-store.spec 绿）。`src/core/subreason.ts`：标签回退（rebind 伪事件不出现在 `EVENT_LABELS`）。
- 测试靶 `tests/rebind.spec.ts`（新，10 用例）：`CountingStore`（真 store 子类计数，非 spy）断言单文件一次写。
  - 读数：`pnpm vitest run tests/rebind.spec.ts` → **10 passed**；全包 `pnpm test` → **Test Files 13 passed / Tests 138 passed**（12 存量 + 新增 1）。
  - 判据 1 四拒：dual-bound×2（B 他绑 / 本会话他任务）、seal UNSEALED（force 无 reason）、a-terminal、404 not-found×2 —— 各断言状态文件字节不变 + saves 不增。
  - 判据 2：`DONE`/`N_A` → 200（并断言 seal 收到 `ids=[A的sessionId]`）；`UNKNOWN`/`PENDING` → 409 `seal-required` 且字节不变；另加缺省 loopback 打不通 → `UNKNOWN` fail-closed 实测。
  - 判据 3：`force+forceReason` → 200，A history `rebind-out` 带 `kind:'forced'`+原因（盘上 JSON 同断言）。

### ② G2 改读 FSM（判据 4）

- `src/host/sources.ts`：`countLiveBindings()` **退役**（快账/workspace.json 读全删，`liveBindings` 全仓 grep 清零）→ `countLiveTaskSessions(file, taskRef)`：`state ∉ {done,cancelled}` ∧ `session.id 非空字符串`；state 读不到/非六态 → `NaN`（fail-closed 照现形）。`makeHostDeps` 接线 `liveTaskSessions`。
- `src/core/guards.ts`：`GuardDeps.liveBindings` → `liveTaskSessions`；`g2TaskRef409` deny 文案 = 「FSM 记录有 active 会话（409 防双跑）」，NaN → 「FSM state 读取失败（fail-closed）」。
- 测试靶：`tests/guards.spec.ts`（G2 三态经真 `makeHostDeps`，13 用例）+ `tests/e8-route.spec.ts`（路由级：E1 遇 active+绑定 → 409 guard G2 且字节不变；id 空 → 放行）；`tests/fsm.spec.ts` 仅键名×3 机械改。
  - 判据 4 三态读数（tsx 实跑）：
    ```
    active + session.id 非空   ok=false | FSM 记录有 active 会话（409 防双跑）
    backlog 无 session         ok=true  | FSM 记录无 active 会话
    done 终态 + session.id     ok=true  | FSM 记录无 active 会话
    active + session.id 空     ok=true  | FSM 记录无 active 会话
    state 读失败（42→NaN）     ok=false | FSM state 读取失败（fail-closed）
    ```

### ③ 派发口闸① 改读 FSM（判据 5）

- `src/host/fsm-seam.ts`：`FsmStateBody` 增 `session.id`；新增 `fsmLiveGateOf()` 三态判读（`live`/`clear`/`unreadable`），六态字面镜像（跨包零 import，同 PLAN_PATTERNS 两处字面同步口径）；`recordStateOf` 分流通路不动。
- `src/host/routes.ts`：闸① 从 `bindings.findAlive`（fail-open）改为 `fsmSeam.get(origin,'state')`——`live` → 409 **响应体形状不变** `{ok:false, error, taskRef, sessionId}`（error 文案逐字不变，消费方 dispatch-send.mjs 零改）；`unreadable` → **503 fail-closed**；`clear` → 放行建会话。读面挂点 = `seam !== undefined`（豁免合成锚/boss 派发零 FSM 请求保持）；`runQueued` 条件改 `bindings || fsm`；G2 hint 文案同步「FSM 已有 active 会话」。
- ⛔ `bindings.record`（:487-509）、`GET /bindings`、`DispatchBindingStore.findAlive` 接口与实现、`bindings.spec.ts` 本单一律未动（快账归 `#bindings-retire-1126`）。
- 测试靶改写：`tests/routes.spec.ts`（live→409 / 读失败→503 / absent·terminal→放行 / 序列化败者 409 = 状态机真缝假体）+ `tests/fsm-seam.spec.ts`（真路由×真 store：活记录 → 闸 409 零 create；清 id → 幂等分流，`GET state` = 闸读 1 + 分流读 1）。
  - 读数：`pnpm test` → **Test Files 8 passed / Tests 176 passed**；`pnpm typecheck` → 绿。
  - 判据 5 贴 JSON 见「四、验收读数」。

## 三、全量机检读数

| 门 | 命令 | 读数 |
|---|---|---|
| typecheck | `pnpm -r typecheck` | exit 0（30 包 `typecheck: Done`） |
| 本单两包回归（判据 6） | 各包 `pnpm test` | `dsh-task-fsm` **13 文件/138 测试全绿**（12 存量 spec + rebind 新增）；`dsh-session-dispatch` **8 文件/176 测试全绿** |
| 全仓测试 | 重型闸 `pnpm -r --no-bail test` | 25 包 Done / 5 包 Failed → 逐包串行复核定性：`remote-web-ui` 56/56 ✓、`session-archive` 31/31 ✓、`task-board` 105/105 ✓（三者 = 并行负载 flake，串行全绿）；`win-bash` 2 failed = **本机 bash 5.3.9 vs 测试钉 5.3.15 环境版本漂移**（包代码 git diff 空 = HEAD 原样，零关联）；`better-sidebar` 后台单跑取证中（其首跑并行失败疑被 pnpm 自动改写干扰，见「五、环境注记」） |
| test-standards | `node scripts/test-standards.mjs dsh-task-fsm/tests dsh-session-dispatch/tests` | 51 组 = dev HEAD 存量债同红（基线 2026-10-19 后未再录，HEAD 即红非本单）；本单触点**零增长**：`rebind.spec` **0 违规**（新文件零基线全规则绑定）、`guards` 12→10、`routes` 75→71、`fsm-seam` 5→4、`e8-route` 3→3 |
| oxlint | 重型闸 `npx oxlint --deny-warnings`（本单 4 路径） | 8 题 = dev HEAD 存量基线（上单合入随注「oxlint 8 错基线同红非本单」）；本单新增 5 题已修（schema 死变量 + rebind await-in-loop×4） |
| docs | `node scripts/verify-docs.mjs` | exit 0（all documentation gates passed） |
| i18n | `node scripts/i18n-audit.mjs --check` | exit 0（19 namespaces / 1758 zh = 1758 ru） |

## 四、验收读数（判据 1–5 汇贴）

- 判据 1/2/3 断言输出 = `rebind.spec.ts` 10 用例全绿（上表）；happy path `saves diff === 1`、四拒 + UNKNOWN/PENDING 字节断言均在用例内。
- 判据 4 三态读数 = 上「②」代码块。
- 判据 5 409 响应体（实贴，形状 = `{ok:false, error, taskRef, sessionId}` 四字段逐字不变）：

```json
{ "ok": false, "error": "taskRef already has a live session: session-live", "taskRef": "board.md#item-1", "sessionId": "session-live" }
```

- 判据 5 读失败 503（fail-closed 实贴）：`{ "ok": false, "error": "fsm state unreadable (fail-closed): GET state status=0", "taskRef": "board.md#item-1" }`
- 判据 6 = 上表两包全绿计数。

## 五、环境注记（卡点记档，不硬闯）

1. `pnpm -r test` 并行负载下 4 包 flake（超时/EEXIST 撞临时目录），串行全绿——性能敏感用例与并行互斥，属环境敏感非代码回归。
2. `dsh-win-bash` 2 用例在本机恒红：钉 `5.3.15(2)-release`、本机实测 `5.3.9(1)-release`（环境版本漂移，包 = HEAD 原样）。
3. pnpm v11 跑 `better-sidebar` 测试触发 `verify-deps` 自动改写其 `pnpm-workspace.yaml`（allowBuilds 占位）+ `pnpm-lock.yaml`（万行）——**已 `git checkout` 还原**；此为工具副作用非本单产物，提交前须再核 `git status` 干净面。
4. 重型闸排队实录：`oxlint`/`pnpm test`/`pnpm install` 裸发均被矩阵 10 拦 → 全部改走 `heavy-io-gate.ts`（等待实录 `waiting for pnpm -r --no-bail test (pid 45776)`）。
5. test-standards 存量债 51 组为 2026-10-19 基线后累积（HEAD 即红）；⛔ 不重录 baseline（全仓债入册属他单/仓级动作，本单只保证不增）。

## 六、已排除清单（本单⛔ 边界，逐行留痕）

1. ⛔ `bindings.record` 端点与快账写入零改（退役归 `#bindings-retire-1126`，先立后破）。
2. ⛔ `GET /api/session-dispatch/bindings` 端点零改（同上）。
3. ⛔ `DispatchBindingStore.findAlive` 接口、`bindings.ts` 实现、`bindings.spec.ts` 零改（本单只摘路由调用点）。
4. ⛔ dsh web / host 不重启（改码 + 测试绿即收，生效等重启 = 归人）。
5. ⛔ m-note 仓零写（task-status 字段错位对齐归 `#fsm-hook-scope-1126`；本单只在收口时翻板行）。
6. ⛔ G3 scope 闸、`create` 端点、E1 主流程逻辑零改（只换 G2 数据源；E1 hint 文案同步不算流程变更）。
7. ⛔ ask 三选 UI 归调用方后续接线（本单只做 API 数据面，`force`/`forceReason` 字段可表达）。
8. ⛔ `EVENTS`/`EVENT_LABELS` 事件表零扩（`rebind-in`/`rebind-out` 不入 E1–E21，轴封闭；E99 拒仍绿）。
9. ⛔ `sessionMode:'cleared'` effect（`fsm.ts:112-114`）不动（rebind 端点内直删 `session`，不复用该分支）。
10. ⛔ archive seal-check 判读实现零改（复用现成端点 + verdict 词表，⛔ 不重造哨兵判读）。
11. ⛔ `scripts/dsh/dispatch-send.mjs` 零改（409 响应体形状不变即零消费方改动）。
12. ⛔ test-standards baseline 文件不改（存量债归仓，本单只保证触点零增长）。
13. ⛔ 零新定时器/轮询（seal-check = 事件触发一次性 loopback fetch，可用性四问①②）。
14. ⛔ 第二状态文件零建（一切读写仍落 `~/.dsh/task-fsm-state.json` 单点，`CountingStore` 只是计数子类不换存储）。

## 七、设计取舍实录（偏离/歧义处，供验收对照）

1. 单事务拆三段：seal-check 为 async HTTP，`store.update` 为同步临界区——设计 §3.2 明文「挂点 = store.update **之前**的前置校验段」，故 A 段校验与 B 段 seal 在 update 外（拒 = 真零写），C 段 update 内复校防 TOCTOU（复校拒时 save 为字节不变的空转，e8-route 既有同型断言佐证）。
2. 「A 的 sessionId」= A 记录 `session.id` 非空时取之，A 无绑定退回 payload `sessionId`（切单发起方）。
3. `force` 生效条件 = `force===true && forceReason 非空`（force 无 reason 照常走硬拦，判据 1 字面）；forced 留痕在 force 声明时即记（不预读 seal verdict——强制切语义 = 调用方声明绕过）。
4. schemastery 解析会把缺省 `session` 物化为 `{reason:''}`（id=undefined）——绑定判读一律按「`session.id` 为非空字符串」，与 G2/闸①「活」口径逐字同源；A 解绑后盘上无 `session` 键，reload 物化无 id 节点，G2 判无绑定。
5. 闸① 读面挂 `seam !== undefined`（planSeam run 才读）：豁免派发（无 `#` 合成锚 / bot-boss）零 FSM 请求保持（fsm-seam.spec 既有断言不破）；`services.fsm` 未组合 = 缝关（seam 模块既有可选契约，生产 index 恒挂载）。
6. 双向唯一 ②：本会话绑着的**其他**非终态记录（含 B 自身已绑本会话）即拒——只跳过 from；重复提交同单会 409 `dual-bound`（fail-closed，非幂等承诺）。
