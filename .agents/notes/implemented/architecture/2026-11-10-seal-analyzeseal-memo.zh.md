# Agent Note: analyzeSeal 判定按转录 mtime+size 记忆化

Status: implemented

## 问题

每一次 `POST /seal-check`、每一次归档门裁决都从头重算会话的 seal 判定：`analyzeSeal` 对 zstd 转录整读 `readFileSync`、逐帧解压、逐行 `JSON.parse` 找 `SAVE_STATUS` 哨兵——zstd 帧不能只读尾部，因此没有廉价路径。2026-11-10 访问日志的 seal-check 当日计数 = n=122、avg 3337ms、max 13056ms（日占空 407s），转录没变也每次重算。一次归档点击会连闯同一道门三次（前置预检、门本体、归档后复检/行灯刷新），同一份字节在几秒内被反复判定。

## 决定

- **记忆化放进 `analyzeSeal` 本体**（`packages/dsh-session-archive/src/host/seal.ts`）。契约 C1 保持全插件唯一分组实现，而两个通道——`POST /seal-check` 端点（经 `service.sealCheck`）与归档门在 `ArchiveService.archive` 里的直调——都调用这个函数，放在这里即自动被整个端点面共享，不需要第二份缓存来保持一致。
- **键 = 转录绝对路径 + `mtimeMs` + `size`，在读取之前打戳。** append（唯一写入方是 harness，在本插件之外）会改变戳，于是下一次调用未命中并重算——失效不需要任何显式钩子，规则与 seal-light 按会话缓存同口径（转录 append 即作废重算）。
- **先打戳后读取的顺序是契约的一部分**：读后打戳可能把 append 后的键配上 append 前的内容，并永远供应这份陈旧判定；先打戳只会让「旧键配新内容」在下次调用必然重算（安全方向）。LEGACY 切线复用同一个预读戳，因此 stat 失败仍读作「严格现代规则」（保守），与记忆化之前完全一致。
- **读/解码失败永不记忆化**——它们是瞬态的（锁、撕裂打开），即使戳没变也必须在下次调用重试。内容派生的结果（含空转录各档）才记忆化。
- **背书复算的 git 判定随缓存走**（戳窗口内）——与 seal-light 设计记录的取舍相同。没有转录写入的 git 态变化沿用旧读数，且失败方向保守：未背书的 DONE 在下次 append 前保持被拦，绝不会假绿。
- **有界 LRU，上限 4096**（高于 ~1900 活跃会话）：插入序 Map，命中即重插，超限丢最老。命中时把 `id` 重新盖到缓存结果上，使一个文件绝不会以别的会话 id 作答。`clearSealMemo()` / `sealMemoStats()` 导出全量重置与命中/未命中计数器供测试用。

## 备选考量

- **单条目 TTL 记忆化（`TtlMemo`，dir-index 先例）**：否决。seal 流量交织多会话（批量 seal-check、每 100–150s 行灯扫掠），单槽会颠簸到零复用；且 TTL 式失效会在窗口内供应陈旧判定，而 mtime+size 键是精确且免费的（一次 `statSync`）。
- **转录内容哈希**：否决。算哈希必须整读整哈希——正是记忆化要避免的那份 I/O；stat 戳以近零成本给出同样的新鲜度信号。
- **读后打戳（最顺手的插入序）**：否决不安全——见「决定」：并发 append 下会把 append 后的键钉在 append 前的内容上，一直供应到下一次写入。
- **只在端点/服务层记忆化**：否决。归档门直调 `analyzeSeal`，绕过任何端点层缓存——两份缓存要保持一致，且门本体（每次点击三次的昂贵路径）依旧全冷，第二份分组面还会挤压契约 C1。
- **干脆依赖 seal-light 宿主态缓存（本处不动）**：互补而非替代。那单（harness 侧，`#seal-light-host-state-1109`，现 T2 停手）为行灯/list 平面缓存；本记忆化覆盖其未覆盖的残留面——归档门 POST 的实时调用——且两者共用同一 append 失效规则，其「缓存方挪位」路径可直接复用本缓存。

## 后果

- 热调用 = 一次 `readdirSync`（转录选择）+ 一次 `statSync` + Map 查找——p95 ≤ 200ms 验收线余量很大；冷调用保持原先的全量推导成本。
- git 态变化（未背书 DONE 之后 push 落地）在下一次转录 append 前不重算；可观察方向只会多拦、绝不漏红。
- 记忆化随宿主进程：重启即丢（此后每个转录一次冷调用），且只有宿主评估 seal，不存在跨进程一致性问题。
- seal 线以 profile 热修形态交付（本分支 build 后 `build + cp` 进 `~/.dsh/profiles/web/node_modules/@linxin666/dsh-session-archive/lib`）；在重打与宿主重启之前，运行中宿主仍是无缓存旧码——收口 ≠ 生效。
- 本分支（`local/seal-analyzeseal-cache-1110`）基于 `local/seal-backtick-miditem-1109`（已部署谱系尖端）并保持本地：seal 线是否上游合入 `dev` 仍是归用户的 T2 决定。

## 测试

`tests/seal-memo.spec.ts`（4 例）：记忆化命中以一次推导供应未变判定；追加一帧 zstd 使 NEUTRAL → `sentinel-pending` 并重算（负例，misses 1 → 2）；命中为请求的 id 重新盖戳；30 次热调用 p95 ≤ 200ms 且 hits=30。包 `typecheck`（tsgo 双配置）与 `vitest run`（22 文件 226/226）全过；改动文件 `oxlint` 干净；`test-standards --check` 对新文件零违规（包内其余文件带 seal 谱系既有的基线债务，本单未触碰）。
