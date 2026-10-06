import { bucket, getState, mutate, resetAll, resetRows } from '@/data/local-store'
import type {
  ConclusionInput,
  EntryRow,
  LockRecord,
  PendingKind,
  PendingOp,
  StoredState,
} from '@/data/types'

/**
 * 维修 — 验收 — 返修完整链路的唯一写入入口。
 *
 * 不变量（页面任何按钮都只能通过这里写数据）：
 * 1. 一条维修链（chainId = 派遣编号）下，同一时刻至多存在一条「待返修」事项；
 * 2. 验收记录只追加、不改写：退回后本轮封存为「需返修」，返修完成由新一轮「待验收」承接，
 *    旧轮从此带 history 标记永久保留；
 * 3. 链上当前结论只看最新轮次，历史结论（无论通过还是退回）不会被当成现行结论；
 * 4. 多步写入走中断事务（pending op）：每步独立落盘，从 nextStage 幂等续跑，创建类步骤查重，不重复造数据；
 * 5. 每条链有带 TTL 的处理锁：校验与抢锁在同一次原子写入内完成，多人同时退回只有一人成功。
 */

export const OUT_REPAIR_KEY = 'out_repair'
export const ACCEPT_KEY = 'repair_accept'
export const REWORK_KEY = 'repair_rework'

export const DISPATCH_STATUSES = ['待派遣', '已派遣', '维修中', '已返回', '返修中', '返修完成', '已闭环']
export const ACCEPT_STATUSES = ['待验收', '验收中', '已通过', '需返修']

// 单步派遣流转：允许的「当前状态 → 目标状态」。返修相关流转只允许走链路操作。
const DISPATCH_FLOW: Record<string, string> = {
  待派遣: '已派遣',
  已派遣: '维修中',
  维修中: '已返回',
}

export type StageContext = {
  state: StoredState
  op: PendingOp
  input: ConclusionInput
  now: string
}

export class ChainError extends Error {}
export class LockBusyError extends ChainError {}
export class StageFault extends Error {}

type Clock = () => number

type RunOptions = {
  ttl?: number
  nowMs?: number
  nowText?: string
  /** 故障注入：在指定阶段动作执行前中断，验证事务只能从断点继续。 */
  faultBeforeStage?: string
  /** 故障注入：持锁人与页面当前操作人不同（模拟别人正占用这条链）。 */
  lockHolder?: string
}

function findRow(rows: EntryRow[], id: number): EntryRow {
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    throw new ChainError(`编号 ${id} 的记录不存在`)
  }
  return row
}

function chainAcceptances(state: StoredState, chainId: string): EntryRow[] {
  return state.buckets[ACCEPT_KEY]
    .filter((row) => String(row.chainId) === chainId)
    .sort((a, b) => Number(a.round) - Number(b.round))
}

function latestAcceptance(state: StoredState, chainId: string): EntryRow | undefined {
  return chainAcceptances(state, chainId).at(-1)
}

