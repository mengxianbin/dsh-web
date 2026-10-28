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
  'chip.netDetail': '网络 往返 {rtt}',
  'chip.netIdle': '网络 暂无读数',
  'chip.netPath': '测量口径：到 {target} 的 ICMP 往返（ping）——纯网络层时延，不含 DNS/TCP/TLS 握手与代理开销',
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
  'chip.netDetail': 'Net round trip {rtt}',
  'chip.netIdle': 'Net no reading yet',
  'chip.netPath': 'Measurement: ICMP echo round trip to {target} (ping) — network-layer latency only, no DNS/TCP/TLS handshake or proxy overhead',
  'chip.stamp': 'Refreshed at {t}',
}
