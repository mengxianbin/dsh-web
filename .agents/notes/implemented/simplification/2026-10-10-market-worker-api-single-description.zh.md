# Agent Note: 让市场 worker 的公开 API 只有一个描述权威

Status: implemented

## Problem

市场 worker 的 HTTP 表面被描述了三遍，而这三份描述已经互不一致。`market/worker/src/index.js`（599 行）是路由器；`market/worker/src/openapi.js`（205 行）是在 `/openapi.json` 提供的 OpenAPI 文档；`market/worker/src/api-doc.js`（54 行）与 `market/worker/src/api-catalog.js`（21 行）分别是人读页面与 `/.well-known/api-catalog` 上的 RFC 9727 linkset。

与路由器对照，文档已经落后：`index.js` 处理 17 条字面 `/api/...` 路径，`openapi.js` 只写了 12 条。已提供但未记录的有 `/api/install-batch`、`/api/asset-attest`、`/api/relay/register`、`/api/relay/unregister` 与 `/api/skin-center/v2/skins/`。catalog 与文档页继承同一份清单，因此读公开描述的消费方发现不了站点自己在用的批量安装与中继注册。

`scripts/market-worker.test.mjs` 钉住的是 catalog 的形状而不是它的覆盖度，这正是缺口得以存活的原因：新增一条路由而不写描述条目，不会有任何东西失败。

## Decision

`market/worker/src/api-surface.js` 是描述权威：每条路由一个 `API_ROUTES` 条目，携带方法、路径、OpenAPI summary、OpenAPI operation 对象，以及人读页面的中文说明与状态列。表中列出 18 条路由，其中四条是路由器已在提供、而两份文档都没写的：`/api/asset-attest`、`/api/install-batch`、`/api/relay/register` 与 `/api/relay/unregister`。

`openapi.js`（205 行变 27 行）与 `api-doc.js`（54 行变 56 行）改为从该表组装输出，不再各自持有清单；页面保留外壳与示例，所提供的文档保留目录所链接的形状，`api-catalog.js` 不变。

`scripts/market-worker.test.mjs` 新增一个测试：它从路由器源码推导已提供的 API 路径（`path ===` 与 `path.startsWith` 字面量，排除 `/api-docs.html` 页面并把皮肤中心前缀映射为其文档化形状），当该集合与表在两个方向上不一致时失败。

## Context & Efficiency Impact

没有运行时行为变化：路由、响应与所提供文档的内容保持现状，只是把缺失的五条路径在本次改动中补进描述。这项工作是删除一套结构，而不是删除一个能力：三份描述中的一份不再作为独立清单存在。

维护上的收益是新增一条路由不再需要记得另外两个文件，而测试今天看不见的漂移变得不可能发生。

## Evidence

- 路由器路径（17 条字面量）与文档路径（12 条字面量），分别读自 `market/worker/src/index.js` 与 `market/worker/src/openapi.js`。
- `market/worker/src/api-catalog.js` 把 `/openapi.json` 与 `/api-docs.html` 作为服务描述与文档链接出来，因此两者是公开契约表面而不是内部笔记。
- `scripts/market-worker.test.mjs` 断言 catalog 的 linkset 形状（分页与钳制用例），但没有任何断言要求每条已提供的路径都出现在描述里。
- 五条未记录的路由都是在用的：`/api/install-batch` 承载市场卡片执行的批量安装，`/api/relay/register` 与 `/api/relay/unregister` 服务 `dsh-remote-web-ui` 的固定域名中继，`/api/asset-attest` 由 `scripts/market-verify-assets.mjs` 读取。
- 没有 Agent Note 拥有这些描述文件；涉及 worker 的记录（`2026-09-02-stable-hostname-relay` 与遥测相关记录）写的是路由本身，不是描述表面。

## Alternatives considered

- **保留三个文件，只加一道覆盖度测试。** 作为主提案否决：它让缺口大声失败，却仍留下三份要更新的清单，`openapi.js` 里的文字仍需为每条路由手改。
- **由 OpenAPI 文档生成路由器。** 否决：每条路由各自带着 D1、Turnstile 与缓存行为，路由器才是行为来源、文档是派生物；由后者生成前者会颠倒归属。
- **删掉 OpenAPI 文档，只提供人读页面。** 否决：该文档是首页所链接公开表面的机器可读半边，删它是移除能力而不是移除重复。
- **保留漂移，只在页面里补写这五条缺失路由。** 否决：这种漂移是机械性的，会随之后的每条路由复发，而单表正是要消除它。

## Testing

- `node --test scripts/market-worker.test.mjs` 60 个用例全绿，含新增的覆盖度测试；`pnpm test:scripts` 373 个全绿。
- `/openapi.json` 现在有 18 条路径（此前 14 条），`/api-docs.html` 渲染 18 行。
- `pnpm market:check` 报告 `market/dist` 已是最新：worker 从 `src` 提供这些文档，已提交的站点构建未被改动。

## Risks

- 生成的文档会失去 `openapi.js` 今天携带的手工排序与示例；逐路由描述文本保住了文字，但 `/openapi.json` 的形状会变，因此比对它的消费方会看到变化，尽管 API 本身没变。
- 路由表成为新的单点故障：在它之外注册的路由对描述与覆盖度测试都不可见，因此测试应当从路由器自身的注册出发断言，而不是从一份手工维护的清单出发。
- worker 由 `deploy-market.yml` 部署；该改动必须随站点构建一起发布，而不是只随插件家族发布，否则会出现一个版本期内"公开描述与已部署 worker 不一致"。
