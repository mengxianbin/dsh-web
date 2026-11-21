# Agent Note: 每个标签一个 Host PTY 的 SSH 终端多标签（issue #1950）

Status: implemented

## 问题

SSH 面板只能显示一个远程终端：`PanelController` 只持一个 `terminalSessionId`，
`TerminalTab` 只构造一个 xterm，每次连接都会替换掉屏幕上的内容。运维同时在多台服务器
上工作时，要么让一个标签在无关主机之间来回切换，要么离开面板。Host 侧的能力本来比视图
多：`engine/terminal-sessions.ts` 按 id 存活会话、保留有上限的滚动缓冲、支持
`detach`/`attach` 并在重新连接时回放——这正是标签条需要的东西。

社区分支（`AbelKeithsun/dsh-web` 的 `feat/ssh-terminal-tabs`）实现了这个功能，也演示了
把标签条硬接到单会话视图上会出什么问题：连接还没报出会话 id 时切走，会在 Host 上留下
无人认领的 PTY；切标签会丢交互式验证提示；远端退出会删掉标签并让空态占位盖住最后一屏；
从主机页连接后终端工具栏的下拉框不跟随；后台关闭静默失败；新增文案缺俄语键。本次改动
实现该功能，并把这些失败形态去掉，而不是照搬。

## 决策

面板保存标签记录而不是 socket，并且同一时刻只显示一个 xterm。标签状态（别名、Host 会话
id、状态、待答验证提示、关闭失败）存在 `panel/controller.ts`；视图
`panel/TerminalTab.tsx` 只持有一个 xterm 实例与一份输入订阅，切换标签是重绑这一个终端，
不是叠终端。Host 协议与 `engine/terminal-sessions.ts` 不动：打开、detach、attach 都是
既有的帧。

### 状态机

标签有四种状态：`connecting`（socket 已开、尚未拿到会话 id）、`connected`（Host 已报
会话 id）、`exited`（远端 shell 结束）、`error`（连接失败）。每次迁移一条规则：

| 事件 | 动作 |
| --- | --- |
| 连接 / 「+」/ 主机页连接控件 | 新增一个标签并设为当前，视图为它开一条 socket |
| ready 帧 | 记录会话 id，状态转 `connected`，清掉待答提示 |
| output 帧 | 写入唯一 xterm，并追加到该标签保留的画面 |
| auth prompt 帧 | 存到承载它的那个标签上，与是否为当前标签无关 |
| 切到别的标签 | `connected` 只 detach（Host 保活并保留滚动缓冲）；`connecting` 交接给
controller 认领，不 detach |
| 切回来 | `connected`：按会话 id 做一次 `attach`，Host 把滚动缓冲回放进已 reset 的
xterm；`exited`/`error`：重绘保留画面，不开 socket |
| exit 帧 | 状态转 `exited`，清会话 id，保留标签与画面，禁用输入 |
| 关闭当前标签 | 用它自己的 socket 发 `close`（仍在 connecting 时以 `close` 意图交给
controller 认领） |
| 关闭后台标签 | 一次短暂 attach 发 `close`；只有确认会话已不在（帧送达，或 Host 回答该 id 已过期）才移除标签，否则保留并给出明确重试路径 |

### ready 之前不得 detach

尚未报出会话 id 的连接不能 detach：Host 还在认证，没有 id 可回连，丢掉 socket 会让会话
继续完成连接却没有任何持有者，直到空闲回收（十分钟）才被清掉。这就是参考分支在每次提前
切换时制造的孤儿。视图因此把这种 socket 交给 `PanelController.adoptTerminalLink`，由
controller 保留它，并在 ready 帧到达时执行挂起的意图：`detach` 留下 shell 供之后回连，
`close` 结束用户已经关掉的会话。标签再次显示时用 `reclaimTerminalLink` 取回这条
连接，所以切回一个仍在连接的标签不会开第二个 PTY。标签切换与面板切换（布局在选中别的
面板时会卸载本页）都走这条路径。

意图是在 ready 帧到达时从**当时的登记项**读取，而不是沿用认领时闭包里的那个：关闭一个
仍在连接的标签会把该项的意图改成 `close`，于是会话被结束，而不是被 detach 成一个没有
持有者的 PTY。被认领期间产生的输出会追加到该标签的保留画面，取回 socket 时先把这份画面
画出来再继续写入，因此这段窗口不是空洞。

### 一块屏只有一个主人

每次绑定要么回放 Host 的滚动缓冲（`connected` 标签），要么画出该标签的保留画面，并且在
唯一终端当前显示的是别的标签时先清屏。刚创建或被释放的终端没有内容，不做清屏。这条规则
保证新开或切回的标签不会继承上一个标签的输出与光标位置。

### 2FA 的答案属于它自己的标签