function openRework(state: StoredState, chainId: string): EntryRow | undefined {
  return state.buckets[REWORK_KEY].find(
    (row) => String(row.chainId) === chainId && row.status === '待返修',
  )
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

function bumpPending(row: EntryRow, pending: boolean, abnormal: boolean): EntryRow {
  return { ...row, pending, abnormal }
}

/* ------------------------------------------------------------------ */
/* 锁                                                                  */
/* ------------------------------------------------------------------ */

export function activeLock(state: StoredState, chainId: string, nowMs: number): LockRecord | undefined {
  const lock = state.locks[chainId]
  return lock && lock.expiresAt > nowMs ? lock : undefined
}

function acquireLock(state: StoredState, chainId: string, holder: string, ttl: number, nowMs: number): LockRecord {
  const held = activeLock(state, chainId, nowMs)
  if (held) {
    throw new LockBusyError(
      `该维修链正由「${held.holder}」处理中（处理锁 ${held.token}），请稍后再试，避免重复退回`,
    )
  }
  const token = `lock-${nowMs}-${Math.random().toString(36).slice(2, 8)}`
  const lock: LockRecord = { token, holder, expiresAt: nowMs + ttl }
  state.locks[chainId] = lock
  return lock
}

function releaseLock(state: StoredState, chainId: string, token: string): void {
  if (state.locks[chainId]?.token === token) {
    delete state.locks[chainId]
  }
}

/* ------------------------------------------------------------------ */
/* 链路选择器（读侧，供两个工作台页面使用）                                */
/* ------------------------------------------------------------------ */

export type WorkbenchRow = {
  dispatch: EntryRow
  latest?: EntryRow
  openRework?: EntryRow
  totalRounds: number
  currentStatus: string
}

/** 外出维修工作台：每条派遣拼上当前验收轮次与唯一待办返修事项。 */
export function workbenchRows(): WorkbenchRow[] {
  const state = getState()
  return [...state.buckets[OUT_REPAIR_KEY]]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((dispatch) => {
      const chainId = String(dispatch.chainId ?? dispatch.派遣编号)
      const acceptances = chainAcceptances(state, chainId)
      const latest = acceptances.at(-1)
      return {
        dispatch,
        latest,
        openRework: openRework(state, chainId),
        totalRounds: acceptances.length,
        currentStatus: String(dispatch.status),
      }
    })
}

export type AcceptanceRow = EntryRow & {
  /** 已有更新轮次：这一轮是历史。 */
  history: boolean
  /** 已封存：历史轮次，或本轮已出结论（已通过/需返修），不能再提交结论。 */
  sealed: boolean
  /** 链上现行可处理的一轮（最新且仍在待验收/验收中）。 */
  actionable: boolean
  roundLabel: string
}

/** 验收列表：追加出来的历史轮次标为 history，已出结论的轮次一律封存。 */
export function acceptanceRows(): AcceptanceRow[] {
  const state = getState()
  const accepts = state.buckets[ACCEPT_KEY]
  const chains = new Set(accepts.map((row) => String(row.chainId)))
  const latestByChain = new Map<string, EntryRow>()
  for (const chainId of chains) {
    const latest = latestAcceptance(state, chainId)
    if (latest) {
      latestByChain.set(chainId, latest)
    }
  }
  return [...accepts]
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((row) => {
      const chainId = String(row.chainId)
      const latest = latestByChain.get(chainId)
      const isLatest = latest?.id === row.id
      const history = !isLatest
      const sealed = history || row.status === '已通过' || row.status === '需返修'
      const actionable = isLatest && (row.status === '待验收' || row.status === '验收中')
      const suffix = history ? '（历史）' : sealed ? '（已封存）' : '（当前）'
      return {
        ...row,
        history,
        sealed,
        actionable,
        roundLabel: `第 ${Number(row.round ?? 1)} 轮${suffix}`,
      }
    })
}

/** 一条链的完整时间线：派遣 → 历轮验收 → 返修事项，按发生顺序排好。 */
export function chainTimeline(chainId: string): { dispatch?: EntryRow; accepts: EntryRow[]; reworks: EntryRow[] } {
  const state = getState()
  return {
    dispatch: state.buckets[OUT_REPAIR_KEY].find((row) => String(row.chainId ?? row.派遣编号) === chainId),
    accepts: chainAcceptances(state, chainId),
    reworks: state.buckets[REWORK_KEY].filter((row) => String(row.chainId) === chainId),
  }
}

export function pendingOps(): PendingOp[] {
  return [...getState().pending]
}

/** 返修事项表：每链至多一条待返修；已完成的也保留展示作为历史。 */
export function reworkRows(): EntryRow[] {
  return [...getState().buckets[REWORK_KEY]].sort((a, b) => Number(b.id) - Number(a.id))
}

/** 锁已过期（或丢失）的悬挂事务：页面提示后可由处理人接管续跑。 */
export function expiredOps(nowMs: number = Date.now()): PendingOp[] {
  const state = getState()
  return state.pending.filter((op) => {
    const lock = state.locks[op.chainId]
    return !lock || lock.token !== op.lockToken || lock.expiresAt <= nowMs
  })
}

export type ChainStats = {
  waitingDispatch: number
  repairing: number
  returnedWaitingAccept: number
  reworking: number
  reworkDoneWaitingAccept: number
  closed: number
  openRework: number
}

export function workbenchStats(): ChainStats {
  const rows = workbenchRows()
  return {
    waitingDispatch: rows.filter((row) => ['待派遣', '已派遣'].includes(row.currentStatus)).length,
    repairing: rows.filter((row) => row.currentStatus === '维修中').length,
    returnedWaitingAccept: rows.filter(
      (row) => row.currentStatus === '已返回' || (row.currentStatus === '返修完成' && !row.latest),
    ).length,
    reworking: rows.filter((row) => row.currentStatus === '返修中').length,
    reworkDoneWaitingAccept: rows.filter(
      (row) => row.currentStatus === '返修完成' && row.latest?.status === '待验收',
    ).length,
    closed: rows.filter((row) => row.currentStatus === '已闭环').length,
    openRework: rows.filter((row) => Boolean(row.openRework)).length,
  }
}

export type AcceptStats = {
  waitingAccept: number
  accepting: number
  closedPassed: number
  reworkingChains: number
}

/** 看板统计：已通过只统计「作为当前轮次」的记录，历史通过的旧结论不重复计数。 */
export function acceptStats(): AcceptStats {
  const rows = acceptanceRows()
  return {
    waitingAccept: rows.filter((row) => !row.history && row.status === '待验收').length,
    accepting: rows.filter((row) => !row.history && row.status === '验收中').length,
    closedPassed: rows.filter((row) => !row.history && row.status === '已通过').length,
    reworkingChains: new Set(
      rows.filter((row) => !row.history && row.status === '需返修').map((row) => String(row.chainId)),
    ).size,
  }
}

/* ------------------------------------------------------------------ */
/* 派遣的单步流转（非返修段）                                            */
/* ------------------------------------------------------------------ */

function moveDispatch(dispatchId: number, action: '下达派遣' | '出发维修' | '返回确认'): EntryRow {
  return mutate((state) => {
    const rows = state.buckets[OUT_REPAIR_KEY]
    const dispatch = findRow(rows, Number(dispatchId))
    const chainId = String(dispatch.chainId ?? dispatch.派遣编号)
    if (activeLock(state, chainId, Date.now())) {
      throw new LockBusyError('该维修链有正在进行的验收/返修处理，请先完成或继续该处理')
    }
    const target = DISPATCH_FLOW[String(dispatch.status)]
    if (!target || metaActionTarget(action) !== target) {
      throw new ChainError(`「${dispatch.status}」状态不能执行「${action}」`)
    }
    const index = rows.indexOf(dispatch)
    const updated: EntryRow = {
      ...dispatch,
      status: target,
      pending: target !== '已闭环',
      abnormal: false,
      维修状态: target === '已返回' ? '已返回待验收' : target,
      返回时间: target === '已返回' && !dispatch.返回时间 ? new Date().toISOString().slice(0, 16).replace('T', ' ') : dispatch.返回时间,
    }
    rows[index] = updated
    return updated
  })
}

function metaActionTarget(action: string): string | undefined {
  const map: Record<string, string> = { 下达派遣: '已派遣', 出发维修: '维修中', 返回确认: '已返回' }
  return map[action]
}

export function dispatchAction(dispatchId: number, action: '下达派遣' | '出发维修' | '返回确认'): EntryRow {
  return moveDispatch(dispatchId, action)
}

/* ------------------------------------------------------------------ */
/* 验收发起                                                             */
/* ------------------------------------------------------------------ */

/** 首次验收：已返回且链上还没有任何验收记录时，生成第 1 轮「待验收」。 */
export function startAcceptance(dispatchId: number, inspector: string): EntryRow {
  return mutate((state) => {
    const dispatch = findRow(state.buckets[OUT_REPAIR_KEY], Number(dispatchId))
    const chainId = String(dispatch.chainId ?? dispatch.派遣编号)
    if (activeLock(state, chainId, Date.now())) {
      throw new LockBusyError('该维修链有正在进行的验收/返修处理')
    }
    if (dispatch.status !== '已返回') {
      throw new ChainError('只有「已返回」的维修才能发起首轮验收')
    }
    const existing = chainAcceptances(state, chainId)
    if (existing.length > 0) {
      throw new ChainError('该维修已存在验收记录，请直接在验收列表处理当前轮次')
    }
    const nowText = new Date().toISOString().slice(0, 10)
    const rows = state.buckets[ACCEPT_KEY]
    const row: EntryRow = {
      id: nextId(rows),
      status: '待验收',
      pending: true,
      abnormal: false,
      chainId,
      round: 1,
      version: 0,
      验收编号: `${chainId}-A1`,
      关联维修: chainId,
      验收人员: inspector,
      验收日期: nowText,
      维修质量: '',
      验收结论: '',
      复修要求: '',
      验收状态: '待验收',
    }
    rows.push(row)
    return row
  })
}

/** 待验收 → 验收中（单步写入，重复点击幂等返回当前行）。 */
export function beginAcceptance(acceptanceId: number): EntryRow {
  return mutate((state) => {
    const rows = state.buckets[ACCEPT_KEY]
    const row = findRow(rows, Number(acceptanceId))
    const latest = latestAcceptance(state, String(row.chainId))
    if (latest?.id !== row.id) {
      throw new ChainError('这是历史验收轮次，不能再操作；请处理最新一轮验收')
    }
    if (row.status === '验收中') {
      return row
    }
    if (row.status !== '待验收') {
      throw new ChainError(`「${row.status}」的验收记录不能开始验收`)
    }
    const index = rows.indexOf(row)
    rows[index] = { ...row, status: '验收中', version: Number(row.version ?? 0) + 1, 验收状态: '验收中' }
    return rows[index]
  })
}

/* ------------------------------------------------------------------ */
/* 多步事务：退回返修 / 确认通过 / 完成返修                              */
/* ------------------------------------------------------------------ */

const DEFAULT_TTL = 10 * 60 * 1000

function validateConclusion(kind: PendingKind, row: EntryRow, input: ConclusionInput): void {
  if (row.status !== '验收中') {
    throw new ChainError('只有「验收中」的当前轮次可以提交结论')
  }
  if (kind === 'return' && input.repairRequest.trim() === '') {
    throw new ChainError('退回返修必须填写复修要求，作为唯一返修事项的内容')
  }
  if (kind === 'pass' && (input.quality.trim() === '' || input.summary.trim() === '')) {
    throw new ChainError('确认通过需要填写维修质量与验收结论')
  }
}

function makeOpId(kind: PendingKind, acceptanceId: number, nowMs: number): string {
  return `${kind}-${acceptanceId}-${nowMs}`
}

/* ---- 阶段定义：每个阶段在独立 mutate 里提交，天然可断点续跑 ---- */

function stageReturnCreateRework(ctx: StageContext): void {
  const { state, op, now } = ctx
  const chainId = op.chainId
  // 幂等：链上已有待返修事项（上次中断在本阶段提交之后）就不再造第二条。
  if (openRework(state, chainId)) {
    return
  }
  const rows = state.buckets[REWORK_KEY]
  const dispatch = state.buckets[OUT_REPAIR_KEY].find((row) => String(row.chainId ?? row.派遣编号) === chainId)
  const acceptance = state.buckets[ACCEPT_KEY].find((row) => Number(row.id) === op.acceptanceId)
  const id = nextId(rows)
  const rework: EntryRow = {
    id,
    status: '待返修',
    pending: true,
    abnormal: true,
    chainId,
    返修编号: `REWK-${String(id).padStart(4, '0')}`,
    关联维修: chainId,
    来源验收: String(acceptance?.验收编号 ?? op.acceptanceId),
    返修要求: op.detail,
    维修人员: String(dispatch?.维修人员 ?? ''),
    登记时间: now,
    完成时间: '',
  }
  rows.push(rework)
  op.reworkId = id
}

function stageReturnFreezeAcceptance(ctx: StageContext): void {
  const { state, op } = ctx
  const rows = state.buckets[ACCEPT_KEY]
  const row = findRow(rows, op.acceptanceId)
  if (row.status === '需返修') {
    return // 已封存，幂等跳过
  }
  const index = rows.indexOf(row)
  rows[index] = bumpPending(
    {
      ...row,
      status: '需返修',
      version: Number(row.version ?? 0) + 1,
      concludedAt: ctx.now,
      维修质量: ctx.input.quality || '不合格',
      验收结论: ctx.input.summary,
      复修要求: ctx.input.repairRequest,
      验收状态: `第 ${Number(row.round ?? 1)} 轮已退回（历史）`,
    },
    true,
    true,
  )
}

function stageReturnMoveDispatch(ctx: StageContext): void {
  const { state, op, now } = ctx
  const rows = state.buckets[OUT_REPAIR_KEY]
  const dispatch = rows.find((row) => String(row.chainId ?? row.派遣编号) === op.chainId)
  if (!dispatch) {
    return
  }
  if (dispatch.status === '返修中') {
    return
  }
  const index = rows.indexOf(dispatch)
  rows[index] = bumpPending(
    { ...dispatch, status: '返修中', abnormal: true, 维修状态: '验收退回，返修中', 返回时间: dispatch.返回时间 || now },
    true,
    true,
  )
}

function stagePassCloseAcceptance(ctx: StageContext): void {
  const { state, op, now } = ctx
  const rows = state.buckets[ACCEPT_KEY]
  const row = findRow(rows, op.acceptanceId)
  if (row.status === '已通过') {
    return
  }
  const index = rows.indexOf(row)
  rows[index] = bumpPending(
    {
      ...row,
      status: '已通过',
      version: Number(row.version ?? 0) + 1,
      concludedAt: now,
      维修质量: ctx.input.quality,
      验收结论: ctx.input.summary,
      验收状态: `第 ${Number(row.round ?? 1)} 轮${Number(row.round ?? 1) > 1 ? '复验通过' : '验收通过'}（历史）`,
    },
    false,
    false,
  )
}

function stagePassCloseDispatch(ctx: StageContext): void {
  const { state, op } = ctx
  const rows = state.buckets[OUT_REPAIR_KEY]
  const dispatch = rows.find((row) => String(row.chainId ?? row.派遣编号) === op.chainId)
  if (!dispatch || dispatch.status === '已闭环') {
    return
  }
  const index = rows.indexOf(dispatch)
  rows[index] = bumpPending({ ...dispatch, status: '已闭环', 维修状态: '验收通过，已闭环' }, false, false)
}

function stageCompleteRework(ctx: StageContext): void {
  const { state, op, now } = ctx
  if (op.reworkId === undefined) {
    throw new ChainError('中断事务缺少返修事项编号，无法继续完成返修')
  }
  const rows = state.buckets[REWORK_KEY]
  const rework = findRow(rows, op.reworkId)
  if (rework.status !== '返修完成') {
    const index = rows.indexOf(rework)
    rows[index] = bumpPending(
      { ...rework, status: '返修完成', abnormal: false, 完成时间: now },
      false,
      false,
    )
  }
}

function stageCompleteMoveDispatch(ctx: StageContext): void {
  const { state, op } = ctx
  const rows = state.buckets[OUT_REPAIR_KEY]
  const dispatch = rows.find((row) => String(row.chainId ?? row.派遣编号) === op.chainId)
  if (!dispatch || dispatch.status === '返修完成') {
    return
  }
  const index = rows.indexOf(dispatch)
  rows[index] = bumpPending(
    { ...dispatch, status: '返修完成', abnormal: false, 维修状态: '返修完成，待新一轮验收' },
    true,
    false,
  )
}

function stageCompleteOpenNextRound(ctx: StageContext): void {
  const { state, op, now } = ctx
  const chainId = op.chainId
  const accepts = chainAcceptances(state, chainId)
  const latest = accepts.at(-1)
  // 幂等：最新轮次已经是未结论的待验收/验收中，说明上次中断时已建好，直接复用，绝不多出一条。
  if (latest && (latest.status === '待验收' || latest.status === '验收中')) {
    op.newAcceptanceId = Number(latest.id)
    return
  }
  const round = accepts.reduce((max, row) => Math.max(max, Number(row.round ?? 1)), 0) + 1
  const rows = state.buckets[ACCEPT_KEY]
  const previous = accepts.at(-1)
  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status: '待验收',
    pending: true,
    abnormal: false,
    chainId,
    round,
    version: 0,
    验收编号: `${chainId}-A${round}`,
    关联维修: chainId,
    验收人员: String(previous?.验收人员 ?? ''),
    验收日期: now.slice(0, 10),
    维修质量: '',
    验收结论: '',
    复修要求: '',
    验收状态: `返修后第 ${round} 轮待验收`,
  }
  rows.push(row)
  op.newAcceptanceId = id
}

