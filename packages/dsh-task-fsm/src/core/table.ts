/**
 * State x event transition table — the machine authority of the pure-worker
 * design (pure-worker-design-1123 §2.3). Every (state, event) cell is an
 * explicit three-way entry: `transfer` (with guards + design-row note),
 * `forbid` (event recognized but refused here) or `na` (event cannot occur
 * here). The completeness spec asserts the three buckets of each state cover
 * exactly the 21 events — a missing cell fails the test, never the runtime
 * (§2.3: 完备性测试期炸、不留运行期).
 *
 * States mirror the six-value `state` enum of §2.6: backlog = `[ ]`,
 * active = `[/]`, deferred = `[/] ⏸`, blocked = `[/] ⛔`, done = `[x]`,
 * cancelled = `[-]`. The A-axis checkbox vocabulary itself is frozen
 * (对账边界④) — this table only consumes it.
 * @module @linxin666/dsh-task-fsm/core/table
 */

/** 主态轴 (A) — the six machine states behind the checkbox vocabulary. */
export type State = 'backlog' | 'active' | 'deferred' | 'blocked' | 'done' | 'cancelled'

/** Every state in table order (completeness iteration order). */
export const STATES: readonly State[] = [
  'backlog', 'active', 'deferred', 'blocked', 'done', 'cancelled',
]

/** Event set (E) — design §2.3, E1–E21. */
export type EventId =
  | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9' | 'E10' | 'E11'
  | 'E12' | 'E13' | 'E14' | 'E15' | 'E16' | 'E17' | 'E18' | 'E19' | 'E20' | 'E21'

/** Every event in numeric order (completeness iteration order). */
export const EVENTS: readonly EventId[] = [
  'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10', 'E11',
  'E12', 'E13', 'E14', 'E15', 'E16', 'E17', 'E18', 'E19', 'E20', 'E21',
]

/** Human labels for the events (docs + hover copy anchors). */
export const EVENT_LABELS: Readonly<Record<EventId, string>> = {
  E1: '派发', E2: '开工核验过', E3: '开工核验拦', E4: '步进', E5: '缺前置发现',
  E6: '前置终态到达', E7: '配额空到达', E8: '验收过', E9: '验收不过（可修）',
  E10: '修 N 轮熔断', E11: '判据争议', E12: '不可逆损害', E13: '断链（心跳死）',
  E14: '机械重派', E15: '人中止', E16: 'scope 取消', E17: '收口 save',
  E18: '终态通知人', E19: '人查收回执', E20: '等待开始（不驻留）', E21: '黄灯人裁完',
}

/** Guard ids from §2.4 (G1–G6) plus two cell-local precondition tokens. */
export type GuardId =
  | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6'
  /** E19 precondition: the record is actually awaiting a receipt. */
  | 'ack-pending'
  /** E21 precondition: the ruling receipt landed on the board (设计行守卫列). */
  | 'ruling-receipt'

/** Side effects a transfer row carries beyond the state flip (D/C axes, §2.2). */
export interface CellEffects {
  /** D 机看态: freeze (❄️/🔒), release to active, or clear the session mark. */
  sessionMode?: 'frozen' | 'active' | 'cleared'
  /** B/C axis cause id — the derived-queue input (queue is a derived field). */
  cause?: string
  /** Clear the stored cause (ruling / wake paths). */
  clearCause?: true
  /** Counter bumps recorded with the transition (§2.6 attempts). */
  counters?: readonly ('redisp' | 'autofix')[]
  /** Pending-ack sub-note on `[x]` (E18/E19, §5 终态通知). */
  pendingAck?: boolean
  /** Human-readable freeze/wait reason mirrored into session.reason. */
  reason?: string
}

/** One explicit cell: transfer / forbid / na (design §2.3 三分). */
export interface TransferCell {
  kind: 'transfer'
  /** Target state; `'dynamic'` resolves from `payload.to` (E21 按裁定转移). */
  to: State | 'dynamic'
  /** Guards the host table-checks before allowing the transfer (§2.4). */
  guards: readonly GuardId[]
  /** Verbatim design-row guard/note anchor (audit + hover copy). */
  note: string
  effects?: CellEffects
}

