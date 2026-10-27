/**
 * The re-login page served at GET /api/mimo-relogin/page: one loopback-only
 * HTML document with the three actions (silent renewal, open the login
 * window, capture) plus the paste fallback, a 15s status/balance poll, and a
 * hop list for renewal diagnostics. Everything inline (CSP-restricted, no
 * external assets); copy is Chinese because the operator is — the i18n audit
 * reports host-half CJK as a warning only.
 * @module dsh-mimo-relogin/host/page
 */

/** Path the kit serves its page on. */
export const PAGE_PATH = '/api/mimo-relogin/page'

/** The page document. */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiMo 平台凭据重登</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, "Segoe UI", sans-serif; margin: 0; padding: 24px; max-width: 720px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #7a7f87; margin-bottom: 18px; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .chip { border: 1px solid rgba(128,128,128,.4); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  .chip.ok { border-color: #2f9e44; color: #2f9e44; }
  .chip.bad { border-color: #e03131; color: #e03131; }
  .balance { font-size: 26px; font-weight: 600; }
  .balance small { font-size: 13px; font-weight: 400; color: #7a7f87; }
  button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid rgba(128,128,128,.5); background: transparent; cursor: pointer; }
  button.primary { background: #1971c2; border-color: #1971c2; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
  textarea { width: 100%; min-height: 64px; box-sizing: border-box; font: 12px/1.4 Consolas, monospace; }
  select { font: inherit; }
  #result { min-height: 22px; font-size: 13px; white-space: pre-wrap; word-break: break-all; }
  #result.err { color: #e03131; }
  #result.good { color: #2f9e44; }
  details { margin-top: 8px; font-size: 12px; color: #7a7f87; }
  code { font: 12px/1.5 Consolas, monospace; }
  hr { border: none; border-top: 1px solid rgba(128,128,128,.25); margin: 14px 0; }
</style>
</head>
<body>
<h1>MiMo 平台凭据重登</h1>
<div class="sub">给 dsh 的 MiMo 余额探测换新 cookie。三个动作按需选择；粘贴只作兜底。余额入库后侧栏最多一分钟内刷新。</div>

<div class="card">
  <div class="chips">
    <span class="chip" id="chip-chrome">调试窗口 …</span>
    <span class="chip" id="chip-platform">平台凭据 …</span>
    <span class="chip" id="chip-account">账号凭据 …</span>
    <span class="chip" id="chip-usage">dsh-usage …</span>
  </div>
  <div class="balance" id="balance">— <small>读取中</small></div>
</div>

<div class="card">
  <div class="row">
    <button class="primary" id="btn-renew">免登录续期</button>
    <span class="sub" style="margin:0">用已存账号凭据静默换新会话，不用打开浏览器（凭据在档时通常直接成功）</span>
  </div>
  <div class="row">
    <button id="btn-open">打开登录窗</button>
    <span class="sub" style="margin:0">专用调试 Chrome 打开平台（已在运行则新开标签页），在窗口里完成登录</span>
  </div>
  <div class="row">
    <button id="btn-capture">抓取登录态</button>
    <span class="sub" style="margin:0">从调试窗口读取最新 cookie 并入库（登录完成后点它）</span>
  </div>
  <hr>
  <div class="row">
    <select id="paste-slot">
      <option value="platform">粘贴：平台 Cookie（MIMO_PLATFORM_COOKIE）</option>
      <option value="account">粘贴：账号 Cookie（MIMO_ACCOUNT_COOKIES，续期燃料）</option>
    </select>
  </div>
  <textarea id="paste-cookie" placeholder="从浏览器 DevTools 复制的整行 Cookie 头，形如 api-platform_serviceToken=…; userId=…"></textarea>
  <div class="row" style="margin-top:8px">
    <button id="btn-paste">保存粘贴</button>
    <span class="sub" style="margin:0">兜底通道：保存前会先用它探测一次余额，不通过则不入库</span>
  </div>
</div>

<div id="result"></div>

<details id="hops" hidden><summary>续期链路明细</summary><pre id="hop-list"></pre></details>

<script>
const api = (path, body) => fetch(path, {
  method: 'POST',
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => {
  let data = null
  try { data = await r.json() } catch { /* non-json */ }
  return { status: r.status, data }
})
const $ = (id) => document.getElementById(id)
const setResult = (text, cls) => { const el = $('result'); el.textContent = text; el.className = cls || '' }
const setChip = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = 'chip' + (cls ? ' ' + cls : '') }
let busy = false
const act = async (path, body, label) => {
  if (busy) return
  busy = true
  for (const b of document.querySelectorAll('button')) b.disabled = true
  setResult(label + ' …')
  try {
    const { status, data } = await api(path, body)
    if (data && data.ok) {
      setResult(label + '：完成' + (data.balance && data.balance.balance ? '，余额 ' + data.balance.balance + ' ' + (data.balance.currency || '') : ''), 'good')
      if (data.hops) showHops(data.hops)
    } else {
      setResult(label + '：失败 HTTP ' + status + ' — ' + ((data && (data.error || data.note)) || '无详情' + (data && data.hops ? '' : '')), 'err')
      if (data && data.hops) showHops(data.hops)
    }
  } catch (e) { setResult(label + '：请求异常 ' + e, 'err') }
  await load()
  busy = false
  for (const b of document.querySelectorAll('button')) b.disabled = false
}
const showHops = (hops) => {
  const box = $('hops'), list = $('hop-list')
  list.textContent = hops.map((h) => h.host + h.path + ' → ' + h.status + (h.setCookies ? '  [' + h.setCookies.join(', ') + ']' : '')).join('\\n')
  box.hidden = hops.length === 0
}
const load = async () => {
  const [statusRes, overviewRes] = await Promise.all([
    api('/api/mimo-relogin/status'),
    api('/api/dsh-usage/overview'),
  ])
  const s = statusRes.data
  if (s) {
    setChip('chip-chrome', s.chrome ? '调试窗口 在线' : '调试窗口 未运行', s.chrome ? 'ok' : 'bad')
    setChip('chip-platform', s.stored.platform ? '平台凭据 已存' : '平台凭据 未存', s.stored.platform ? 'ok' : 'bad')
    setChip('chip-account', s.stored.account ? '账号凭据 已存' : '账号凭据 未存', s.stored.account ? 'ok' : 'bad')
  }
  const doc = overviewRes.data
  const mimo = doc && doc.providers && doc.providers.find((p) => p.provider === 'mimo')
  if (!doc) { setChip('chip-usage', 'dsh-usage 未响应', 'bad'); return }
  setChip('chip-usage', 'dsh-usage 在线', 'ok')
  const el = $('balance')
  if (mimo && mimo.balance) {
    el.innerHTML = ''
    el.append(mimo.balance.totalBalance + ' ' + (mimo.balance.currency || ''))
    const small = document.createElement('small')
    small.textContent = '（探测于 ' + new Date(mimo.balance.updatedAt).toLocaleString() + '）'
    el.append(small)
  } else if (mimo && mimo.error) {
    el.innerHTML = ''
    el.append('— ')
    const small = document.createElement('small')
    small.textContent = '探测失败：' + mimo.error + '（等待下一轮或先做上面的动作）'
    el.append(small)
  } else {
    el.innerHTML = '— <small>无余额数据</small>'
  }
}
$('btn-renew').onclick = () => act('/api/mimo-relogin/renew', undefined, '免登录续期')
$('btn-open').onclick = () => act('/api/mimo-relogin/open', undefined, '打开登录窗')
$('btn-capture').onclick = () => act('/api/mimo-relogin/capture', undefined, '抓取登录态')
$('btn-paste').onclick = () => act('/api/mimo-relogin/paste', { slot: $('paste-slot').value, cookie: $('paste-cookie').value }, '保存粘贴')
load()
setInterval(load, 15000)
</script>
</body>
</html>
`
