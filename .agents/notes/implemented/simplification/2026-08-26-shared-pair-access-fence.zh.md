# Agent Note: 经 sync-shared 共享配对信任闸门（pair-access）

Status: implemented

## Problem

三个插件——git-graph（`src/host/access.ts`）、pet（`src/access.ts`）与 skill-explorer（`src/access.ts`）——各自携带逐字节相同的信任闸门判定逻辑（loopback 短路、`remoteWebUiPairing` 结构化查找及 ctx.get/属性回退），差别仅在导出函数名与头注释。安全检查的重复副本必须同步漂移，否则会静默分叉；审计点名了全部三处位置及其三份克隆测试。

## Decision

判定逻辑现在只存在一份：`shared/host/pair-access.ts`（`isPairedOrLoopbackAllowed`），通过既有 `scripts/sync-shared.mjs` 副本表以生成副本分发到三个包——与 `loopback.ts`/`http.ts`/`dsh-home.ts` 的同步机制相同。每个包保留手写的 `access.ts` 薄包装，导出自描述的名字（`isGitAllowed`、`isPetAllowed`、`isSkillExplorerAllowed`）并委托给同步副本，调用方零改动。核心逻辑的权威测试落在 `shared/tests/pair-access.spec.ts`；各包的包装规格保留为接线测试。

## Follow-up (2026-10-24, issue #1942)

只要 `ctx.get` 没给出配对服务，闸门就会把 `ctx.remoteWebUiPairing` 当**属性**读取。在真实 cordis 上下文里，读一个该行从未注入的服务会抛错（`cannot get property "remoteWebUiPairing" without inject`），异常从各路由处理器逃逸到宿主 web server 的兜底 catch，变成一个空 body 的 400，而不是设计中的 403。于是只注入 `webServer` 的插件——dsh-usage、dsh-git-graph、dsh-skill-explorer 与 pet——在 remote-web-ui 未加载时，每个非回环请求都会失败。查找逻辑现在收敛成 `lookupPairing()`：存在 `get(name, false)` 时只走它，属性回退被包在保护里，读不到服务就按「未配对」作答。本仓的生成副本与 pet 卫星仓携带同一道保护，共享规格与各包接线规格都对「属性读取抛错」这一情形做了固定。

## Alternatives considered

新建共享运行时包以依赖方式引入的方案被否决：本仓所有既有共享助手都经 sync-shared 副本分发（各包必须可独立发布，不能引入 workspace 内部依赖链），pair-access 不应成为第一个例外。彻底去掉包装（调用方统一改用单一函数名）被否决，属于无谓 churn——包装保留了各包的公开词汇并注明闸门守护的路由。同步测试文件的方案被否决：sync-shared 只复制源文件，且各包规格兼作接线验证。已弃用的 dsh-aionui-panel（2026-08-28 彻底移除）没有闸门代码（纯 client），无可合并内容。

## Consequences

闸门修复现在只需改一份共享源码并运行 `node scripts/sync-shared.mjs`；任何副本分叉都会被漂移门禁（`test:scripts`）在 CI 拦下。sync-shared 测试的副本计数桶随之更新（总条目 97→100，host 副本 45→48），其临时目录假树新增 pair-access 源文件。无行为变化：逻辑相同，由各包未改动的规格验证。

## Testing

`pnpm test:scripts`（副本计数与漂移套件）、`pnpm docs:check`，以及 dsh-git-graph（141）、dsh-pet（445）、dsh-skill-explorer（72）三包各自的 `pnpm typecheck` + `pnpm test`——全部通过。共享规格：shared/tests 共 15 项（pair-access + loopback）。当日跟进：根级 `pnpm typecheck` 暴露共享源文件不得导入 `@deepseek-ai/cordis`（shared 包须在无该依赖下独立通过 typecheck），因此闸门签名改为接受两成员的结构化 context 形状（cordis `Context` 天然满足）；各包包装签名不变。