export interface ForbidCell { kind: 'forbid'; why: string }
export interface NaCell { kind: 'na'; why: string }
export type Cell = TransferCell | ForbidCell | NaCell

/** The three explicit buckets of one state. */
export interface StateCells {
  transfer: Partial<Record<EventId, TransferCell>>
  forbid: Partial<Record<EventId, ForbidCell>>
  na: Partial<Record<EventId, NaCell>>
}

/**
 * The full 6 x 21 matrix. Design rows keep their §2.3 guard text in `note`;
 * cells the design table does not spell out are completed here with a
 * `补格` note (mechanical completion of the cartesian product, not a design
 * change — the design demands every cell carry one of the three verdicts).
 */
export const MATRIX: Readonly<Record<State, StateCells>> = {
  backlog: {
    transfer: {
      E1: {
        kind: 'transfer', to: 'active', guards: ['G1', 'G2', 'G3'],
        note: 'taskRef 409 无活绑定 ∧ 任务书含 worktree 预案 ∧ scope 在册（§2.3 设计行）',
        effects: { sessionMode: 'frozen', reason: '排队位：等待开工核验' },
      },
      E16: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: '补格：待办行 scope 取消同 E16 语义（人开的 scope 人收，§3.5）',
        effects: { sessionMode: 'cleared', cause: 'scope-cancelled' },
      },
    },
    forbid: {
      E8: { kind: 'forbid', why: '未开工无验收可过' },
      E9: { kind: 'forbid', why: '未开工无验收可修' },
    },
    na: {
      E2: { kind: 'na', why: '开工核验只发生在开工后（active）' },
      E3: { kind: 'na', why: '核验拦截回退只发生在开工后（active）' },
      E4: { kind: 'na', why: '未开工无步进' },
      E5: { kind: 'na', why: '未开工无缺前置发现' },
      E6: { kind: 'na', why: '未在等待无前置终态' },
      E7: { kind: 'na', why: '未在排队无配额空' },
      E10: { kind: 'na', why: '未开工无修轮' },
      E11: { kind: 'na', why: '未开工无判据争议' },
      E12: { kind: 'na', why: '未开工无施工面不可逆损害' },
      E13: { kind: 'na', why: '未派发无心跳对象' },
      E14: { kind: 'na', why: '未断链无重派对象' },
      E15: { kind: 'na', why: '未派发无中止对象；人取消走 E16' },
      E17: { kind: 'na', why: '收口 save 只对终态（[x]/[-]）' },
      E18: { kind: 'na', why: '终态通知只对根终态 [x]' },
      E19: { kind: 'na', why: '查收回执只对已通知终态' },
      E20: { kind: 'na', why: '等待开始由 E5/E7 落地' },
      E21: { kind: 'na', why: '黄灯人裁只对 [/] ⛔' },
    },
  },
  active: {
    transfer: {
      E2: {
        kind: 'transfer', to: 'active', guards: [],
        note: '开工核验过：开工继续（设计行隐含，D 轴记活跃）',
        effects: { sessionMode: 'active', clearCause: true },
      },
      E3: {
        kind: 'transfer', to: 'backlog', guards: [],
        note: '预案缺失 → 拦截即回退，不开工（§2.3 设计行，G1 失败路径）',
        effects: { sessionMode: 'cleared', cause: 'plan-missing' },
      },
      E4: {
        kind: 'transfer', to: 'active', guards: [],
        note: '无转移（机看态 D 轴记活跃）（§2.3 设计行）',
        effects: { sessionMode: 'active' },
      },
      E5: {
        kind: 'transfer', to: 'deferred', guards: [],
        note: '缺前置 → [/] ⏸ + D 轴 ❄️（§2.3 设计行；前置在册可查 → 可派，未裁定 → 转黄灯）',
        effects: { sessionMode: 'frozen', cause: 'prereq-unruled' },
      },
      E7: {
        kind: 'transfer', to: 'active', guards: [],
        note: '配额空 → [/] + D 轴 ❄️（排队位）（§2.3 设计行；队列档 = 黄）',
        effects: { sessionMode: 'frozen', cause: 'quota-wait' },
      },
      E8: {
        kind: 'transfer', to: 'done', guards: ['G4', 'G6'],
        note: '§6 验收闸（机检全绿）（§2.3 设计行）',
        effects: { sessionMode: 'cleared', clearCause: true },
      },
      E9: {
        kind: 'transfer', to: 'active', guards: [],
        note: '验收不过（可修）→ 自动修轮计数 +1（§2.3 设计行，修轮 < N）',
        effects: { counters: ['autofix'] },
      },
      E10: {
        kind: 'transfer', to: 'blocked', guards: [],
        note: '修轮 ≥ N → 停手人裁（三例外①）（§2.3 设计行，C 轴红）',
        effects: { cause: 'autofix-blowout' },
      },
      E11: {
        kind: 'transfer', to: 'blocked', guards: [],
        note: '三例外②：判据本体只归用户（T2）（§2.3 设计行，C 轴黄）',
        effects: { cause: 'criterion-dispute' },
      },
      E12: {
        kind: 'transfer', to: 'blocked', guards: [],
        note: '三例外③：不自动转、不自动修，留人（§2.3 设计行，C 轴红）',
        effects: { cause: 'irreversible' },
      },
      E13: {
        kind: 'transfer', to: 'blocked', guards: ['G5'],
        note: 'host 心跳超时判死（chain-liveness）（§2.3 设计行，重派计数 +1）',
        effects: { counters: ['redisp'], cause: 'chain-dead' },
      },
      E15: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: '人显式指令（主动中止 → §4 不入队）（§2.3 设计行；G6 = [-] 恒人触发 §6.2）',
        effects: { sessionMode: 'cleared', cause: 'human-abort' },
      },
      E16: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: '补格：active 行 scope 取消同 E16 语义（§3.5 人开的 scope 人收；G6 = [-] 恒人触发）',
        effects: { sessionMode: 'cleared', cause: 'scope-cancelled' },
      },
    },
    forbid: {
      E1: { kind: 'forbid', why: '已派发；taskRef 409 防双跑（G2）' },
      E14: { kind: 'forbid', why: '未断链无重派；重派只对 [/] ⛔' },
      E18: { kind: 'forbid', why: '终态通知只对根终态 [x]' },
      E19: { kind: 'forbid', why: '查收回执只对已通知终态' },
    },
    na: {
      E6: { kind: 'na', why: '未在等待无前置终态' },
      E17: { kind: 'na', why: '收口 save 只对终态；进行中落盘不走 E17' },
      E20: { kind: 'na', why: '等待开始由 E5/E7 落地' },
      E21: { kind: 'na', why: '黄灯人裁只对 [/] ⛔' },
    },
  },
  deferred: {
    transfer: {
      E6: {
        kind: 'transfer', to: 'active', guards: [],
        note: '前置行 [x]/[-] 机械读 → 解冻续跑（§2.3 设计行）',
        effects: { sessionMode: 'active', clearCause: true },
      },
      E12: {
        kind: 'transfer', to: 'blocked', guards: [],
        note: '补格：等待态发现不可逆损害同走三例外③（C 轴红）',
        effects: { cause: 'irreversible' },
      },
      E13: {
        kind: 'transfer', to: 'blocked', guards: ['G5'],
        note: '补格：等待中会话断链同走心跳判死（重派计数 +1）',
        effects: { counters: ['redisp'], cause: 'chain-dead' },
      },
      E15: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: '补格：人中止对等待态同语义（人显式 → [-]；G6 = [-] 恒人触发 §6.2）',
        effects: { sessionMode: 'cleared', cause: 'human-abort' },
      },
      E16: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: 'scope 撤销 = 人开的 scope 人收（§2.3 设计行，D 轴清行；G6 = [-] 恒人触发）',
        effects: { sessionMode: 'cleared', cause: 'scope-cancelled' },
      },
      E20: {
        kind: 'transfer', to: 'deferred', guards: [],
        note: '等待开始（不驻留）→ 立即冻结释放（§2.3 设计行；回执 wait-threshold 驻留期 0）',
        effects: { sessionMode: 'frozen' },
      },
    },
    forbid: {
      E1: { kind: 'forbid', why: '已派发；taskRef 409 防双跑（G2）' },
      E8: { kind: 'forbid', why: '等待中无验收对象' },
      E9: { kind: 'forbid', why: '等待中无验收可修' },
    },
    na: {
      E2: { kind: 'na', why: '开工核验只发生在开工后（active）' },
      E3: { kind: 'na', why: '核验拦截回退只发生在开工后（active）' },
      E4: { kind: 'na', why: '等待中无步进' },
      E5: { kind: 'na', why: '已在等待（缺前置已落地）' },
      E7: { kind: 'na', why: '配额等待由 active+E7 承载；链式等待 = 冻结态自然重入（§3.5）' },
      E10: { kind: 'na', why: '修轮只在施工步进中' },
      E11: { kind: 'na', why: '判据争议由 active 验收面触发' },
      E14: { kind: 'na', why: '重派只对 [/] ⛔' },
      E17: { kind: 'na', why: '收口 save 只对终态（[x]/[-]）' },
      E18: { kind: 'na', why: '终态通知只对根终态 [x]' },
      E19: { kind: 'na', why: '查收回执只对已通知终态' },
      E21: { kind: 'na', why: '黄灯人裁只对 [/] ⛔' },
    },
  },
  blocked: {
    transfer: {
      E11: {
        kind: 'transfer', to: 'blocked', guards: [],
        note: '补格：阻塞中发现判据争议同走三例外②（队列档取高，红不降黄）',
        effects: {},
      },
      E12: {
        kind: 'transfer', to: 'blocked', guards: [],
        note: '补格：阻塞中登记不可逆损害（C 轴红保持）',
        effects: { cause: 'irreversible' },
      },
      E13: {
        kind: 'transfer', to: 'blocked', guards: ['G5'],
        note: '补格：阻塞中断链重派计数 +1（G5 熔断拒 → 不转移）',
        effects: { counters: ['redisp'] },
      },
      E14: {
        kind: 'transfer', to: 'active', guards: ['G2', 'G5'],
        note: '409 防双跑 ∧ checkpoint 在场；重派计数 ≥ N → C 轴红熔断人裁（§2.3 设计行）',
        effects: { sessionMode: 'active', clearCause: true },
      },
      E15: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: '补格：人中止对阻塞态同语义（人显式 → [-]；G6 = [-] 恒人触发 §6.2）',
        effects: { sessionMode: 'cleared', cause: 'human-abort' },
      },
      E16: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: 'scope 撤销 = 人开的 scope 人收（§2.3 设计行，D 轴清行；G6 = [-] 恒人触发）',
        effects: { sessionMode: 'cleared', cause: 'scope-cancelled' },
      },
      E21: {
        kind: 'transfer', to: 'dynamic', guards: ['ruling-receipt'],
        note: '按裁定转移；裁定回执落板行随注（§2.3 设计行）',
        effects: { clearCause: true },
      },
    },
    forbid: {
      E1: { kind: 'forbid', why: '已派发；taskRef 409 防双跑（G2）' },
      E8: { kind: 'forbid', why: '停手期间无验收对象' },
      E9: { kind: 'forbid', why: '停手期间无验收可修' },
    },
    na: {
      E2: { kind: 'na', why: '开工核验只发生在开工后（active）' },
      E3: { kind: 'na', why: '核验拦截回退只发生在开工后（active）' },
      E4: { kind: 'na', why: '停手中无步进' },
      E5: { kind: 'na', why: '已在阻塞' },
      E6: { kind: 'na', why: '等前置归 deferred' },
      E7: { kind: 'na', why: '配额等待归 deferred/active' },
      E10: { kind: 'na', why: '熔断已发生；重复 E10 无转移' },
      E17: { kind: 'na', why: '阻塞中 save = §3.2 落盘动作，不走 E17 终态收口' },
      E18: { kind: 'na', why: '终态通知只对根终态 [x]' },
      E19: { kind: 'na', why: '查收回执只对已通知终态' },
      E20: { kind: 'na', why: '等待开始归 deferred' },
    },
  },
  done: {
    transfer: {
      E17: {
        kind: 'transfer', to: 'done', guards: ['G6'],
        note: '终态保持；save 全链走闸（§6.2 已裁：纳入 acceptance-gate 口径）',
      },
      E18: {
        kind: 'transfer', to: 'done', guards: [],
        note: '根 worker 才通知（§5）→ 待查收子注 + 队列档黄',
        effects: { pendingAck: true, cause: 'awaiting-ack' },
      },
      E19: {
        kind: 'transfer', to: 'done', guards: ['G6', 'ack-pending'],
        note: '人回执 → 清子注、入队清（§2.3 设计行）；随后走 §5 归档分层',
        effects: { pendingAck: false, clearCause: true },
      },
    },
    forbid: {
      E1: { kind: 'forbid', why: '终态已定；taskRef 409 防双跑（G2）' },
      E15: { kind: 'forbid', why: '终态不可回改；人撤销走板行人工通道' },
    },
    na: {
      E2: { kind: 'na', why: '非施工态' }, E3: { kind: 'na', why: '非施工态' },
      E4: { kind: 'na', why: '非施工态' }, E5: { kind: 'na', why: '非施工态' },
      E6: { kind: 'na', why: '非等待态' }, E7: { kind: 'na', why: '非排队态' },
      E8: { kind: 'na', why: '已验收' }, E9: { kind: 'na', why: '已验收' },
      E10: { kind: 'na', why: '无修轮' }, E11: { kind: 'na', why: '终态后争议走人裁面（acceptance-gate 残余）' },
      E12: { kind: 'na', why: '终态后发现走人裁面（acceptance-gate 灾难残余同源）' },
      E13: { kind: 'na', why: '无心跳对象' }, E14: { kind: 'na', why: '无重派对象' },
      E16: { kind: 'na', why: '已终态无需清行' },
      E20: { kind: 'na', why: '非等待态' }, E21: { kind: 'na', why: '黄灯人裁只对 [/] ⛔' },
    },
  },
  cancelled: {
    transfer: {
      E17: {
        kind: 'transfer', to: 'cancelled', guards: ['G6'],
        note: '终态保持；save 全链走闸（§6.2 已裁：纳入 acceptance-gate 口径）',
      },
    },
    forbid: {
      E1: { kind: 'forbid', why: '终态已定；taskRef 409 防双跑（G2）' },
      E15: { kind: 'forbid', why: '已取消' },
      E16: { kind: 'forbid', why: '已取消' },
    },
    na: {
      E2: { kind: 'na', why: '非施工态' }, E3: { kind: 'na', why: '非施工态' },
      E4: { kind: 'na', why: '非施工态' }, E5: { kind: 'na', why: '非施工态' },
      E6: { kind: 'na', why: '非等待态' }, E7: { kind: 'na', why: '非排队态' },
      E8: { kind: 'na', why: '已取消无验收' }, E9: { kind: 'na', why: '已取消无验收' },
      E10: { kind: 'na', why: '无修轮' }, E11: { kind: 'na', why: '非施工态' },
      E12: { kind: 'na', why: '终态后发现走人裁面' }, E13: { kind: 'na', why: '无心跳对象' },
      E14: { kind: 'na', why: '无重派对象' },
      E18: { kind: 'na', why: '通知只对 [x] 根终态' }, E19: { kind: 'na', why: '无通知无回执' },
      E20: { kind: 'na', why: '非等待态' }, E21: { kind: 'na', why: '黄灯人裁只对 [/] ⛔' },
    },
  },
}

/** Look up the explicit cell for (state, event); `undefined` = completeness hole. */
export function cellFor(state: State, event: EventId): Cell | undefined {
  const cells = MATRIX[state]
  return cells.transfer[event] ?? cells.forbid[event] ?? cells.na[event]
}