挑战与正在输入的答案都存在标签记录上（`authPrompt`、`authAnswers`）。因此后台标签收到
的挑战不会清掉用户正在编辑的输入框，两个挑战也绝不可能共用一份草稿：提交表单时发送的永远
是当前标签自己的答案，顺序也按它自己的挑战。视图本身不持有答案状态。

提交路径还会校验 socket 与表单指向同一个标签（`challengeBelongsToLink`）。React 会先提交
标签切换、再运行重绑 socket 的 effect，落在这一窗口里的事件本来会把新标签的答案送到上一个
标签的连接上；这项校验把"答案属于谁"变成发送的前提，而不是对事件顺序的假设。同理，已关闭
标签后续的输出帧会被直接丢弃——不能让一个没人能看见的标签重新长出一份保留画面。

### 远端退出

exit 帧清掉会话 id——死掉的 id 绝不能再用来回连——并保留标签、位置与最后一屏：输入禁用，
标签条把该标签标成 `exited`，空态占位只在完全没有标签时出现。由于 id 已清空，画面无法
再从 Host 取回，所以每个标签保留一份有上限的写入副本（256 KiB，按块裁剪），并且放在响应
式快照之外，避免终端输出把面板重渲染一遍。在后台时 shell 已经退出的 `connected` 标签，
会在被 attach 时得知：Host 先回放滚动缓冲，再发 `ready`，然后发 `exit`。

### 关闭后台标签

后台标签已经没有 socket 可以发 `close`，而为了结束一个会话新增 HTTP 路由等于为了一帧
扩大宿主面。`SshApi.closeTerminalSession` 改为开一次短暂 `attach`，在 socket 打开后
发 `close`，回答的问题只有一个：这个会话是否已经不在运行。三种结果是诚实的——帧落到了
已打开的 socket 上；或 Host 回了 `exit` 帧（未知 id 会回 `terminal session expired`，
已结束的 shell 也会 exit），两者都说明没有东西在跑——而不诚实的情形只有一种：socket 报错、
在打开前关闭，或在该调用自己的有界等待内始终没有结论，此时投递未被证明，会话可能还活着。

未证明的情形保留标签、保留其会话 id，并显示 `terminal.closeFailed`；标签条同时给出标记，
即使当前显示的是别的标签也能看见，而陈旧标记会在该标签重新连上、退出或失败时清掉。恢复
路径明确且诚实：同一个控件一次只发一次尝试（另一次 attach 在途时的重复点击被忽略，不会与
它竞争），把该标签切到前台再关闭则会经由它自己的实时 socket 结束 shell。失败提示在三种
语言里都写明了这两条路径——只给"重试"会藏起那条不会失败的路径。插件绝不移除一个无法结束
的会话的标签，也绝不声称送达了没送达的关闭。

### 工具栏与文案

主机下拉框反映当前标签，而不是组件私有字段，因此从主机页连接后进入终端页时该主机已选中，
「+」会按用户正在看的主机新开一个标签。新增文案在 `client/locales.ts` 的 `zh` 与 `en`
里都有，并在 `packages/dsh-i18n/src/client/ru/ssh.ts` 镜像（`terminal.tabs`、
`terminal.newTab`、`terminal.closeTab`、`terminal.authPending`、
`terminal.tabExited`、`terminal.tabError`、`terminal.closeFailed`）。

## 考虑过的替代方案

- 每个标签一个 xterm，用 CSS 藏起来。否决：会为没人看的标签保留 N 个渲染器、N 个
  ResizeObserver 与 N 棵 DOM；需求就是一个终端视图。重绑一个实例的代价只是一次 reset 加
  一次 Host 回放，而 detach/attach 本来就提供回放。
- 后台 socket 一律保持 attach、不 detach。否决：Host 的滚动缓冲只有在之后会 attach 的
  场景下才有意义；保持 attach 的后台 socket 会把输出送到唯一 xterm 无法显示的标签上，只能
  丢弃，切回来时画面会出现空洞，而 `attach` 本可以给出完整回放。
- 为「按 id 关闭会话」新增一条 HTTP 路由。否决：为了一帧扩大 `/api/dsh-ssh/*`，还要重复
  一遍 loopback 围栏与会话查找，而短暂 attach 在既有传输上做的是同一件事。
- 引入参考分支再补丁。否决：它的缺陷是结构性的而不是局部的——它在会话 id 出现之前就
  detach，标签条怎么补都无法变安全；退出路径还会删掉用户仍需要阅读的标签。
- 保留已退出会话的 id 作为重绘最后一屏的句柄。否决：Host 只把已退出的会话保留 60 秒宽限，
  宽限一过标签就空白；而拿一个已死的 id 当句柄，会静默地 attach 不到任何东西。
- 把保留画面放进 controller 快照。否决：每个输出块都会通知订阅者并重渲染面板——终端路径
  正是最不能按字级事件重渲染的地方。