type StageDef = { name: string; run: (ctx: StageContext) => void }

const STAGES: Record<PendingKind, StageDef[]> = {
  return: [
    { name: 'create_rework', run: stageReturnCreateRework },
    { name: 'freeze_acceptance', run: stageReturnFreezeAcceptance },
    { name: 'move_dispatch', run: stageReturnMoveDispatch },
  ],
  pass: [
    { name: 'close_acceptance', run: stagePassCloseAcceptance },
    { name: 'close_dispatch', run: stagePassCloseDispatch },
  ],
  complete_rework: [
    { name: 'complete_rework', run: stageCompleteRework },
    { name: 'move_dispatch', run: stageCompleteMoveDispatch },
    { name: 'open_next_round', run: stageCompleteOpenNextRound },
  ],
}

const KIND_TEXT: Record<PendingKind, string> = {
  return: '退回返修',
  pass: '确认通过',
  complete_rework: '完成返修',
}

/* ------------------------------------------------------------------ */
/* 事务执行与续跑                                                       */
/* ------------------------------------------------------------------ */

function stagesOf(kind: PendingKind): StageDef[] {
  return STAGES[kind]
}

function persistOp(state: StoredState, op: PendingOp): void {
  const index = state.pending.findIndex((item) => item.id === op.id)
  if (index >= 0) {
    state.pending[index] = op
  } else {
    state.pending.push(op)
  }
}

