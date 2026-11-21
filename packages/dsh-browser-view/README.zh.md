# dsh-browser-view · DSH Web GUI 的实时浏览器视图

[English](README.md) | 中文

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square" alt="License">
</p>

> agent 驱动的那个浏览器，从对话旁边的标签页里看着。宿主半区用 devtools 协议掌管一个独立 Chromium，浏览器半区贡献一个右侧栏标签页类型，于是页面在验证的当下就在眼前。

本包是 DeepSeek Harness（DSH）的外部插件，形态是 cordis bundle：`src/index.ts` 是宿主半区（Chrome 进程、CDP 会话、标签页登记、WebSocket 分发、agent 工具），`src/client/` 是浏览器半区（右栏标签页内容与它的 chip）。

## 它能做什么

- **实时标签页，不是定时截图**：CDP `Page.startScreencast` 的帧经一条 WebSocket 送来，来一帧画一帧。标签页显示当前页面、URL 与标题，以及 agent 最近做了什么。
- **十一个 agent 工具**：`browser_navigate`、`browser_click`、`browser_type`、`browser_press`、`browser_scroll`、`browser_snapshot`、`browser_screenshot`、`browser_console`、`browser_network`、`browser_tabs`、`browser_close`（只关本会话自己打开的标签页）。
- **证据留在对话里**：每次 `browser_screenshot` 的结果都带图，于是对话记录保留的是 agent 真正看到的那一屏，而不只是一句转述。
- **一个专用浏览器**：插件自己拉起 Chromium，用一次性 profile。它不会接管你已经登录的浏览器。
- **能进这台机器自己的 GUI**：全新 profile 没有会话 cookie，本来只会看到 401 提示页。当导航落在 loopback 上的那页提示时，插件向宿主的连接服务要一条与 `dsh web` 启动时打印的同样的带票 URL，补一次。种下的 cookie 只活在这个一次性 profile 里，随它一起销毁。

## 工作原理

```text
agent 工具调用 ──► 宿主半区 ──► CDP ──► 专用 Chromium
                       │
                       └─ 投屏帧 ──► WebSocket ──► 右栏标签页内容
```

宿主半区在第一次工具调用或第一次挂载标签页时才懒启动 Chrome，钉住视口尺寸，并按标签页保留控制台与网络请求的环形记录，因此一次验证不必重跑页面就能回读。顶层文档被替换时两份记录都会清空；同文档导航（hash、query、SPA pushState）则保留。

## 界面席位

| 席位 | 类型 | 放什么 |
| --- | --- | --- |
| `sidebar.right.pane.tab` | keyed，session | 标签页内容 |
| `sidebar.right.pane.tab.title` | keyed，session | chip 的文字与图标 |

会话头部不再为该标签页提供入口：右栏自己的 tab strip 与 guide 胶囊已经能打开它，再加第三个入口只是挤占那一行。

标签页类型经 `ctx.sidebarRightTabs.register` 注册，用 `ctx.sidebarRight.openTabIn` 打开。它的 kind 是 `browser-view`，**刻意不是** `browser`：官方 `@deepseek-ai/dsh-client-ui-sidebar-browser` 占用了那个 kind，而 extension 档位会接管同名 kind，复用等于把官方那个标签页顶掉。

单占位的 `rightbar` / `rightbar.session` 仍然不碰：它们属于那一栏本身，不属于栏里的标签页。

## 安全模型

- **仅限 loopback**：面板 socket 以 loopback 围栏，非本机来源在升级之前就被拒绝。
- **一次性 profile**：Chrome 跑在系统临时目录下全新的 `--user-data-dir` 上，调试端口随机，用户真实浏览器的 cookie、会话与扩展都够不着。
- **默认无头**：桌面上不会弹出窗口，标签页是唯一的可见视图。
- **进程寿命**：插件卸载时杀掉 Chromium 子进程。会话关掉之后不会留下还在跑的东西。
- **令牌处理**：启动令牌每次导航现取、只在内存里，从不落盘；补票只发生在 loopback 目标且文档确实是 DSH 自己的鉴权页时，因此令牌不会被交给别的本地服务。

## 已知限制

- 标签页只是**视图**。输入来自 agent 的工具调用，不转发你的鼠标与键盘。
- 标签页住在右侧栏里，因此需要那一栏存在；布局把栏收起来时它也一起不可见。
- 帧在页面变化时才产生，静态页面停留在最后一帧，而不是重复推流。
- 切换 chip 时内容保持挂载（`keepMounted`），socket 不会断；画面仍等下一次变化。
- 补票只覆盖站点根地址，因为 DSH 只在 `GET /` 时以 303 回应鉴权提示。
- 一个宿主一个浏览器进程；标签页是相互隔离的 CDP target，不是独立 profile。
- Chrome 需装在标准位置，或用 `CHROME_PATH` 指定。

## 安装

```sh
dsh plugin --profile web add link:<this repo>/packages/dsh-browser-view
```

插件行只在启动时读取，因此安装或改动之后需要重启一次 DSH。

## 开发

```sh
pnpm --filter @linxin666/dsh-client-ui-browser-view typecheck
pnpm --filter @linxin666/dsh-client-ui-browser-view test
pnpm --filter @linxin666/dsh-client-ui-browser-view build
```
