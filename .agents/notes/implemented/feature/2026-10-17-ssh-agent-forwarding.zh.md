# Agent Note: 逐主机 SSH Agent 转发（issue #1851）

Status: implemented

## Problem

dsh-ssh 可以用本机 ssh-agent 认证，却无法把 agent 转发到远端：远端的 git fetch、rsync、部署跳转都需要自己的密钥材料，而仅有的绕法（把私钥拷到服务器，或在服务器上再跑一个 agent）恰好抵消了使用 agent 的意义。OpenSSH 几十年前就有 `ForwardAgent yes` / `ssh -A`，因此一个声称可以替代用户 `~/.ssh/config` 的主机条目却表达不出这条安全相关指令，导入器还会静默丢弃 `ForwardAgent`——与 [ProxyCommand 传输层笔记](2026-09-10-ssh-proxycommand-transport.md)修掉的是同一种失败形态。

这项能力在危险程度上不同于周边连接代码：它把本机密钥的签名权交给远端。因此任何设计都必须让信任决定显式、逐主机给出，并且必须让失败模式保持响亮。

## Decision

`forwardAgent` 是存于 `~/.dsh/dsh-ssh.json` 主机条目上的可选布尔值，默认关闭，且只在为 `true` 时写入：从未选择启用的配置保持原有字节，降级安装或旧读取方不会看到它不认识的键。

### 端点解析顺序

转发是叠加能力——它不改变主机的认证方式，只让这条连接替远端代签。建连时（`buildConnectConfig`）已启用的主机会拿到 `agentForward: true` 和一个解析出的本地端点，顺序为：主机配置的 agent 路径、`SSH_AUTH_SOCK`、Windows 上的 `pageant`。当主机本身用 agent 认证时，该路径已解析过，转发直接复用它而不是再解析第二个（可能不同的）端点——远端用的签名 agent 就是完成认证的那个 agent。`resolveForwardAgentPath()` 独立成名的原因，是给转发路径留出与认证解耦的余地，尽管两者当前共用同一套解析。

### 逐会话请求行为

ssh2 的 `agentForward` 按 channel 协商而非按连接协商，因此已启用主机上的每个 exec 与每个 PTY 会话都会各自发出一次 `auth-agent-req@openssh.com`；未选择启用的主机不发任何请求。正因为请求逐 channel 生效，只对新连接生效的设置会「看起来生效」而既有 channel 继续不转发，所以携带 `forwardAgent` 的 PATCH 会像其它连接字段一样断开该主机的池化连接（`routes.ts`，与 host / port / user / auth / proxyJump / proxyCommand 同一批）。

地址形式的 ProxyJump 跳板刻意不带 `forwardAgent`：临时地址从未被用户配置过，绝不能继承目标主机的选择启用结果；写成已配置别名的跳板则使用该别名自己的条目，这正是「故意在堡垒机上转发」的做法。

### 失败模式

- 本机没有端点却启用了转发：建连被拒绝，并给出可操作错误（`agent forwarding is enabled for this host but no ssh-agent endpoint is available: set SSH_AUTH_SOCK, start Pageant on Windows, or configure an agent path`）。ssh2 自身在同种情况下的报错既不说主机、也不给出路，而一个悄悄不转发的会话正是用户看不出坏掉的那种。
- 服务端配置 `AllowAgentForwarding no` 时会拒绝该请求；ssh2 让该会话报错或关闭，插件把该错误原样呈现。绝不降级为未转发的会话——一个悄悄丢掉 agent 的会话，会在之后、在别处以一条令人困惑的认证错误失败。

### 导入与 Agent 面

`~/.ssh/config` 导入器把 `ForwardAgent yes|true|on` 映射为启用，把 `no|false|off`——或干脆没有该指令——映射为关闭；无法识别的取值保持关闭而不让导入失败，因为一个陌生关键字绝不能连累整个 Host 块。`ssh_list` 在每台主机上报告 `forwardAgent`，并在表格中渲染 `forward` 列（`yes` / `-`）：转发是安全相关的选择启用项，模型必须在表格里看到它，而不是只在 JSON 载荷里。