/**
 * 从断点继续执行。每个阶段一个独立 mutate（独立落盘点）；
 * 先校验锁归属，再按 faultBeforeStage 决定是否在该阶段动作前注入中断。
 */
function runStages(op: PendingOp, input: ConclusionInput, options: RunOptions): void {
  const stages = stagesOf(op.kind)
  const clock: Clock = options.nowMs ? () => options.nowMs as number : () => Date.now()
  const startIndex = Math.max(0, stages.findIndex((stage) => stage.name === op.nextStage))
  let remaining = stages.slice(startIndex)
  while (remaining.length > 0) {
    const stage = remaining[0]
    const nowText = options.nowText ?? new Date(clock()).toISOString().slice(0, 16).replace('T', ' ')
    if (options.faultBeforeStage === stage.name) {
      throw new StageFault(`已在「${KIND_TEXT[op.kind]} · ${stage.name}」前模拟中断，数据停在断点，可随时继续`)
    }
    mutate((state) => {
      // 续跑身份校验：锁还在且 token 对得上，才允许继续。
      const lock = state.locks[op.chainId]
      if (!lock || lock.token !== op.lockToken) {
        throw new LockBusyError('处理锁已失效或被他人接管，不能继续这条中断事务')
      }
      const live = state.pending.find((item) => item.id === op.id)
      if (!live) {
        throw new ChainError('中断事务已不存在')
      }
      const ctx: StageContext = { state, op: live, input, now: nowText }
      stage.run(ctx)
      const next = stages[stages.indexOf(stage) + 1]
      live.nextStage = next ? next.name : 'done'
      persistOp(state, live)
    })
    remaining = remaining.slice(1)
  }
  // 全部阶段完成：在同一把锁的保护下落一条「完成」，随后删事务、释放锁。
  mutate((state) => {
    const finalIndex = state.pending.findIndex((item) => item.id === op.id)
    if (finalIndex >= 0) {
      state.pending.splice(finalIndex, 1)
    }
    releaseLock(state, op.chainId, op.lockToken)
  })
}

