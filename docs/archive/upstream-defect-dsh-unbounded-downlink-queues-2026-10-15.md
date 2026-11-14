# 上游缺陷报告：DSH 宿主三处无上限下行队列

本文是可直接提交给 DSH 上游的缺陷报告与参考补丁材料，覆盖 `@deepseek-ai/dsh-api-session-controller` 的两处与 `@deepseek-ai/dsh-api-gateway` 的一处无上限下行队列。

上游维护者不需要任何额外背景即可按本文复现、定位并套用第 5 节的补丁。

## English summary

Three host-side downlink queues in DeepSeek Harness 0.2.0-rc.2 are unbounded by construction: `ControlQueue.buffer` (one per connected client), the `buffered` deque inside `SessionControlController.follow()` (one per open session), and `RemoteEventQueue.frames` (one per connected remote-event client). All three append frames synchronously from event-bus listeners and drain through yield-driven async generators, so queueing happens strictly before any socket write and socket-level backpressure cannot bound them. Because one physical WebSocket carries every logical stream, a slow or stalled consumer grows host memory without limit while the transport looks healthy. The same repository already ships two bounded counterparts — `UplinkInbox` (`streamInboxBytes`, default 262144) and `TerminalFollower` (`maxBufferedBytes`, default 2097152) — so the fix is to apply the existing overflow-fail pattern to the three downlink queues and expose matching configuration fields. Sections 2 to 4 give the mechanism, trigger list and a reproducible measurement recipe; section 5 gives the patches; section 6 the configuration; section 7 the acceptance criteria.

## 1. 被测版本与证据来源

被测版本：`@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2`、`@deepseek-ai/dsh-api-gateway@0.2.0-rc.2`、`@deepseek-ai/dsh-api-terminal-controller@0.2.0-rc.2`、`@deepseek-ai/dsh-deque@0.2.0-rc.2`。

