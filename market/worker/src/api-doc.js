/**
 * Human-readable API documentation page. Served at GET /api-docs.html and
 * linked from the API catalog as service-doc.
 *
 * The endpoint table is rendered from API_ROUTES (api-surface.js), the single
 * description authority for this API; a new route is described there, not here.
 */
import { API_ROUTES } from './api-surface.js'

/** One table row per described route, in table order. */
const rows = API_ROUTES
  .map(route => `<tr><td>${route.method}</td><td><code>${route.path}</code></td><td>${route.doc}</td><td>${route.status}</td></tr>`)
  .join('\n')

export default `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 创意工坊 API 文档</title>
<style>
body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2937; max-width: 780px; margin: 24px auto; padding: 0 16px; }
h1 { font-size: 22px; }
h2 { font-size: 17px; margin-top: 28px; }
code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; font-size: 13px; vertical-align: top; }
th { background: #f9fafb; }
</style>
</head>
<body>
<h1>DSH 创意工坊 API 文档</h1>
<p>dsh-market.com 的边缘 API（Cloudflare Workers + D1），承载点赞计数、皮肤资产分发与健康检查。机器可读描述见 <a href="/openapi.json">/openapi.json</a>（OpenAPI 3.1），目录见 <code>/.well-known/api-catalog</code>。</p>

<h2>端点</h2>
<table>
<thead>${rows}
</tbody>
</table>

<h2>示例</h2>
<pre><code>$ curl -s https://dsh-market.com/api/health
{"ok":true}

$ curl -s https://dsh-market.com/api/stats
{"skin":{"harbor":7},"pet":{},"plugin":{}}</code></pre>
</body>
</html>
`