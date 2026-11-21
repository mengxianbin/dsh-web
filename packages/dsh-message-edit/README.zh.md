# @linxin666/dsh-client-ui-message-edit

[English](README.md) | 中文

为 DSH Web GUI 的纯文本用户消息提供「编辑并重发」：按精确历史前缀创建分支，不修改源会话。

## 能力

- 在每个包含普通纯文本用户消息的回合末尾提供「编辑并重发」入口，历史回合同样可用。
- 以该消息之前事件的包含式序号作为边界 fork，持有并打开子会话，再把编辑后的文本入队一次。
- 源会话保持不变；界面明确提示创建分支不会撤销文件写入、命令执行等外部副作用。
- 支持 Ctrl/Cmd+Enter 重新发送、Esc 取消；运行中或已移除的会话，以及无 fork 权限的访问方不能提交。

## 安装

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @linxin666/dsh-client-ui-message-edit@latest
```

### 从仓库安装（开发调试）

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-message-edit
```

## 配置

本插件没有设置项；停用对应插件行即可移除回合末尾入口。聚合行 id 为 `web-ui-message-edit`，独立安装行 id 为 `ui-message-edit`。

## 已知限制

- 仅可编辑内容块全部为文本的普通用户消息。Steering 消息、注入上下文、空消息以及含图片或文件的消息不显示入口，避免静默丢失附件。
- 编辑会创建新分支，不会改写原日志，也不会回滚后续事件产生的副作用。
- fork 失败时源页面保持不变；子会话创建后若导航或 prompt 失败，不会擅自删除该子会话。

## 许可证

Apache-2.0。