function submitConclusion(
  kind: PendingKind,
  acceptanceId: number,
  input: ConclusionInput,
  holder: string,
  options: RunOptions = {},
): PendingOp {
  const nowMs = options.nowMs ?? Date.now()
  const ttl = options.ttl ?? DEFAULT_TTL
  const lockHolder = options.lockHolder ?? holder
  // 第一步：校验 + 抢占链锁 + 落事务（原子）。
  const op = mutate((state) => {
    const rows = state.buckets[ACCEPT_KEY]
    const row = findRow(rows, Number(acceptanceId))
    const chainId = String(row.chainId)
    const latest = latestAcceptance(state, chainId)
    if (latest?.id !== row.id) {
      throw new ChainError('这是历史验收轮次，不能再提交结论；请处理最新一轮验收')
    }
    validateConclusion(kind, row, input)
    const stuck = state.pending.find((item) => item.chainId === chainId)
    if (stuck) {
      const lock = state.locks[chainId]
      if (lock && lock.token === stuck.lockToken && lock.expiresAt > nowMs) {
        throw new LockBusyError(`该链有未完成的「${KIND_TEXT[stuck.kind]}」处理，请先从断点继续，不能重复提交`)
      }
    }
    const lock = acquireLock(state, chainId, lockHolder, ttl, nowMs)
    const stages = stagesOf(kind)
    const newOp: PendingOp = {
      id: makeOpId(kind, Number(acceptanceId), nowMs),
      kind,
      chainId,
      acceptanceId: Number(acceptanceId),
      nextStage: stages[0].name,
      holder: lockHolder,
      lockToken: lock.token,
      startedAt: nowMs,
      detail: kind === 'return' ? input.repairRequest.trim() : '',
    }
    state.pending.push(newOp)
    return newOp
  })
  // 第二步：逐阶段推进（每阶段独立落盘，中断后可续跑）。
  runStages(op, input, options)
  return op
}

