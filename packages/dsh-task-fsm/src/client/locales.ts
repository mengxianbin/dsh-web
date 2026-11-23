/**
 * Locale dictionaries for the dsh-task-fsm browser half (zh + en). Copy is
 * registered under the `dsh-task-fsm` namespace; unknown languages fall back
 * to zh (document-language fallback kept in the components' `t` shim).
 * @module @linxin666/dsh-task-fsm/client/locales
 */

export const NS = 'dsh-task-fsm'

export const zh = {
  'fsm.tier.red': '队列红档',
  'fsm.tier.yellow': '队列黄档',
  'fsm.what': '等什么',
  'fsm.why': '为什么',
  'fsm.who': '谁',
  'fsm.next': '下一步',
  'fsm.frozen': '已冻结',
  'fsm.locked': '已锁定',
  'fsm.freeze.reason': '冻结原因',
  'fsm.frozen.readonly': '会话已冻结 · 只读快照（不解冻）',
} as const

export const en = {
  'fsm.tier.red': 'Queue: red',
  'fsm.tier.yellow': 'Queue: yellow',
  'fsm.what': 'Waiting on',
  'fsm.why': 'Why',
  'fsm.who': 'Owner',
  'fsm.next': 'Next step',
  'fsm.frozen': 'Frozen',
  'fsm.locked': 'Locked',
  'fsm.freeze.reason': 'Freeze reason',
  'fsm.frozen.readonly': 'Session frozen · read-only snapshot',
} as const

export type FsmKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-task-fsm UI copy. */
    'dsh-task-fsm': FsmKey
  }
}

let runtimeTranslate: ((key: FsmKey) => string) | undefined

/** Install the locale-bound translator (ctx.locale.bind(NS)); keeps zh fallback. */
export function setRuntimeTranslate(fn: (key: string) => string): void {
  runtimeTranslate = fn as (key: FsmKey) => string
}

/** Translate one key through the bound locale, falling back to the zh dict. */
export function t(key: FsmKey): string {
  try {
    const bound = runtimeTranslate?.(key)
    if (typeof bound === 'string' && bound !== '' && bound !== key) return bound
  } catch {
    // Locale service absent — fall through to the zh dictionary.
  }
  return zh[key]
}
