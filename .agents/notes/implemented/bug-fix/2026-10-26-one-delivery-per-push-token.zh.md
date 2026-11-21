# Agent Note: 一枚 APNs 令牌一次投递，一台手机一行

Status: implemented

## Problem

一台手机产生了两条一模一样的通知。桥对 `$DSH_HOME/remote-bridge/devices.json` 的每一行各投递一次事件，而这台 iPhone 把同一枚 APNs 令牌放在了两行上：正在用的那台落在 2 行，同一台手机的另一枚令牌在 43 次重配对之后落到了 34 行上。

四个事实凑成了这件事，而且它们是一条链。`pair.finish` 每次接受配对都调 `roster.enroll(devicePubKey)`，而 `enroll` 每次都用新的令牌哈希开一个新行，没有复用公钥指纹已经拥有的那一行，所以每次重配对都多一行。接着 `registerPush` 只写当时在线那台设备的那一行，老行保留的登记依然有效，因为 APNs 令牌属于这个 App 安装，不属于某一次配对。`pushTargets()` 一行报一个目标，`PushNotifier` 的 `#announce` 按 `(sessionId, event)` 只准入一次，随后按目标各发一份，于是 2 行就是同一个事件的 2 次投递。`src/host/apns.ts` 不发 `apns-collapse-id`，iOS 没有可用来合并它们的依据。

这份台账也是运维唯一没法手修的地方：运行中的宿主把表持在内存里，下一次 touch 就把整份写回，于是手改会被复活，而删掉文件等于一次性解绑所有设备。

## Decision

- 发送端在 fan-out 之前按 `deviceToken` 收敛目标列表（`src/core/push.ts`），同一枚令牌只留第一个地址，一枚令牌只投一次。一枚令牌就是一个 App 安装，就是一块锁屏，所以持有它的那几行是同一台手机，不是几台手机。这条规则旁边的三个上限——`PUSH_DEDUPE_MS`、`PUSH_SESSION_INTERVAL_MS` 与 `PUSH_GLOBAL_PER_MINUTE`——值与语义都不变，也不新增 `apns-collapse-id`。
- `enroll` 复用指纹已经拥有的那一行（`src/core/devices.ts`）：`deviceId`、`createdAt` 不变，`push` 块原样保留，`lastSeenAt` 刷新为现在。只有凭据移动，因为新 mint 的 bearer token 换掉了 map 键，所以配对之前的那枚令牌不再能认证。指纹若已拥有多行，先做一次结算：留 `lastSeenAt` 最大的那行（并列取 `createdAt` 大的），其余删掉。
- 载入成功后把表在内存里压缩一次并把结果写回：先按 fingerprint 收敛成一行，再把同一枚 APNs 令牌只留在最后登记它的那一行上，其余持有该令牌的行保留身份、只去掉 `push` 块，也就是 `removePush` 留下的那个形状。幸存行自己从未登记时，会继承被删掉的行里最新的那份登记，因为那是同一个安装的令牌。写回走名册既有的串行队列（见[名册写盘串行化那篇](2026-10-24-remote-bridge-roster-write-serialization.md)），而且只在这一趟真的改动了东西时才写，只记一行日志：`compacted N duplicate row(s), retired M stale registration(s)`。
- 磁盘格式未动：仍是 `version: 2`，没有新字段，没有新公开方法，version-1 的文件读法与从前一致。
- 投递规则归本篇；[推送通道那篇](../architecture/2026-10-21-remote-bridge-push-notifications.md)归属通知允许携带什么，本篇归属一台手机拿到几条。

## Alternatives considered

- **只在发送端去重。** 否决：台账照今天的速度继续长，实测一台宿主 254 行、一台手机自己 43 次配对，病还在，只是症状不再落到锁屏上。
- **只在设备表收敛。** 否决：运行中的宿主握着它载入的那份表，重启之前同一个事件照样按行 fan-out，复现窗口在长跑宿主的整个生命周期里都开着。
- **发 `apns-collapse-id` 让 iOS 合并横幅。** 否决：它只是把 N 次投递藏在一条横幅后面，APNs 请求数与节流额度一分不少，而且会把两个本该分开的事件静默合并。
- **直接手改或删掉 `devices.json`。** 否决：运行中的宿主下一次 touch 就把内存里的表写回，手改会被复活；删掉文件等于把运维配过的所有设备全部解绑。
- **把 fingerprint 做成名册主键。** 否决：token hash 才是认证入口，行本身没选错键；缺的是「一台手机只留一行」这条规则，它现在在写行的地方和读行的地方都成立。

## Consequences

- 重配对是换凭据而不是加设备：手机保留它的 id、创建时刻与通知登记，而配对之前的那枚令牌被拒。
- 旧宿主写出的表在这次改动后的第一次启动里缩小一次，只记一行日志；此后再重配对根本不再加行。
- APNs 请求数从此对齐设备而不是行，滚动一分钟的额度花在不同的手机上。登记被摘掉的设备保留它的行，只是在 App 下一次 `push.register` 之前不再要求通知，而那一次会写一份完整的块，这里没有任何事情会解绑一台手机。
- 被摘掉的块把它的 Live Activity 令牌一并带走，那是同一个安装下一次 `push.register` 会整份重写的内容。
- `tests/push.spec.ts` 固定一枚令牌一次投递（两行、一次发送、就是那一份载荷，且每枚不同令牌仍然各自收到）与手写台账的压缩（行与令牌都收敛、文件被重写成压缩后的样子、一行日志、第二次载入为空操作）；`tests/pairing.spec.ts` 固定 enroll 的复用（一行、id 与创建时刻不变、登记保留、旧令牌被拒）。