export function submitReturn(
  acceptanceId: number,
  input: ConclusionInput,
  holder = '值班管理员',
  options: RunOptions = {},
): PendingOp {
  return submitConclusion('return', acceptanceId, input, holder, options)
}

export function submitPass(
  acceptanceId: number,
  input: ConclusionInput,
  holder = '值班管理员',
  options: RunOptions = {},
): PendingOp {
  return submitConclusion('pass', acceptanceId, input, holder, options)
}

/** 完成唯一的待返修事项：由外出维修工作台触发，完成后自动开新一轮验收。 */
export function completeRework(dispatchId: number, holder = '值班管理员', options: RunOptions = {}): PendingOp {
  const nowMs = options.nowMs ?? Date.now()
  const ttl = options.ttl ?? DEFAULT_TTL
  const lockHolder = options.lockHolder ?? holder
  const op = mutate((state) => {
    const dispatch = findRow(state.buckets[OUT_REPAIR_KEY], Number(dispatchId))
    const chainId = String(dispatch.chainId ?? dispatch.派遣编号)
    if (dispatch.status !== '返修中') {
      throw new ChainError('只有「返修中」的维修才能完成返修')
    }
    const rework = openRework(state, chainId)
    if (!rework) {
      throw new ChainError('没有找到该链的待返修事项，可能已完成')
    }
    const stuck = state.pending.find((item) => item.chainId === chainId)
    if (stuck) {
      const lock = state.locks[chainId]
      if (lock && lock.token === stuck.lockToken && lock.expiresAt > nowMs) {
        throw new LockBusyError('该链有未完成的处理，请先从断点继续')
      }
    }
    const lock = acquireLock(state, chainId, lockHolder, ttl, nowMs)
    const stages = stagesOf('complete_rework')
    const newOp: PendingOp = {
      id: makeOpId('complete_rework', Number(rework.id), nowMs),
      kind: 'complete_rework',
      chainId,
      acceptanceId: 0,
      reworkId: Number(rework.id),
      nextStage: stages[0].name,
      holder: lockHolder,
      lockToken: lock.token,
      startedAt: nowMs,
      detail: String(rework.返修要求 ?? ''),
    }
    state.pending.push(newOp)
    return newOp
  })
  runStages(op, { quality: '', summary: '', repairRequest: op.detail }, options)
  return op
}

