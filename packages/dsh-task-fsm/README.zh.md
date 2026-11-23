# dsh-task-fsm

[English](README.md) | 中文

DSH Web 的任务有限状态机，落实纯 worker 设计（`pure-worker-design-1123`）：
「worker + host 机械闸」的组织方式——任务推进由显式状态机跟踪，不再依赖
boss 会话。机器权威 = 单个平铺文件 `~/.dsh/task-fsm-state.json`
（host 读写；板行仍是人读账本面）。host 半边在 `/api/task-fsm` 下挂带守卫
的路由；browser 半边在会话行上座位化冻结标记、hover 子原因行与冻结只读
快照。

## 功能

- 状态 × 事件转移表带完备性断言——未知事件、未知 state/key 组合一律拒绝
- 六道守卫 G1–G6 在 host 侧查表核验后动作才落地（worktree 预案、
  taskRef 409 唯一、scope 在册、验收闸、心跳验活、终态写权限）
- 队列档（红 / 黄 / 不入）配四件 hover 子原因：等什么 / 为什么 / 谁 / 下一步
- 冻结会话标记（❄️ / 🔒）hover 带冻结原因、点开是只读快照，
  唤醒两触发（前置终态到达、配额空）
- 归档分层：子 worker 随父归档、根 worker 留人归、终态出通知
- browser 行座位经公开槽位契约注册——零 harness 源码改动

## 状态文件

`~/.dsh/task-fsm-state.json` 是机器权威（带版本 schema、原子写入；文件
损坏时响亮拒绝、绝不静默重建）：

```json
{
  "version": 1,
  "taskRef": "content/tech/ai/dsh/tasks.md#<anchor>",
  "state": "backlog",
  "queue": "none",
  "session": { "id": "session-…", "mode": "active" },
  "attempts": { "redisp": 0, "autofix": 0 },
  "history": []
}
```

旧机制（`taskbot-state.json`、dispatch bindings）与本文件零读写交集；
双轨期两边只共享服务层（taskRef 409、配额、revive、归档插件、入队判据）。

## 守卫

1. G1 worktree 预案——任务书缺 worktree 预案即拒
2. G2 taskRef 409——同 taskRef 活绑定唯一
3. G3 scope 在册——taskRef 前缀必须落在人开 scope 内
4. G4 验收闸——机检读数全绿才允许终态 E8
5. G5 心跳验活——断链判死喂给 revive（E13 / E14 / E10）
6. G6 终态写——终态写入走 acceptance-gate 账本口径

## 安装

已登记在 m-note `.dsh/installed-plugins.json`，由 `plugin-install.py` 装入
web profile；手动形态：

```bash
dsh plugin --profile web add link:D:/tech/dsh-web-prod/packages/dsh-task-fsm
```