读取位置：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的 `dsh/node_modules/@deepseek-ai/<包名>/lib/...`，以及桌面版 profile `~/.dsh/profiles/desktop`（bundles 为 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`）。

行号约定：本文所有 `文件:行` 指向**已构建的 `lib/*.js` 产物**（rolldown 打包输出）。这些包的 `lib/types/*.js` 是同一逻辑的未打包形态，逻辑一致但行号不同；上游源码仓库的行号也会不同。定位时请用第 8 节给出的标识符字符串检索，不要依赖行号。

## 2. 现象与机制

### 2.1 为什么 socket 层背压救不了

三处队列的入队动作都发生在**事件总线监听器里，同步于业务事件**，而消费动作发生在 async generator 的 `yield` 处。因此帧进入队列**严格早于任何 socket 写入**，socket 的可写状态、`drain` 事件与内核发送缓冲区对队列长度没有任何约束力，只对"已出队但未落网"的部分有效。

更关键的是，一个物理 WebSocket 承载了全部逻辑流。客户端侧的原话见 `dsh-api-gateway/lib/client.js:322`：

```js
* Keep one physical WebSocket and share it among independently cancellable
```

对应实现为 `dsh-api-gateway/lib/client.js:508` 的 `const socket = new WebSocket(remoteStreamUrl());` 与 `:556` 的 `if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);`，mux 路径常量 `/api/remote.mux` 定义在 `dsh-api-gateway/lib/types/stream-protocol.js:4`。

后果有两个：一是 TCP 连接数**不反映**逻辑流数量（用 `lsof` 看不到 follower），所以"连接健康"与"队列健康"是两件事；二是同一条 socket 上的任一条逻辑流变慢，都会让宿主为那一条流单独堆积内存，而 socket 本身仍然是 ESTABLISHED。

### 2.2 缺陷一：`ControlQueue.buffer`，每个已连接客户端一条

`dsh-api-session-controller/lib/index.js:1190`：

```js
var ControlQueue = class {
	buffer = new Deque();
	wake;
	done = false;
	push(frame) {
		if (this.done) return;
		this.buffer.pushBack(frame);
		const wake = this.wake;
		this.wake = void 0;
		wake?.();
	}
```

`push` 无字节预算、无条数上限、无溢出处理。生产者在 `dsh-api-session-controller/lib/index.js:1186`，由全局投影变更驱动：

```js
	broadcast(frame) {
		for (const stream of this.streams) stream.push(frame);
```

`broadcast` 的调用方是 `ctx.sessionProjections.onChanged(...)`（同文件 `:1137`），即任何会话的投影变更都会向每个已连接客户端的队列推一帧，与客户端是否在拉取无关。生命周期在 `:1156` `async *control(signal)`、`:1159` `this.streams.add(queue)`、`:1167` `this.streams.delete(queue)`，清理本身是正确的，所以形态不是"断连不释放"，而是"连上后不拉取或拉得慢"。

### 2.3 缺陷二：`follow()` 的 `buffered`，每个打开的会话一条

`dsh-api-session-controller/lib/index.js:1445` 的 `async *follow(request, signal)` 在 `:1449` 建队列，并在两个全局监听器里同步入队：

```js
	const disposeEvent = this.ctx.on("session/event", (session, event) => {
		if (session.id !== target) return;
		buffered.pushBack({
			type: "event",
			event
		});
		notify();
	}, { global: true });
	...
	const disposeAssistantStream = request.assistantStream !== true ? void 0 : this.ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		if (agent.session.id !== target) return;
		buffered.pushBack({
			type: "assistant-stream",
			frame: wireAssistantStreamFrame(frame, cursorBeforeNext(agent.session.seq)),
			ordinal: ++assistantStreamOrdinal
		});
		notify();
	}, { global: true });
```

消费侧在 `:1531`：

```js
				while (!follower.closed && !signal.aborted) {
					const item = buffered.popFront();
					if (item === void 0) {
						await new Promise((resolve) => {
							wake = resolve;
						});
						continue;
					}
```

`agent/assistant-stream` 是逐 chunk 的密集帧，这是本缺陷的主要放大器。此外 `wireAssistantStreamFrame` 会为**每个 follower** 新建对象（`{...frame, chunk: frame.chunk}`），外层包装对象也是新建的，所以 N 个 follower 就是 N 倍的对象分配。

清理在 `:1559` `this.closeFollowers.delete(close)` 与相邻 disposer，正常路径同样正确。

### 2.4 缺陷三：`RemoteEventQueue.frames`，每个已连接的 remote-event 客户端一条

`dsh-api-gateway/lib/index.js:1180`：

```js
/** Pull-driven queue owned by one connected Client event generation. */
var RemoteEventQueue = class {
	frames = new Deque();
	waiter;
	closed = false;
	push(frame) {
		if (this.closed) return;
		this.frames.pushBack(frame);
		this.waiter?.();
	}
```

扇出面最广：`:853` 的 `broadcastRemoteEvent` 对每一个已连接客户端都推一帧。

```js
		for (const client of this.remoteEventClients.values()) client.queue.push(wire);
```

每个客户端一条队列在 `:818` 建立（`queue: new RemoteEventQueue(),`），`:906` 与 `:947` 也会入队（pending 帧与取消帧）。

### 2.5 `Deque` 本身不提供上限

`dsh-deque/lib/index.js` 的全部公开面是 `get size()`（`:18`）、`pushBack`（`:25`）、`pushFront`、`popFront`（`:47`）、`clear`（`:58`），构造函数无参、无 capacity 参数、无上限方法。该包 README 明确把容量责任交给调用方：`each consumer still owns wake-up, failure, cancellation, capacity, and overload behavior`。全量运行时里 `new Deque()` 共 6 处，只有第 5 节列出的两处传了上限，其余三处就是本文的三个缺陷。

## 3. 触发条件清单

以下条件各自独立即可让对应队列无界增长，叠加时更快。

1. 长生成正在进行：`agent/assistant-stream` 逐 chunk 发射，`follow()` 的 `buffered` 与生产速率成正比。
2. `assistantStream` 虽然是**客户端**请求参数、服务端默认关闭，但客户端库**一律传 true**，所以默认关闭形同虚设。`dsh-api-session-controller/lib/client.js:427-433`：

```js
			async *follow(request, signal) {
				let assistantRevision;
				for await (const frame of this.remote.session.follow({
					address: this.address,
					assistantStream: true,
					...this.repairRequest(request)
				}, signal)) {
```

服务端一侧的开关判定在 `dsh-api-session-controller/lib/index.js:1481` 的 `request.assistantStream !== true ? void 0 : ...`；契约声明在 `lib/typert.host.js:2146`：

```
readonly assistantStream?: true;
```

3. 消费者拉取慢于生产，任意一种即可：渲染进程被内核挂起（内存压力下 macOS 会对带 suspend 策略的进程做 Mach task hold）；浏览器页签进入后台被节流；远端设备经隧道链路带宽不足；客户端崩溃后 socket 未及时关闭。
4. 一个客户端打开多个会话：`follow` 是**每会话一条**，队列数随打开的会话数线性增长。
5. 任何会话的投影变更都会命中 `ControlQueue`（缺陷一），投影更新越频繁（例如统计/大纲类投影在流式期间持续变化）触发越多。

## 4. 量化口径与实测

### 4.1 测量方法（可复现，不需要改代码）

DSH 把每条 assistant chunk 流式帧的原始形态持久化进会话日志，因此帧大小与帧速率可以**从磁盘实测**，不需要估计。会话日志为 zstd 压缩的 JSONL，`assistant/message` 事件的 `data.stream` 数组保留了逐帧记录：`time0` 是该段起始毫秒时间戳，`dt` 是逐帧毫秒增量，`texts`（文本/推理）或 `args`（工具调用参数）是逐帧载荷。因此：

- 帧数 = 各记录 `dt.length` 与 `texts|args.length` 的较小值之和；
- 每帧时刻 = `time0 + 累计 dt`；
- 帧大小 = `Buffer.byteLength(texts[i], 'utf8')`。

一条命令即可复现（把 `<session>` 换成本地任一会话目录）：

```sh
zstd -dc ~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd | node measure.mjs
```

其中 `measure.mjs` 遍历 `assistant/message`、累加上述三项并对秒级分桶求峰值。

### 4.2 本机实测结果（单一会话，`dsh-trading-bot`，日志 18.4 MB）

- assistant 流式帧总数：2,392,166；其中控制帧（block-start/block-end）17,180。
- 分通道：`reasoning-chunks` 850,133 帧（均值 3.9 B，最大 28 B）；`tool-call-chunks` 1,361,446 帧（均值 3.5 B，最大 34 B）；`text-chunks` 180,587 帧（均值 3.6 B，最大 43 B）。
- 载荷总量 17.4 MiB；每帧载荷 均值 7.6 B / 中位 3 B / p95 8 B / p99 12 B / 最大 20408 B。
- 帧速率：有帧的秒数 13,181，均值 182.8 帧/秒；峰值单秒 **734 帧**。
- 载荷速率峰值：23,970 B/秒。
- `dt` 单位校验：全部 `dt` 之和 8,968,364，与按块控制帧测得的时间跨度 10,987,486 同量级（比值 0.82），确认 `dt` 为毫秒。

### 4.3 由此得到的队列增长量级

实测载荷中位仅 3 B，所以排队成本由 **JS 对象开销**主导而非载荷：每帧每个 follower 至少产生外层包装对象 `{type, frame, ordinal}`、`wireAssistantStreamFrame` 新建的帧对象，以及 Deque 的一个槽位，合计约 80 到 120 B（共享的 `chunk` 对象不计入重复）。

于是单个停滞 follower 的增速约为：均值速率下 15 到 22 KB/s（约 55 到 80 MB/小时），峰值速率下 60 到 90 KB/s（约 200 到 320 MB/小时），并且随 follower 数与打开的会话数线性叠加。

**量级诚实说明**：本机日志实测的 assistant 帧流量**不足以单独解释**曾观察到的 45.47 GB（1.5 小时内需要约 8.4 MB/s 持续增长，比实测均值高两个数量级）。因此本文主张的是：这三处队列**结构上无界且无可配置项，是必须修的缺陷**，在本机数据下它们解释的是数百 MB 量级；45.47 GB 事件的成因仍需结合其他路径（例如同一时刻并存的多个停滞 follower、异常大的 `argumentsDelta`、或客户端反复重连导致队列换代前的瞬时堆积）继续排查。第 6 节的配置项与第 7 节的验收标准对上游仍然成立，且不依赖 45.47 GB 这个数字。

### 4.4 在隔离实例上验证

必须使用独立 DSH_HOME，不要触碰正在运行的实例：

```sh
DSH_HOME=/tmp/dsh-queue-repro dsh web --port 0
```

然后在另一个终端打开 GUI，开始一次长生成，并让消费端停止拉取（把页签切到后台，或对浏览器进程施压使其被节流），期间每 10 秒采样宿主进程 RSS：

```sh
while :; do ps -o rss= -p $(pgrep -f dsh-desktop-host) ; sleep 10; done
```

判定：RSS 随生成进度**单调上升且不回落**、生成结束后才回落，即证实队列在积累；若始终呈锯齿且上沿不抬升，则该路消费者速率足够，本缺陷未被触发。

若要直接量出队列长度而不是猜，用 `node --inspect` 挂到隔离实例，在 `buffered.pushBack`、`ControlQueue.push`、`RemoteEventQueue.push` 三处下断点读 `size`，或在这三处各加一行计数器（仅隔离实例，不改发布产物）。

## 5. 参考补丁

### 5.1 照抄来源：同库已有的两处有界范式

范式一，`dsh-api-gateway/lib/index.js:411` 起 `UplinkInbox` 的溢出判定（`:438`）：

```js
		if (this.bytes + frameBytes > this.maxBytes) {
			this.violate(new RemoteError("gateway/uplink-overflow", `api gateway: Remote stream uplink exceeded ${String(this.maxBytes)} buffered bytes`, { endpoint: this.endpoint }));
			return;
		}
```

其上限来自配置 `streamInboxBytes`（`dsh-api-gateway/lib/index.js:598`），常量 `DEFAULT_STREAM_INBOX_BYTES = 262_144` 在 `dsh-api-gateway/lib/types/index.js:18`，按逻辑流构造于 `dsh-api-gateway/lib/types/stream-server.js:171`。

范式二，`dsh-api-terminal-controller/lib/index.js:88` 起 `TerminalFollower.push` 的溢出判定（`:91`）：

```js
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		if (this.bytes + bytes > this.maxBytes) {
			this.failure = /* @__PURE__ */ new Error("Terminal output consumer exceeded its buffer; reconnect to recover the current screen");
			this.close();
			return;
		}
```

其上限来自 `maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024)`（同文件 `:751`），实例化于 `:370`。

注意范式二的计量方式是 `Buffer.byteLength(JSON.stringify(frame), "utf8")`，即按"线帧字节"而非"载荷字节"计量。本文三处补丁沿用该口径，因为它与内存占用单调相关且与既有实现一致。

### 5.2 补丁 A：`ControlQueue`（`dsh-api-session-controller`）

建议把 `dsh-api-session-controller/lib/index.js:1158` 的构造点改为传入上限，`const queue = new ControlQueue(this.config.controlBufferBytes);`，并把类体改为：

```js
var ControlQueue = class {
	buffer = new Deque();
	bytes = 0;
	overflowed = false;
	wake;
	done = false;
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	/**
	* 超过字节预算即结束这一代：客户端重连后会重新领取完整 baseline，
	* 投影状态不会停留在中间态。
	*/
	push(frame) {
		if (this.done) return;
		const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		if (this.bytes + frameBytes > this.maxBytes) {
			this.overflowed = true;
			this.end();
			return;
		}
		this.buffer.pushBack({ frame, bytes: frameBytes });
		this.bytes += frameBytes;
		const wake = this.wake;
		this.wake = void 0;
		wake?.();
	}
	// end() 原样保留
	async *iterate(signal) {
		const onAbort = () => {
			this.end();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			while (!this.done && !signal.aborted) {
				const entry = this.buffer.popFront();
				if (entry !== void 0) {
					this.bytes -= entry.bytes;
					yield entry.frame;
					continue;
				}
				// 其余原样保留
```

建议默认值 `controlBufferBytes`：**2 MiB**。理由：控制流的帧是投影替换值，体积小，2 MiB 与终端 follower 的既有默认值一致，且足以容纳大量未拉取的替换帧。

### 5.3 补丁 B：`follow()` 的 `buffered`（`dsh-api-session-controller`）

`dsh-api-session-controller/lib/index.js:1449` 改为按字节计量的队列，入队处（`:1466` 与 `:1483`）各加一次判定，溢出即 `close()` 本地 follower：

```js
		const buffered = new Deque();
		let bufferedBytes = 0;
		const maxBufferedBytes = this.config.followBufferBytes;
		/** 入队一帧；超预算就关闭本 follower，让客户端带游标重连续传。 */
		const enqueue = (item, frameBytes) => {
			if (follower.closed) return;
			if (bufferedBytes + frameBytes > maxBufferedBytes) {
				close();
				return;
			}
			buffered.pushBack(item);
			bufferedBytes += frameBytes;
			notify();
		};
```

两个监听器分别改为 `enqueue({ type: "event", event }, Buffer.byteLength(JSON.stringify(event), "utf8"))` 与 `enqueue({ type: "assistant-stream", frame: wireAssistantStreamFrame(frame, cursorBeforeNext(agent.session.seq)), ordinal: ++assistantStreamOrdinal }, estimatedFrameBytes)`；出队处（`:1532`）相应减去已消费字节（`assistant-stream` 帧可按下标或按入队时记录的长度减）。

`session/created` 的 `pushFront` 分支（同文件 `:1472` 起）同样需要计入，否则该分支仍可无界。

建议默认值 `followBufferBytes`：**8 MiB**。理由：这条队列同时承载**有序持久事件**，单个事件可以很大（工具结果事件在上限内可达数百 KB），预算过小会导致重连风暴；8 MiB 能吸收一次大结果突发而不重连。

### 5.4 补丁 C：`RemoteEventQueue`（`dsh-api-gateway`）

`dsh-api-gateway/lib/index.js:1181` 的类改为按字节计量，并接受上限：

```js
var RemoteEventQueue = class {
	frames = new Deque();
	bytes = 0;
	waiter;
	closed = false;
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	push(frame) {
		if (this.closed) return;
		const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		if (this.bytes + frameBytes > this.maxBytes) {
			this.end();
			return;
		}
		this.frames.pushBack({ frame, bytes: frameBytes });
		this.bytes += frameBytes;
		this.waiter?.();
	}
```

构造点 `:818` 改为 `queue: new RemoteEventQueue(this.config.remoteEventQueueBytes),`，`iterate` 出队处相应递减 `this.bytes`。

建议默认值 `remoteEventQueueBytes`：**4 MiB**，与既有的 `streamInboxBytes` 并列，量级取 256 KiB 与终端 2 MiB 之间偏上。

### 5.5 超限语义：三处都应 fail 并让客户端重连，不应静默丢帧

不建议静默丢帧，理由按流分别成立，且都能在代码里验证：

- `follow` 的持久事件是**连续性校验**的。`:1546` 起的消费循环对序号有硬校验，`if (item.event.seq !== expectedSeq) throw new RemoteError("gateway/internal", ... session event stream skipped seq ...)`（该 `throw` 在 `:1548`）；静默丢一帧会让逻辑流直接失败，等于把可恢复的过载变成不可恢复的协议错误。
- 重连是**无损**的。`follow` 的入参语义就是"durable address and last committed sequence already held by the caller"（`lib/typert.host.js:1556` 的签名与 JSDoc），客户端 `RemoteJournalStream` 自带 `resumeCursor` 与按游标重开（`dsh-api-session-controller/lib/client.js:399` 与 `dsh-api-gateway/lib/client.js:1142` 起的 `RemoteJournalStream`）。关闭后客户端带游标重连，缺帧会被补齐。
- 控制流的帧是"完整 baseline + 替换帧"的幂等式设计，重连即重新领 baseline，语义天然自愈。
- `RemoteEventQueue` 的 `emit` 帧是转发来的外部事件，宿主无法重放，丢弃即永久丢失，所以只能 fail。

因此统一语义为：**超过预算则结束该条逻辑流，由客户端重连（并在需要时续传），而不是丢帧**。这与终端 follower 的既有行为（`this.close(); return;`）一致。

## 6. 建议新增的配置项

`@deepseek-ai/dsh-api-session-controller` 的 `Config` 目前只有一个字段（`dsh-api-session-controller/lib/index.js:2829`）：

```js
		static Config = z.object({ nativeOpen: z.boolean() });
```

`@deepseek-ai/dsh-api-gateway` 的 `Config`（`dsh-api-gateway/lib/index.js:596`）已有两个字段：

```js
	static Config = z.object({
		websocketHeartbeatIntervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS),
		streamInboxBytes: z.number().step(1).min(1).default(DEFAULT_STREAM_INBOX_BYTES)
	});
```

建议新增：

| 包 | 字段 | 类型与约束 | 默认值 | 语义 |
| --- | --- | --- | --- | --- |
| `dsh-api-session-controller` | `controlBufferBytes` | `z.number().step(1).min(1)` | `2 * 1024 * 1024` | 控制流单队列字节预算，超限结束该代 |
| `dsh-api-session-controller` | `followBufferBytes` | `z.number().step(1).min(1)` | `8 * 1024 * 1024` | 每会话 follow 队列字节预算，超限关闭 follower |
| `dsh-api-gateway` | `remoteEventQueueBytes` | `z.number().step(1).min(1)` | `4 * 1024 * 1024` | 每客户端 remote-event 队列字节预算，超限结束该流 |

三个字段都必须带 `.default(...)`：`nativeOpen` 声明为 `z.boolean()` 且无默认值，而出厂组合 `dsh-web-app` 挂载 `session-controller` 时并未传 config（该 row 只有 `id` 与 `name`），因此新字段若不带默认值会让现存的组合加载失败。

profile 的 `cordis.patch.yml` 应长这样（全部字段可省略，省略即用默认值）：

```yaml
- id: session-controller
  name: '@deepseek-ai/dsh-api-session-controller'
  config:
    controlBufferBytes: 2097152
    followBufferBytes: 8388608

- id: api-gateway
  name: '@deepseek-ai/dsh-api-gateway'
  config:
    remoteEventQueueBytes: 4194304
```

建议同时提供一个可观测退出信号，便于运维判断是"客户端慢"还是"服务端问题"：溢出时以 error 级日志打印包名、流类型、预算值与触发时的 follower/会话标识，与 `dsh-subprocess-local` 的 `logSpillFailure` 风格保持一致。

## 7. 上游验收标准

1. 溢出行为可测：把预算临时设为极小值（例如 `controlBufferBytes: 1024`），挂一个不拉取的客户端，确认宿主 RSS 停止增长，客户端的流以溢出错结束并自动重连，重连后收到完整 baseline 且功能正常。
2. 有序性不破：`followBufferBytes` 溢出重连后，客户端拿到的会话事件序号连续，不出现 `session event stream skipped seq`；用第 4 节的脚本核对重连前后 `seq` 无缝。
3. 无静默丢帧：在三个队列的溢出路径上都能观察到明确的失败原因，且失败原因可被客户端区分（不是无原因的流结束）。
4. 配置生效：三个字段在省略时使用默认值、在设置时生效、在给出非正数时以加载失败拒绝，行为与 `spill-policy` 对非法 `maxInlineTokens` 的处理一致。
5. 量级验收：用第 4 节的实测方法，对同一段会话做"停滞 60 秒"的对照实验，确认 RSS 增长被限制在预算加少量余量以内，而不是随停滞时长线性增长。
6. 回归：`ControlQueue` 与 `follow` 的正常路径（消费速率充足）不产生额外重连，连接数与会话打开行为与修复前一致。

## 8. 证据索引

定位用的稳定标识符（不依赖行号）：

| 标识符 | 文件（构建产物） | 行号 |
| --- | --- | --- |
| `var ControlQueue = class` | `dsh-api-session-controller/lib/index.js` | 1190 |
| `buffer = new Deque();` | 同上 | 1191 |
| `this.buffer.pushBack(frame);` | 同上 | 1196 |
| `async *iterate(signal) {` | 同上 | 1208 |
| `broadcast(frame) {` | 同上 | 1186 |
| `for (const stream of this.streams) stream.push(frame);` | 同上 | 1187 |
| `ctx.sessionProjections.onChanged(` | 同上 | 1137 |
| `async *control(signal) {` | 同上 | 1156 |
| `new ControlQueue(` | 同上 | 1158 |
| `async *follow(request, signal) {` | 同上 | 1445 |
| `const buffered = new Deque();` | 同上 | 1449 |
| `const disposeEvent = this.ctx.on("session/event"` | 同上 | 1464 |
| `buffered.pushBack({` | 同上 | 1466 |
| `session/created` | 同上 | 1472 |
| `const disposeAssistantStream = request.assistantStream !== true` | 同上 | 1481 |
| `buffered.pushBack({` | 同上 | 1483 |
| `while (!follower.closed && !signal.aborted) {` | 同上 | 1531 |
| `const item = buffered.popFront();` | 同上 | 1532 |
| `if (item.event.seq !== expectedSeq) throw new RemoteError("gateway/internal"` | 同上 | 1548 |
| `this.closeFollowers.delete(close);` | 同上 | 1559 |
| `static Config = z.object({ nativeOpen: z.boolean() });` | 同上 | 2829 |
| `assistantStream: true,` | `dsh-api-session-controller/lib/client.js` | 431 |
| `var SessionEventStream = class extends` | 同上 | 399 |
| `SessionFollowRequest` 声明 | `dsh-api-session-controller/lib/typert.host.js` | 2146 |
| `"signature": "@Remote({ mode: 'stream' }) follow(request: SessionFollowRequest, signal: AbortSignal)` | 同上 | 1556 |
| `var RemoteEventQueue = class` | `dsh-api-gateway/lib/index.js` | 1181 |
| `frames = new Deque();` | 同上 | 1182 |
| `this.frames.pushBack(frame);` | 同上 | 1187 |
| `queue: new RemoteEventQueue(),` | 同上 | 818 |
| `client.queue.push(wire);`（广播） | 同上 | 853 |
| `var UplinkInbox = class`（有界范式） | 同上 | 416 |
| `if (this.bytes + frameBytes > this.maxBytes) {` | 同上 | 438 |
| `uplink-overflow` | 同上 | 439 |
| `static Config = z.object({`（gateway） | 同上 | 596 |
| `streamInboxBytes:` | 同上 | 598 |
| `DEFAULT_STREAM_INBOX_BYTES = 262_144` | `dsh-api-gateway/lib/types/index.js` | 18 |
| `new UplinkInbox(this.streamInboxBytes, ...)` | `dsh-api-gateway/lib/types/stream-server.js` | 171 |
| `Keep one physical WebSocket` | `dsh-api-gateway/lib/client.js` | 322 |
| `const socket = new WebSocket(remoteStreamUrl());` | 同上 | 508 |
| `var RemoteJournalStream = class` | 同上 | 1142 |
| `var TerminalFollower = class`（有界范式） | `dsh-api-terminal-controller/lib/index.js` | 72 |
| `push(frame) {` | 同上 | 88 |
| `if (this.bytes + bytes > this.maxBytes) {` | 同上 | 91 |
| `Terminal output consumer exceeded its buffer` | 同上 | 92 |
| `this.close();` | 同上 | 93 |
| `new TerminalFollower(this.maxBufferedBytes)` | 同上 | 370 |
| `maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),` | 同上 | 751 |
| `get size()` / `pushBack` / `popFront` / `clear` | `dsh-deque/lib/index.js` | 18 / 25 / 47 / 58 |

以上行号在 0.2.0-rc.2 的安装产物上逐条复核过。

## 9. 未确定与未写入的部分

1. **45.47 GB 的归因未完成**。如第 4.3 节所述，本机实测的 assistant 帧流量与被观察到的 45.47 GB 相差约两个数量级，本文不主张这三处队列是该次事件的充分原因。缺少的是事发时刻的证据：DSH 不上报内存指标，也不落盘内存样本（运行时全树无 `process.memoryUsage()` 调用；`~/.dsh/logs` 只有三次启动日志；`~/Library/Logs/DiagnosticReports` 无对应崩溃报告），因此事发进程与增长曲线无法回溯。
2. **未测** `broadcast` 推入 `ControlQueue` 的投影帧的真实体积与频率。第 4 节的方法是逐帧可测的（投影值随帧一起持久化），但本次只测量了 assistant 帧通道。
3. **未测** 客户端侧（渲染进程）的对称队列。`dsh-api-gateway/lib/client.js:632` 的 `this.frames.pushBack(frame)` 与 `:677` 的 `this.items.pushBack(item)` 也是同样的无界形态，本次未展开，因为宿主侧才是本轮调查目标。
4. **未确认** 多 follower 并存的真实数量。`closeFollowers` 与 `remoteEventClients` 都是进程内集合，运行中的实例没有可用的检查入口；需要隔离实例加探针才能量。
5. **补丁未经编译验证**。本文只读 DSH 包，未改动、未构建、未测试；第 5 节的片段是照搬既有范式的等价改动，落地前需按第 7 节验收。
6. **行号与源码仓库不一致**。所有行号指向 asar 内的构建产物，上游源码树的对应位置需用第 8 节的标识符检索。