- 对「标签在连接中被关闭」的 socket 一律 detach。否决：此后没有任何东西能回连到那个会话，
  「留给以后」的意图退化成无主 PTY；应当把登记项的意图改成 `close`。
- 把未送达的关闭当成已关闭。否决：会话可能仍在 Host 上运行，移除标签等于删掉用户对该会话
  唯一的句柄。标签会保留，直到会话被证明不在（Host 的 exit 回复）或经由实时 socket 结束。
- 第二次关闭仍失败就强制移除标签。否决：那只是同一句谎话多按了一次，除非 Host 自己确认
  会话已经不在。
- 2FA 答案共用一份草稿。否决：一个标签的挑战会继承另一个标签输入的字符，为某个挑战提交的
  响应可能带着给另一个挑战准备的答案。

## 后果

- 连接总是新开标签；单标签旧行为就是「只有一个标签」的情形，连接 / 断开 / 2FA / 字体 /
  切面板重连的行为与之前一致。
- 标签列表是浏览器会话状态：刷新页面会丢掉所有标签，也丢掉 Host 原本会为之保活的 socket。
  将来若要持久化，必须在刷新前记住 id 并在刷新后重新 attach，而 socket 一旦消失，Host 就
  无法再提供这个机会。
- 保留画面每个标签最多 256 KiB，且只在该标签打开期间占用。
- 仍在连接时被关闭的标签会立刻从标签条消失，被认领的 socket 会在握手结束时立即发
  `close`，因此 Host 上的 PTY 是被结束而不是被晾成孤儿。
- 后台关闭最多等五秒的投递信号，控件不会挂住；Host 回答已过期的会话会被移除，投递无法
  证明的会话则保留。
- 2FA 的答案草稿按标签存在 controller 里，因此也能跨面板切换保留，而不是随视图卸载丢失。
- 面板自身的页签继续使用 `data-dsh-part="tab-bar"` / `"tab"`；终端标签条复用这两个既有
  契约值，不新增 `data-dsh-part` 枚举，因此不需要改皮肤契约。

## 测试

- `tests/panel-terminal-tabs.test.tsx` 端到端覆盖标签状态机：同一主机两个标签各自持有独立
  会话 id；切换时隐藏会话 detach、显示会话按 id reattach；关闭一个标签而另一个继续运行；
  Host 未确认的关闭保留标签及其会话 id 并报 `undelivered`；ready 之前切走会认领 socket
  并在 id 到达后 detach；握手中卸载视图同理；后台标签收到的验证提示在切回后仍可提交；
  远端退出保留标签与保留画面而不是占位；主机页连接后下拉框跟随该主机；「+」按当前主机
  新开标签；`closeTerminalSession` 只在关闭帧落到已打开 socket 时报告送达。
- 评审回归各有专属用例：关闭仍在连接的标签会 close（绝不 detach）其会话；新开标签从空白
  屏幕开始且两个标签的保留画面互不混淆；切回仍在连接的标签保留其间的输出并复用同一条
  socket；两个标签的两个挑战各自保留字段、长度与答案；后台关闭失败在 Host 报告会话已不在
  后清除，且可经由前台标签恢复；关闭当前标签把终端交给接替它位置的标签；关掉最后一个标签
  回到空态；已过期的会话按已关闭处理；无人应答的关闭在有界等待内结束。
- 渲染半边直接在唯一真实 xterm 实例上观测，而不是只查记账：用 `Terminal.prototype.reset`
  证明绑定另一个标签前确实清掉了属于旧标签的画面，用 `Terminal.prototype.write` 证明被
  认领标签的保留画面在取回时恰好回放一次。这两处是本文件唯一的 `vi.spyOn`，各自带一条
  逐行 `test-standards-allow` 理由：替代方案是在产品里加一个只为测试存在的接缝。真实渲染器
  初始化时 jsdom 会打印 "Not implemented: HTMLCanvasElement.getContext"，那是 stderr 噪音，
  不是失败。
- 另外两个用例收尾最后两条复审意见：已关闭标签的 socket 不再向保留画面投喂数据（不会复活
  记录），以及提交路径拒绝对绑定到别的标签的 socket 作答（`challengeBelongsToLink` 覆盖
  同标签 / 别的标签 / 未绑定三种取值，并另有"切换与提交发生在同一个任务里"的 DOM 序列）。
  该文件共 26 个用例。
- `tests/panel-terminal.test.tsx`、`tests/panel-terminal-font.test.tsx`、
  `tests/panel-shell.test.tsx` 未改动仍然通过：单标签连接、2FA 弹窗、字体热更新、面板
  页签语义与 teardown/xterm 释放契约都还是同一份契约。
- `tests/terminal-sessions.test.ts` 继续验证 Host 侧，本次改动不涉及。