/** 继续一条中断事务（按钮或进页面时自动调用）。 */
export function resumeOp(opId: string, options: RunOptions = {}): void {
  const op = mutate((state) => {
    const found = state.pending.find((item) => item.id === opId)
    if (!found) {
      throw new ChainError('中断事务已完成或不存在')
    }
    return JSON.parse(JSON.stringify(found)) as PendingOp
  })
  runStages(op, { quality: '', summary: '', repairRequest: op.detail }, options)
}

export function resumeAll(options: RunOptions = {}): PendingOp[] {
  const done: PendingOp[] = []
  // 每续跑一条前重新取列表，因为续跑会改动 pending。
  for (let guard = 0; guard < 50; guard += 1) {
    const op = getState().pending.find((item) => item.nextStage !== 'done')
    if (!op) {
      break
    }
    resumeOp(op.id, options)
    done.push(op)
  }
  return done
}

/** 锁过期后的接管：清掉失效锁与悬挂事务（仅当锁确实过期），供页面提示后手动调用。 */
export function reclaimChain(chainId: string, nowMs: number = Date.now()): void {
  mutate((state) => {
    const lock = state.locks[chainId]
    if (lock && lock.expiresAt > nowMs) {
      throw new LockBusyError(`该链仍由「${lock.holder}」处理中，不能接管`)
    }
    delete state.locks[chainId]
    state.pending = state.pending.filter((op) => op.chainId !== chainId)
  })
}

/* ------------------------------------------------------------------ */
/* 重置（测试 / 演示）                                                  */
/* ------------------------------------------------------------------ */

export function resetChain(): void {
  resetRows(OUT_REPAIR_KEY)
  resetRows(ACCEPT_KEY)
  resetRows(REWORK_KEY)
  mutate((state) => {
    state.pending = []
    state.locks = {}
  })
}

export { resetAll }
export { bucket as chainBucket }
