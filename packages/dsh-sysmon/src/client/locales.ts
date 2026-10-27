/**
 * Locale dictionaries for the sysmon chip. `zh` is the key-set source of
 * truth; `en` keeps a full key-for-key mirror (packages/AGENTS.md bilingual
 * rules). Registered through ctx.locale.register(NS, { zh, en }); the ru
 * mirror lives centrally in packages/dsh-i18n.
 */

/** Simplified Chinese dictionary (key-set source of truth). */
export const zh = {
  'chip.aria': '系统负载',
  'chip.cpu': 'CPU',
  'chip.mem': '内存',
  'chip.disk': '磁盘',
  'chip.net': '网络',
  'chip.title': '系统负载（1s 采样 · 宿主常驻）',
  'chip.diskDetail': '磁盘 读 {read} · 写 {write} MB/s',
  'chip.memDetail': '内存 {used} / {total} GB · 可用 {avail} GB',
  'chip.netDetail': '网络 连接 {conn} · 10 分钟失败 {failures} 次',
  'chip.netProvider': '路由 {provider}',
  'chip.netIdle': '网络 近 10 分钟无模型请求',
  'chip.netPathDirect': '连接口径：直连——DNS + TCP + TLS 握手全段真网络',
  'chip.netPathProxy': '连接口径：经本机 HTTP 代理——到代理的 TCP 为回环不算网络，读数 = CONNECT 应答 + TLS 隧道握手（≈真 RTT）',
  'chip.stamp': '数据刷新于 {t}',
}

/** The sysmon namespace key union. */
export type SysmonKey = keyof typeof zh

/** English dictionary, key-for-key complete against zh. */
export const en: Record<SysmonKey, string> = {
  'chip.aria': 'System load',
  'chip.cpu': 'CPU',
  'chip.mem': 'Mem',
  'chip.disk': 'Disk',
  'chip.net': 'Net',
  'chip.title': 'System load (1s sampling, host-resident)',
  'chip.diskDetail': 'Disk {read} read · {write} write MB/s',
  'chip.memDetail': 'Memory {used} / {total} GB · {avail} GB available',
  'chip.netDetail': 'Net connect {conn} · {failures} failures in 10 min',
  'chip.netProvider': 'Route {provider}',
  'chip.netIdle': 'Net no model requests in the last 10 minutes',
  'chip.netPathDirect': 'Connect path: direct — DNS + TCP + TLS handshake, all real network',
  'chip.netPathProxy': 'Connect path: via local HTTP proxy — TCP to the proxy is loopback (not network); reading = CONNECT reply + TLS tunnel handshake (~true RTT)',
  'chip.stamp': 'Refreshed at {t}',
}
