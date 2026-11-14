# AGENTS.md — dsh-message-edit

DSH Web GUI 的文本消息「编辑并重发」插件。包级规则只写本包特有约定。

## 本包要点

- 纯浏览器插件：host 半区无行为；`conversation.chat.turnTail` 为每个含普通纯文本用户消息的回合提供入口，不替换官方 Chat Node 渲染器。
- `src/core/transcript.ts` 只负责按 Chat Location 选择用户消息并计算 `message.seq - 1` 的包含式 fork 边界；steering、上下文、附件和空文本不得进入编辑路径。
- `src/client/wiring.ts` 依次执行 fork、短期 retain/ready、打开子会话、prompt；`sessions.using` 必须在所有成功与失败路径释放引用。源会话不做任何写入。
- 编辑文案明确提示分支不会撤销外部副作用；运行中、已移除或无 `session/fork` 权限时禁止提交，成功导航前不得重复 fork。
- 语义属性为 `data-dsh-plugin="message-edit"` 与部件 `entry` / `editor`；文案 zh/en 在本包，ru 集中在 dsh-i18n。

## 提交前检查

```sh
pnpm --filter @linxin666/dsh-client-ui-message-edit typecheck
pnpm --filter @linxin666/dsh-client-ui-message-edit test
pnpm --filter @linxin666/dsh-client-ui-message-edit build
pnpm i18n:check
```
