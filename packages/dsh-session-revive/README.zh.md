# dsh-session-revive

[English](README.md) | 中文

DSH Web 影子先行的会话自动复活插件：监听每个 `turn/end` 错误、按失败码分类，
对可复活类码（`TRANSPORT`、`TIMEOUT`）执行裁定好的按会话复活账——分罐滚动
4h x 4 额度、撞墙类零消耗挂起到 `resetsAt`、10 分钟断路器、同因波批量挂起
并按错峰节奏在 5 分钟静默后释放，外加 150k 上下文水位。按 2026-11-07 停轮
原因分治裁定（设计 §7），两个停轮原因并入同一条账：`max-tokens` 停轮（供应商
已响应、只是输出撞上 token 上限）与 goal-round-driver 的检查点写入失败（经
logger exporter tap 捕获）。排除类停轮——人为中止、会话 resume/fork 标记、
目标 block/complete——一律不自动续，只写一行 `stop-parked` 留证。每次检测与
每次判定都是一行结构化 JSON 日志。默认 `shadow` 模式完全不碰会话；
`mode: 'live'` 才会经宿主会话控制器排队一句继续 nudge。仅宿主侧——本包不声明
`dsh.client` 面。

## 功能

- 给每个 `turn/end` 错误分类：可复活类（`TRANSPORT`、`TIMEOUT`）进复活流，
  撞墙类记零消耗挂起直到 `resetsAt`，其余码只观测、只记日志。
- 两个停轮原因并入同一条复活账（设计 §7.2）：`max-tokens` 停轮先清掉陈旧
  挂起（供应商确实响应过）再按可复活类死亡走账；goal-round-driver 的检查点
  写入失败告警行由 logger exporter tap 捕获、同样喂入。两者与网络死因共用
  同一条 4h x 4 额度、断路器与波。
- 按原因给 live nudge 打标（设计 §7.2(4)）：停轮原因的 nudge 先提示
  `update_goal action=resume`（nudge 轮带直接人类授权），`TRANSPORT`/
  `TIMEOUT` 沿用朴素「继续」。
- 对排除类停轮只写 `stop-parked` 留证行、绝不自动续（设计 §7.1）：
  `turn/end` 中止（带取消来源）、`interrupted`/`forked` 生命周期标记、
  `goal/change` 的 block 与 complete。
- 每次复活前先过裁定账：断路器最前（复活后 10 分钟内再死即永久停该会话），
  然后是挂起、150k 水位、波挂起，最后才是滚动 4h x 4 分罐额度。
- 同因波开启期间（15 分钟内同码错误达到 2 次）挂起会话，5 分钟静默后释放，
  逐个错峰复活、各自扣自己罐的额度。
- 提供 `GET /api/session-revive/status`（仅回环）：方式、计数、挂起/停用/
  断路状态与分罐额度，用于重启后验证与留证复核。

## 安装

本地链装（本包不发布到 npm）：

```powershell
dsh plugin --profile <name> add link:<repo>/packages/dsh-session-revive
```

唯一的 bundle 行（`session-revive`）挂载事件监听、波释放定时器与状态路由。
重启宿主（或依赖热补丁重载）后生效。

## 配置

插件配置由 schemastery 校验（默认值与夹取集中在 `src/config.ts` 一处）：

| 字段 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 总开关；`false` 时监听、定时器与路由全部不挂 |
| `mode` | string（`shadow` 或 `live`） | `shadow` | `shadow` 记完整决策账、只扣发送；`live` 才排队 nudge |
| `staggerMs` | number | `10000` | 复活计划的最小间隔；低于 `10000` 一律夹到 `10000` 并告警 |

裁定参数由设计档定死、不可配置：4 小时窗口内每链 4 次（只计可复活类死亡）、
10 分钟断路器、15 分钟内同码 2 次成波且 5 分钟无新同码错误才释放、
150000 token 上下文水位停靠不 nudge。撞墙类码（设计名单加上其 `AUTH` 族与
模型配置族）零消耗并把会话挂起到 `resetsAt`。

每次判定经宿主 logger 落一行：`dsh-session-revive ` 前缀加一个带当前 `mode`
标记的 JSON 对象。

## 安全模型

- 状态路由仅回环（RFC 5735 本地地址）：远端套接字一律 `403`，会话 id 与
  计数不出本机。
- 不碰凭据、不发起外网请求、不写文件：插件只听进程内会话事件，且仅在
  `live` 模式下经宿主自带的会话控制器给目标会话排队一条文本消息。
- `shadow`（默认）零发送：挂载而未配置的插件不会打扰任何会话，除非有人
  显式设 `mode: 'live'`。

## 已知限制

- 状态在内存里：断路、挂起、额度戳与波挂起随宿主重启清零；结构化日志才是
  持久留证。
- 晨报联动尚未接入：断路与跳过证据躺在日志流里，等读取方。
- `live` 发送路径已实现但从未对真实会话跑过；打开开关属于转正批次，自带
  验证清单。
- 达到或超过 150k 水位的会话，human 与 bot 一律停靠：bot 的 relay 分支随
  relay 线落地。
- 子代理子会话在范围内（设计覆盖全员）；其 `session.header.origin` 记入
  证据，是否排除留作调参旋钮。
- 半途静默死亡不发 `turn/end` 事件，本插件检测不到（看门狗链是另一条线）。
- 两张名单之外的码（如 `RATE_LIMIT`、`PI_AI_ERROR`）既不复活也不挂起：只有
  设计枚举的撞墙类才停靠会话。
- 检查点停靠原因与 goal-round-driver 的告警文案精确耦合（logger 流上的正则）；
  驱动侧改文案会让检测静默失效，须同步更新签名。
- 成波中的第一个错误在波成形前就已判定；若网络当时已断，损失由断路器与
  4h x 4 额度兜住。