## Alternatives considered

- 整个插件一个全局开关。否决：信任边界是主机而不是插件——用户会对自己的构建机转发、绝不会对共享堡垒机转发，一个全局开关必然在其中一边替他做出错误选择。
- 始终开启转发（不少交互式 ssh 封装的做法）。仅从安全模型就该否决：它静默地把「以本机身份签名」的权利授予每一台已配置的主机。
- 提前探测 agent 可用性——落盘时或面板加载时就探测，没有 agent 的机器上直接禁用勾选框。否决：端点会在探测与建连之间出现或消失（稍后启动的 agent、死掉的转发器），探测报告的是一条已经过期的事实；只有建连时解析才是真的，况且失败本来也必须在那一处抛出。
- 始终存该字段（写 `forwardAgent: false`），让结构统一。否决：首次无关保存就会重写所有既有配置文件，而且「用户关掉了」与「这条记录早于该字段」从此无法区分。
- 每个池化连接解析一次端点，而不是每次建连解析。否决：这其实是同一件事的伪装（ssh2 在建连时固定 agent），却掩盖了「开关要等连接池丢弃连接后才生效」这一事实——现在 PATCH 路径显式做掉，而不是留给空闲清扫。
- 服务端拒绝请求时降级为未转发的会话。否决：那会把一个立即、明确、可解释的失败，变成远端稍后一条无迹可循的认证失败。

## Consequences

- 选择启用的主机在连接生命周期内继承本机 agent 的整片信任面：该主机上的每个会话都能用 agent 持有的每一把密钥签名。用户侧表述在 README 的安全模型一节，维护侧规则在 `packages/dsh-ssh/AGENTS.md`。
- 切换该开关代价是该别名的重连，其上的隧道随整池一起被丢弃。
- 导入器现在认 `ForwardAgent`，因此导入进来的主机可能已经带着开启的转发。那是用户自己的 `~/.ssh/config` 在说话，但也意味着导入是一次安全相关操作；主机列表随后会立刻显示标记。
- 没有运行 Pageant 的 Windows 机器依然会把端点解析成 `pageant`（这个字符串是端点，不是存活探测），所以失败发生在 agent 握手而非解析阶段。这与 ssh-agent 认证的既有行为一致；没有额外加存活探测。
- 对所有未选择启用的主机，存储格式不变，因此无需迁移、版本号提升或存储结构改动。

## Testing

- `tests/store.test.ts`：开关经 `find` 与 `summarize` 往返、关闭时磁盘上不出现该键、create / update / validate 拒绝非布尔值、关闭后清除而省略键保持原值，以及 `ForwardAgent` 导入表（`yes` / `true` / `on` 为开，`no` / 缺失 / 无法识别为关）。
- `tests/connection-pool.test.ts`：密码主机启用转发后拿到 `agentForward` 与具体 agent 路径，未启用两者都没有，agent 认证主机复用其配置端点，没有端点的主机抛出可操作的转发错误。
- `tests/agent-forwarding.test.ts`：对内嵌服务器，已启用主机上的 exec 与 PTY 会话各发出恰好一次会话级请求，未选择启用的主机两种会话都不发，服务端拒绝该请求时抛出服务端错误而不是成功。
- `tests/tools.test.ts` / `tests/routes.test.ts`：`ssh_list` 把 `forwardAgent` 作为 schema 必填字段并在 `forward` 列渲染 `yes`，PATCH 该开关会落盘并丢弃池化连接。
- `tests/panel-hosts.test.tsx`：勾选保存 `forwardAgent: true`，取消勾选发送 `false`，标记只出现在已启用的主机上。
- `tests/helpers/ssh-server.ts` 按会话统计 `auth-agent-req@openssh.com` 请求数并可拒绝它们（`acceptAgentForwarding`），上面那条实连测试正是靠它才成立。
