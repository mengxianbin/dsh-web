# Agent Note: archive-override 写回应答不再全量扫描 sessions 根

Status: implemented

## Problem

`POST /archive-override`（原生对话框的台账写回，契约 C4）每次都先付
`dirIndex.get()`——对 sessions 根做一次全量行走，含每个项目目录与分段的
`dirSize` 递归。在生产根（2127 个会话目录）上实测（2026-11-17，取证见
m-note `content/tech/ai/dsh/archive-inline-fix-1116.md`）：热行走约 1.3 秒、
冷行走约 14.5 秒。而这条路径根本用不到它：原生通道始终带着刚算好的 seal
一起提交，`mode: "note"` 从不判定 seal，只有不带 seal 的 `force` 才需要
transcript 目录——但每次调用都重走全树。客户端在 `SEAL_GATE_TIMEOUT_MS =
5000` 处中止写回，于是响应被例行丢弃（实测 4 次里 3 次以 `-` 收场），而
服务端照常跑完：台账 flush 先于响应，数据没丢，但面板上每次归档都显示写回
失败。

## Decision

`ArchiveService.archiveOverride` 只在必须自己算 seal 时才解析 transcript
目录——即 `mode === "force"` 且调用方未给 `seal`——且经由
`resolveSessionDirs`：`sealCheck` 已在用的按名定向探针（只 readdir 顶层
项目目录、无 `dirSize`、含 containment 校验；`tests/seal-targeted-read.spec.ts`
已证明它与全量索引按这些 id 取交的结果相等）。带 seal 的 `force` 与 `note`
完全不碰 sessions 树。seal 判定本身零改动：`analyzeSeal` 收到的仍是全量索引
本会给的那个目录（`index.byId.get(id)` 与 `resolveSessionDirs(...).get(id)`
由上述证明知相等），调用方传入的 seal 仍原样落账。

## Testing

`tests/archive-override.spec.ts` 新增四个用例，借既有 `dirIndex.scans` 计数器
钉住新的读取模式：带 seal 的 `force` 以零扫描回填传入的 seal；不带 seal 的
`force` 仍推导出 `stale` 与 `UNSEALED:save-tail-no-sentinel`，同样零扫描；
`note` 写入其标记且零扫描；最后一个对照用例随后驱动一次真实 inventory 构建，
证明计数器仍能到达 1——前面的零表示"跳过了"，不是"坏了"。既有 C3/C4/C5 契约
用例原样通过。

## Alternatives considered

- **保留扫描、缩短 TTL**：2 秒窗口本已覆盖面板的请求突发；它救不了第一次
  （冷）行走，而冷行走正是撞破 5 秒中止线的那一次。
- **把扫描挪出事件循环**：消除事件循环停顿，但每次写回仍留约 1.3 秒热行走
  ——中止线还在，面板照样等数秒。
- **让写回走轮次结束的 seal-state worker**：那条缝本就离线算 seal，但写回的
  seal 来自客户端，走过去只会是空转。

## Consequences

写回延迟从秒级降到毫秒级，客户端中止随之消失。全量索引只剩一个消费者——
inventory 构建，它本来就需要每个目录的大小。不带 seal 的 `force` 用"每次调用
定向探针"换掉了"可能已热的全量索引"；这很便宜（每个项目目录一次 readdir，
仅命中的 id 才 stat/realpath），且该路径罕见：原生对话框总带 seal，REST 归档
门则在别处自己调 `analyzeSeal`，不经这里。
