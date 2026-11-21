# Agent Note: ssh-agent 路径不是机密，Windows 默认改用原生命名管道（issue #1910）

Status: implemented

## Problem

编辑一台已保存的主机、把认证方式改成 SSH Agent 并让 Agent 路径留空后，保存什么也没发生：弹窗关闭、列表刷新，主机的认证方式却仍是原来的，且界面没有任何报错。主机表单把 `agentPath` 归类为 secret，留空即置上 `secretEmpty`，`HostFormDialog` 随之把整个 `auth` 块从 PATCH 中丢掉；而 `store.update()` 只在 `patch.auth !== undefined` 时处理认证，缺字段正是合法的「无需改动」，于是返回 200 并保留旧的认证方式。该字段自己的提示语写的是「留空自动检测」——界面把用户直接引到了唯一走不通的输入上。

这不是显示问题。带口令的私钥在导入时被判成 `kind: 'key'`（导入器优先认 `IdentityFile`），而这类用户恰恰最需要 agent 认证——最想用 agent 的路径正是静默失效的那条。

后面还藏着第二个缺陷：即使 `auth` 块提交成功，Windows 上留空的 agent 路径也会被解析成字面量 `pageant`（PuTTY 的 agent）。运行原生 OpenSSH `ssh-agent` 服务的机器上并没有 Pageant，握手直接报 `Pageant is not running`。ssh2 本来就支持 Windows 命名管道，出错的只是默认值推断。

## Decision

### `agentPath` 是地址串，不是凭据

表单「secret 字段留空即保留已存凭据」的规则只适用于密码与私钥路径。agent 认证下 `secretEmpty` 恒为 `false`，agent 表单因此总是提交 `auth` 块；下一行既有的归一化仍会把空路径转成省略的 `agentPath`，也就是文档定义的自动检测值。把主机改成 SSH Agent 后即使路径留空也会生效，这正是提示语承诺的行为。

store 不改：保留 `patch.auth !== undefined` 守卫——它正是「只改标签的更新不会动已存凭据」的保证，只要客户端不再误判非机密，这个守卫就是对的。

### Windows 自动检测改拨原生命名管道

`resolveAgentPath()` 在 win32 上的回退从 `pageant` 改为 `WINDOWS_AGENT_PIPE`（`\\.\pipe\openssh-ssh-agent`）。解析顺序其余不变：显式配置的 agent 路径优先，其次 `SSH_AUTH_SOCK`，最后才是平台默认。确实在用 PuTTY 的用户把 agent 路径写成字面量 `pageant` 即可保留原行为，ssh2 仍把它当 Pageant 协议而非管道。

`buildConnectConfig` 的 agent 分支与转发解析共用这个函数，因此认证与转发一起移动。

## Alternatives considered

- 让 store 把缺失的 `auth` 理解为「切换到 agent」。否决：缺字段无法区分「用户选了 agent」与「这次调用只改了标签」，会让每次部分更新都悄悄改写认证。
- 额外加一个「清除 agent 路径」控件，而不是提交空值。否决：空 agent 路径本来就有明确定义（自动检测），提示语与 store 都已编码这一语义；多一个控件反而让常见场景变别扭。
- Windows 上先试 Pageant、握手失败再回退命名管道。否决：失败路径翻倍、推迟真正的错误，并且会给从没装过 Pageant 的机器报「Pageant is not running」。一个有文档的默认值加一个显式 `pageant` 取值更小也更可预测。
- 保留 `pageant` 默认、只修表单。否决：那只是修好了「静默保存」，Windows 用户仍然得到一个成功保存却连不上的主机——同样的「什么都没发生」只是晚了一步。

## Consequences

- 依赖旧隐式 `pageant` 默认值的 Windows 主机，现在改拨原生命名管道；这类主机需要显式把 agent 路径写成 `pageant`。存量配置不做迁移，因为那个值从来没有被写入——它是在连接时推断出来的。
- 三种语言的自动检测文案都与行为对齐：路径提示语点名 Windows 命名管道，「留空保留」提示语不再声称留空 agent 路径会保留原认证方式。
- 包级 `AGENTS.md` 记下了产生该缺陷的规则，避免日后的「secret 不回显」清理再次把 `agentPath` 吸收进去。
- README（中英）在能力表与安全模型中写明新的端点顺序。

## Testing

- `tests/host-form-dialog.test.tsx` 渲染真实弹窗：把密钥主机改成 SSH Agent 且路径留空时提交 `{ kind: 'agent', agentPath: undefined }`，填了路径则随块提交，而密码 / 私钥留空仍省略 `auth`。第一条用例在旧代码上失败于 `expected undefined to deeply equal { kind: 'agent' }`。
- `tests/connection-pool.test.ts` 在无 `SSH_AUTH_SOCK` 时强制 `process.platform = 'win32'`：agent 主机解析到命名管道，显式的 `pageant` 路径仍然优先。
- `tests/locales-runtime.spec.ts` 与 `pnpm i18n:check` 保证 zh / en / ru 三份提示语对齐。
