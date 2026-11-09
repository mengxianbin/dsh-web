# Agent Note: 会话身份三值化（human | bot-boss | bot-worker）

Status: implemented

## 问题

2026-10-29 13:53 误归档暴露归档裁决缺「身份」维度：taskbot R16 只看「板行 `[x]` + `running=false`」，把用户正在输入的人工会话 `session-e631dae6` 归档。同日落地的二值 `sessionClass`（`human | bot`）加剧了这一点——bot 值班会话被记成 `human`（「假 human」），按新裁决表字面读会把「继任 boss 归前代」拦死。用户裁定（m-note decision-log 2026-10-29T16:03）：会话分三类（human / bot boss 值班 / bot worker 干活），归档裁决表 = worker 归 boss 裁、boss 归继任 boss 裁、human 归人工裁，无豁免；置顶表 = human + boss 置顶、worker 不置顶。

## 决策

- **`SessionClass` 扩为 `'human' | 'bot-boss' | 'bot-worker'`**（`routes.ts`）。请求体校验接受旧字面 `bot` 并归一为 `bot-worker`——仍在按旧二值 SKILL 文本派发的在途调用方跨重启窗口不受影响；类型本身不暴露 `bot`。缺省仍为 `human`——漏传字段朝置顶方向兜底，不朝沉底。
- **默认置顶改按类判定**：`human` 与 `bot-boss` 置顶，`bot-worker` 取消置顶（`attention.ts` `applyDefault`）。`deserializeAttention` 把遗留 `bot` 行归一为 `bot-worker`，未知类逐行丢弃（单行坏数据不会隔离整个文件）。
- **一套账本答两个问题**：`~/.dsh/session-attention.json` 仍是置顶账本，同时充当归档通道的身份表。dsh-session-archive 插件读它执行归档裁决硬闸（`actor` 字段与逐 id 闸见该包随批 Agent Note）。
- **调用方约定随类型同步**：taskbot 派任务声明 `bot-worker`，轮换/看门狗接管值班声明 `bot-boss`，人工发起省略字段（m-note `dsh-session-dispatch`/`taskbot` skill、`scripts/dsh/dispatch-send.mjs` 第 4 参、`scripts/taskbot/taskbot-watchdog.mjs`——m-note 侧同批改）。

## 备选与否决理由

- **保留二值 + 另加值班标志**：否决。一个身份问题两套事实源；裁定要求置顶 pass 与归档闸读同一本账。
- **请求体直接拒旧字面 `bot`**：否决。按旧 SKILL 文本运行的在途 taskbot 会话在本次安装到下次轮换之间每次派任务都会吃 400；别名让过渡窗口零中断，新会话自然读到新字面。
- **每次启动重扫补置顶**：既有一次性默认裁定已否决，本批不改——`bot-boss` 只改变 pending 默认重试时按哪个类执行。

## 后果

- 闸的强度依赖账本覆盖率：无记录会话按 `human` 计，未入账的 bot 值班会话在补账/声明前是漏向——m-note 批内含对存活 boss 会话的一次性补账。
- 仍传 `bot` 的调用方写入 `bot-worker` 记录——语义正确（bot 派发的任务工作），调用方零改动。
- 重启前的旧运行时二进制把 `bot-boss` 判为非法；调用方在重启窗口前切到新字面会吃 400（已接受：值班派发低频，且重启是已声明的人工交接点）。
- 无 UI 徽标，效果仍只有置顶排序 + 归档闸。

## 测试

`tests/attention.spec.ts` 在原 16 例上新增 3 例（遗留 `bot` 行归一、`bot-boss` declare 置顶、pending `bot-boss` 重试置顶且类不降级）；`tests/routes.spec.ts` 校验例改写为三字面 + 旧别名，并新增 `bot-boss` declare 先于 prompt 一例（共 56 例）。包级 `typecheck`、`vitest`（87/87）、`verify-docs.mjs --write` 重录 README 配对均通过（2026-10-29）。
