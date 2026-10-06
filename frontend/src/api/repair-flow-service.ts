/**
 * 验收—维修—返修链路服务：所有跨表写入都集中在这里，页面只做渲染。
 *
 * 三个不变量：
 * 1. 一次退回只产生一条返修事项（按来源验收去重），返修完成后由新一轮验收承接；
 * 2. 验收一旦出结论（已通过/已退回）即封档，任何动作都不能再改旧结论；
 * 3. 多步写入走操作账本，中断后从断点续做；每次提交带版本号 CAS，并发退回只有一人成功。
 */
import {
  loadFlowState,
  resetFlowState,
  saveFlowState,
  REPAIR_CODE,
  type AcceptanceRecord,
  type OpLedgerEntry,
  type RepairFlowState,
  type RepairOrder,
  type ReworkItem,
} from '@/data/repair-flow'

export class FlowError extends Error {}
export class ConcurrencyError extends Error {}

export interface ActionOutcome {
  ok: boolean
  message: string
}

/** 故障注入点（仅开发联调用）：命中后在对应提交完成之后抛出，模拟提交中断。 */
export type FaultPoint = 'return_accept.after_seal' | 'finish_rework.after_rework'
let armedFault: FaultPoint | null = null

export function armFault(point: FaultPoint): void {
  armedFault = point
}
export function clearFault(): void {
  armedFault = null
}
function tripIf(point: FaultPoint): void {
  if (armedFault === point) {
    armedFault = null
    throw new Error(`模拟中断：${point} 已落库，后续步骤未执行`)
  }
}

/**
 * 原子提交：从存储拿最新状态 → 校验版本 → 变更 → 版本号 +1 落库。
 * expectedVersion 为空时不做 CAS（仅用于账本续做，续做的每一步都有存在性守卫兜底）。
 */
function commit(mutate: (state: RepairFlowState) => void, expectedVersion?: number): RepairFlowState {
  const latest = loadFlowState()
  if (expectedVersion !== undefined && latest.version !== expectedVersion) {
    throw new ConcurrencyError('该验收已被其他人员处理，状态已更新，请刷新后查看最新结果')
  }
  const state: RepairFlowState = JSON.parse(JSON.stringify(latest)) as RepairFlowState
  mutate(state)
  state.version += 1
  saveFlowState(state)
  return state
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowIso(): string {
  return new Date().toISOString()
}

function nextId(state: RepairFlowState, kind: 'repair' | 'accept' | 'rework'): number {
  state.seq[kind] += 1
  return state.seq[kind]
}

function openReworksOf(state: RepairFlowState, dispatchId: number): ReworkItem[] {
  return state.reworks.filter((item) => item.dispatchId === dispatchId && item.status !== '返修完成')
}

function activeAcceptanceOf(state: RepairFlowState, dispatchId: number): AcceptanceRecord | undefined {
  return state.acceptances.find(
    (item) => item.dispatchId === dispatchId && (item.status === '待验收' || item.status === '验收中'),
  )
}

function interruptedLedger(
  state: RepairFlowState,
  type: OpLedgerEntry['type'],
  refId: number,
): OpLedgerEntry | undefined {
  return state.ledger.find((item) => item.type === type && item.refId === refId && item.status === '进行中')
}

// ---------------------------------------------------------------------------
// 外出维修侧
// ---------------------------------------------------------------------------

export function dispatchRepair(repairId: number): ActionOutcome {
  try {
    commit((state) => {
      const repair = state.repairs.find((item) => item.id === repairId)
      if (!repair) {
        throw new FlowError(`没有找到编号为 ${repairId} 的外出维修单`)
      }
      if (repair.status !== '待派遣') {
        throw new FlowError(`维修单当前为「${repair.status}」，不能下达派遣`)
      }
      repair.status = '已派遣'
      repair.出发时间 = today()
      repair.updatedAt = nowIso()
    })
    return { ok: true, message: '派遣已下达，维修人员可出发' }
  } catch (error) {
    return toOutcome(error)
  }
}

export function startRepair(repairId: number): ActionOutcome {
  try {
    commit((state) => {
      const repair = state.repairs.find((item) => item.id === repairId)
      if (!repair) {
        throw new FlowError(`没有找到编号为 ${repairId} 的外出维修单`)
      }
      if (repair.status !== '已派遣') {
        throw new FlowError(`维修单当前为「${repair.status}」，只有已派遣的维修单能出发维修`)
      }
      repair.status = '维修中'
      repair.updatedAt = nowIso()
    })
    return { ok: true, message: '维修单已进入维修中' }
  } catch (error) {
    return toOutcome(error)
  }
}

/** 返回确认：维修返回 + 首轮验收在同一事务里生成，保证返回必有验收承接，且重复提交不会多生成。 */
export function returnRepair(repairId: number): ActionOutcome {
  try {
    commit((state) => {
      const repair = state.repairs.find((item) => item.id === repairId)
      if (!repair) {
        throw new FlowError(`没有找到编号为 ${repairId} 的外出维修单`)
      }
      if (repair.status !== '维修中') {
        throw new FlowError(`维修单当前为「${repair.status}」，只有维修中的维修单能返回确认`)
      }
      repair.status = '已返回'
      repair.返回时间 = today()
      repair.updatedAt = nowIso()
      // 存在性守卫：已经生成过验收（含中断重试点）绝不重复生成。
      const existed = state.acceptances.some((item) => item.dispatchId === repairId)
      if (!existed) {
        const id = nextId(state, 'accept')
        state.acceptances.push({
          id,
          验收编号: REPAIR_CODE.accept(id),
          dispatchId: repairId,
          关联维修: repair.派遣编号,
          round: 1,
          验收人员: '待分配',
          验收日期: '',
          维修质量: '',
          验收结论: '',
          复修要求: '',
          status: '待验收',
          prevAcceptId: null,
          sourceReworkId: null,
          sealed: false,
          createdAt: nowIso(),
          concludedAt: null,
        })
      }
    })
    return { ok: true, message: '返回已确认，已生成待验收记录' }
  } catch (error) {
    return toOutcome(error)
  }
}

// ---------------------------------------------------------------------------
// 验收侧
// ---------------------------------------------------------------------------

export function startAcceptance(acceptId: number): ActionOutcome {
  try {
    commit((state) => {
      const acceptance = state.acceptances.find((item) => item.id === acceptId)
      if (!acceptance) {
        throw new FlowError(`没有找到编号为 ${acceptId} 的验收记录`)
      }
      if (acceptance.sealed) {
        throw new FlowError('该验收已出结论并归档，不能再发起')
      }
      if (acceptance.status !== '待验收') {
        throw new FlowError(`验收当前为「${acceptance.status}」，不能重复发起`)
      }
      acceptance.status = '验收中'
    })
    return { ok: true, message: '验收已发起，可录入通过或退回结论' }
  } catch (error) {
    return toOutcome(error)
  }
}

export function passAcceptance(acceptId: number, expectedVersion: number): ActionOutcome {
  try {
    commit((state) => {
      const acceptance = state.acceptances.find((item) => item.id === acceptId)
      if (!acceptance) {
        throw new FlowError(`没有找到编号为 ${acceptId} 的验收记录`)
      }
      if (acceptance.sealed) {
        throw new FlowError(`该验收结论为「${acceptance.验收结论 || acceptance.status}」并已归档，不能重复确认`)
      }
      if (acceptance.status !== '验收中') {
        throw new FlowError(`验收当前为「${acceptance.status}」，只有验收中的记录能确认通过`)
      }
      if (openReworksOf(state, acceptance.dispatchId).length > 0) {
        throw new FlowError('该维修还有未闭环的返修事项，需待返修完成后由新验收记录承接')
      }
      acceptance.status = '已通过'
      acceptance.验收结论 = '合格'
      acceptance.维修质量 = '合格'
      acceptance.验收日期 = today()
      acceptance.sealed = true
      acceptance.concludedAt = nowIso()
    }, expectedVersion)
    return { ok: true, message: '验收已通过并归档，该维修链路闭环' }
  } catch (error) {
    return toOutcome(error)
  }
}

/** 退回返修：第 1 步封档验收并记账，第 2 步生成唯一返修事项；任一步中断都可续做。 */
export function returnAcceptance(
  acceptId: number,
  reworkRequest: string,
  expectedVersion: number,
  opId: string = `ret-${acceptId}-${Date.now()}`,
): ActionOutcome {
  const requirement = reworkRequest.trim()
  if (!requirement) {
    return { ok: false, message: '退回返修必须填写复修要求' }
  }
  try {
    const state = loadFlowState()
    const acceptance = state.acceptances.find((item) => item.id === acceptId)
    if (!acceptance) {
      return { ok: false, message: `没有找到编号为 ${acceptId} 的验收记录` }
    }
    // 本笔提交中断在半路（验收已封档、返修未建、账本进行中）：优先从中断环节续做。
    // 账本的「进行中」状态只属于这一笔提交，并发来的新提交不会有账本，会走到后面的封档拒绝。
    const pending = interruptedLedger(state, 'return_accept', acceptId)
    if (pending) {
      return continueReturnAcceptance(acceptId)
    }
    if (acceptance.sealed) {
      return {
        ok: false,
        message: `该验收已于历史轮次「${acceptance.status}」并归档，返修请在新一轮验收中处理`,
      }
    }
    if (acceptance.status !== '验收中') {
      return { ok: false, message: `验收当前为「${acceptance.status}」，只有验收中的记录能退回返修` }
    }
    if (openReworksOf(state, acceptance.dispatchId).length > 0) {
      return { ok: false, message: '该维修已存在未闭环的返修事项，一次退回只保留一条返修，请先处理现有返修' }
    }

    commit((draft) => {
      const target = draft.acceptances.find((item) => item.id === acceptId)!
      target.status = '已退回'
      target.验收结论 = '需返修'
      target.维修质量 = '不合格'
      target.复修要求 = requirement
      target.验收日期 = today()
      target.sealed = true
      target.concludedAt = nowIso()
      draft.ledger.push({
        opId,
        type: 'return_accept',
        refId: acceptId,
        dispatchId: target.dispatchId,
        status: '进行中',
        createdAt: nowIso(),
        finishedAt: null,
      })
    }, expectedVersion)
    tripIf('return_accept.after_seal')
    return continueReturnAcceptance(acceptId, opId)
  } catch (error) {
    return toOutcome(error)
  }
}

/** 续做退回：返修事项已存在就跳过创建，最后核销账本。重复执行结果一致。 */
function continueReturnAcceptance(acceptId: number, opId?: string): ActionOutcome {
  try {
    const current = loadFlowState()
    if (!current.acceptances.some((item) => item.id === acceptId)) {
      throw new FlowError(`没有找到编号为 ${acceptId} 的验收记录`)
    }
    if (!interruptedLedger(current, 'return_accept', acceptId)) {
      throw new FlowError('没有找到需要续做的退回提交，无需续做')
    }
    commit((state) => {
      const acceptance = state.acceptances.find((item) => item.id === acceptId)
      if (!acceptance) {
        throw new FlowError(`没有找到编号为 ${acceptId} 的验收记录`)
      }
      if (!state.reworks.some((item) => item.sourceAcceptId === acceptId)) {
        const id = nextId(state, 'rework')
        state.reworks.push({
          id,
          返修编号: REPAIR_CODE.rework(id),
          dispatchId: acceptance.dispatchId,
          关联维修: acceptance.关联维修,
          sourceAcceptId: acceptId,
          返修要求: acceptance.复修要求,
          返修人员: '待分配',
          status: '待返修',
          nextAcceptId: null,
          createdAt: nowIso(),
          startedAt: null,
          finishedAt: null,
        })
      }
      const ledger = interruptedLedger(state, 'return_accept', acceptId)
      if (ledger) {
        ledger.status = '已完成'
        ledger.finishedAt = nowIso()
      }
      void opId
    })
    return { ok: true, message: '已退回返修，返修事项已生成（一条）' }
  } catch (error) {
    return toOutcome(error)
  }
}

// ---------------------------------------------------------------------------
// 返修侧
// ---------------------------------------------------------------------------

export function startRework(reworkId: number): ActionOutcome {
  try {
    commit((state) => {
      const rework = state.reworks.find((item) => item.id === reworkId)
      if (!rework) {
        throw new FlowError(`没有找到编号为 ${reworkId} 的返修事项`)
      }
      if (rework.status === '返修完成') {
        throw new FlowError('该返修事项已完成，不能重复开工')
      }
      if (rework.status !== '待返修') {
        throw new FlowError(`返修事项当前为「${rework.status}」`)
      }
      rework.status = '返修中'
      rework.startedAt = nowIso()
    })
    return { ok: true, message: '返修已开工' }
  } catch (error) {
    return toOutcome(error)
  }
}

/** 返修完成：第 1 步核销返修并记账，第 2 步生成新一轮验收；中断后续做，不重复生成验收。 */
export function finishRework(
  reworkId: number,
  expectedVersion: number,
  opId: string = `fin-${reworkId}-${Date.now()}`,
): ActionOutcome {
  try {
    const state = loadFlowState()
    const rework = state.reworks.find((item) => item.id === reworkId)
    if (!rework) {
      return { ok: false, message: `没有找到编号为 ${reworkId} 的返修事项` }
    }
    // 本笔完成提交中断在半路（返修已核销、新验收未生成、账本进行中）：优先续做。
    const pending = interruptedLedger(state, 'finish_rework', reworkId)
    if (pending) {
      return continueFinishRework(reworkId)
    }
    if (rework.status === '返修完成' && rework.nextAcceptId !== null) {
      return { ok: false, message: '该返修已完成，新一轮验收已生成，不能重复提交' }
    }
    if (rework.status !== '返修中') {
      return { ok: false, message: `返修事项当前为「${rework.status}」，只有返修中的事项能完成返修` }
    }
    if (activeAcceptanceOf(state, rework.dispatchId)) {
      return { ok: false, message: '该维修已有进行中的验收记录，不能重复承接' }
    }

    commit((draft) => {
      const target = draft.reworks.find((item) => item.id === reworkId)!
      target.status = '返修完成'
      target.finishedAt = nowIso()
      draft.ledger.push({
        opId,
        type: 'finish_rework',
        refId: reworkId,
        dispatchId: target.dispatchId,
        status: '进行中',
        createdAt: nowIso(),
        finishedAt: null,
      })
    }, expectedVersion)
    tripIf('finish_rework.after_rework')
    return continueFinishRework(reworkId, opId)
  } catch (error) {
    return toOutcome(error)
  }
}

/** 续做返修完成：新一轮验收已存在就跳过创建，最后核销账本。 */
function continueFinishRework(reworkId: number, opId?: string): ActionOutcome {
  try {
    const current = loadFlowState()
    if (!current.reworks.some((item) => item.id === reworkId)) {
      throw new FlowError(`没有找到编号为 ${reworkId} 的返修事项`)
    }
    if (!interruptedLedger(current, 'finish_rework', reworkId)) {
      throw new FlowError('没有找到需要续做的返修提交，无需续做')
    }
    commit((state) => {
      const rework = state.reworks.find((item) => item.id === reworkId)
      if (!rework) {
        throw new FlowError(`没有找到编号为 ${reworkId} 的返修事项`)
      }
      const sourceAcceptance = state.acceptances.find((item) => item.id === rework.sourceAcceptId)
      if (!sourceAcceptance) {
        throw new FlowError('找不到返修来源验收，链路数据不完整')
      }
      if (rework.nextAcceptId === null) {
        // 同一维修若已有人补建了进行中验收，则不再新建（并发兜底）。
        const occupied = activeAcceptanceOf(state, rework.dispatchId)
        if (occupied) {
          rework.nextAcceptId = occupied.id
        } else {
          const latestRound = state.acceptances
            .filter((item) => item.dispatchId === rework.dispatchId)
            .reduce((max, item) => Math.max(max, item.round), 0)
          const id = nextId(state, 'accept')
          state.acceptances.push({
            id,
            验收编号: REPAIR_CODE.accept(id),
            dispatchId: rework.dispatchId,
            关联维修: rework.关联维修,
            round: latestRound + 1,
            验收人员: '待分配',
            验收日期: '',
            维修质量: '',
            验收结论: '',
            复修要求: '',
            status: '待验收',
            prevAcceptId: sourceAcceptance.id,
            sourceReworkId: rework.id,
            sealed: false,
            createdAt: nowIso(),
            concludedAt: null,
          })
          rework.nextAcceptId = id
        }
      }
      const ledger = interruptedLedger(state, 'finish_rework', reworkId)
      if (ledger) {
        ledger.status = '已完成'
        ledger.finishedAt = nowIso()
      }
      void opId
    })
    return { ok: true, message: '返修已完成，已生成新一轮待验收记录' }
  } catch (error) {
    return toOutcome(error)
  }
}

// ---------------------------------------------------------------------------
// 中断恢复
// ---------------------------------------------------------------------------

export interface InterruptedTask {
  ledger: OpLedgerEntry
  kind: 'return_accept' | 'finish_rework'
  refId: number
  编号: string
  关联维修: string
  resumeLabel: string
}

export function listInterrupted(): InterruptedTask[] {
  const state = loadFlowState()
  return state.ledger
    .filter((item) => item.status === '进行中')
    .map((item) => {
      if (item.type === 'return_accept') {
        const acceptance = state.acceptances.find((row) => row.id === item.refId)
        return {
          ledger: item,
          kind: 'return_accept' as const,
          refId: item.refId,
          编号: acceptance?.验收编号 ?? `验收#${item.refId}`,
          关联维修: acceptance?.关联维修 ?? `维修#${item.dispatchId}`,
          resumeLabel: '补建返修事项',
        }
      }
      const rework = state.reworks.find((row) => row.id === item.refId)
      return {
        ledger: item,
        kind: 'finish_rework' as const,
        refId: item.refId,
        编号: rework?.返修编号 ?? `返修#${item.refId}`,
        关联维修: rework?.关联维修 ?? `维修#${item.dispatchId}`,
        resumeLabel: '补建新一轮验收',
      }
    })
}

export function resumeInterrupted(task: InterruptedTask): ActionOutcome {
  if (task.kind === 'return_accept') {
    return continueReturnAcceptance(task.refId)
  }
  return continueFinishRework(task.refId)
}

// ---------------------------------------------------------------------------
// 查询视图
// ---------------------------------------------------------------------------

export interface RepairViewRow {
  id: number
  /** 生成视图时的状态版本，动作提交回传做 CAS。 */
  viewVersion: number
  派遣编号: string
  缺陷来源: string
  维修人员: string
  预计工时: string
  携带工具: string
  出发时间: string
  返回时间: string
  /** 工作台展示状态：返修/验收优先于维修单自身状态。 */
  status: string
  /** 状态归属说明，区分历史结论与当前环节。 */
  statusNote: string
  round: number
  openRework: ReworkItem | null
  activeAcceptance: AcceptanceRecord | null
  actions: string[]
}

export function listRepairViews(filters: Record<string, string> = {}): { items: RepairViewRow[]; total: number } {
  const state = loadFlowState()
  const items = state.repairs
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((repair) => toRepairViewRow(state, repair))
  const matched = applyFilters(items, filters, ['派遣编号', '缺陷来源', '维修人员'])
  return { items: matched, total: matched.length }
}

function toRepairViewRow(state: RepairFlowState, repair: RepairOrder): RepairViewRow {
  const openRework = openReworksOf(state, repair.id).sort((a, b) => b.id - a.id)[0] ?? null
  const activeAcceptance = activeAcceptanceOf(state, repair.id) ?? null
  const latestAcceptance = state.acceptances
    .filter((item) => item.dispatchId === repair.id)
    .sort((a, b) => b.round - a.round)[0]
  const round = latestAcceptance?.round ?? 0

  let status: string = repair.status
  let statusNote = ''
  let actions: string[] = []
  if (openRework) {
    status = '需返修'
    statusNote =
      openRework.status === '待返修'
        ? `第${round}轮验收已退回，返修事项「${openRework.返修编号}」待返修`
        : `第${round}轮验收已退回，返修事项「${openRework.返修编号}」返修中`
    actions = openRework.status === '待返修' ? ['开始返修'] : ['返修完成']
  } else if (activeAcceptance) {
    status = activeAcceptance.status === '待验收' ? '待验收' : '验收中'
    statusNote = `第${activeAcceptance.round}轮验收${activeAcceptance.status === '待验收' ? '已生成，待发起' : '进行中'}，请到维修验收处理`
    actions = []
  } else if (latestAcceptance?.status === '已通过') {
    status = '已闭环'
    statusNote = `第${latestAcceptance.round}轮验收已通过，历史结论保持不变`
    actions = []
  } else {
    statusNote = {
      待派遣: '维修单待派遣',
      已派遣: '已派遣，可出发维修',
      维修中: '维修人员现场维修中',
      已返回: '维修已返回，等待生成验收',
    }[repair.status]
    actions = {
      待派遣: ['下达派遣'],
      已派遣: ['出发维修'],
      维修中: ['返回确认'],
      已返回: [],
    }[repair.status]
  }

  return {
    id: repair.id,
    viewVersion: state.version,
    派遣编号: repair.派遣编号,
    缺陷来源: repair.缺陷来源,
    维修人员: repair.维修人员,
    预计工时: repair.预计工时,
    携带工具: repair.携带工具,
    出发时间: repair.出发时间,
    返回时间: repair.返回时间,
    status,
    statusNote,
    round,
    openRework,
    activeAcceptance,
    actions,
  }
}

export interface AcceptanceViewRow {
  id: number
  /** 生成视图时的状态版本：动作提交时回传做 CAS，期间被他人处理过则拒绝并提示刷新。 */
  viewVersion: number
  验收编号: string
  关联维修: string
  round: number
  验收人员: string
  验收日期: string
  维修质量: string
  验收结论: string
  复修要求: string
  status: string
  historical: boolean
  sourceReworkId: number | null
  actions: string[]
}

export function listAcceptanceViews(filters: Record<string, string> = {}): {
  items: AcceptanceViewRow[]
  total: number
} {
  const state = loadFlowState()
  const items = state.acceptances
    .slice()
    .sort((a, b) => a.dispatchId - b.dispatchId || a.round - b.round)
    .map((acceptance) => {
      const actions = acceptance.sealed
        ? []
        : acceptance.status === '待验收'
          ? ['发起验收']
          : ['确认通过', '退回返修']
      return {
        id: acceptance.id,
        viewVersion: state.version,
        验收编号: acceptance.验收编号,
        关联维修: acceptance.关联维修,
        round: acceptance.round,
        验收人员: acceptance.验收人员,
        验收日期: acceptance.验收日期,
        维修质量: acceptance.维修质量,
        验收结论: acceptance.验收结论 || (acceptance.status === '验收中' ? '待出结论' : '—'),
        复修要求: acceptance.复修要求,
        status: acceptance.status,
        historical: acceptance.sealed,
        sourceReworkId: acceptance.sourceReworkId,
        actions,
      }
    })
  const matched = applyFilters(items, filters, ['验收编号', '关联维修', '验收人员'])
  return { items: matched, total: matched.length }
}

export interface AcceptanceDetail {
  acceptance: AcceptanceRecord
  repair: RepairOrder | null
  sourceRework: ReworkItem | null
  /** 同一维修按轮次排列的验收链，含两轮之间的返修事项。 */
  timeline: Array<
    | { kind: 'acceptance'; round: number; item: AcceptanceRecord }
    | { kind: 'rework'; item: ReworkItem }
  >
}

export function getAcceptanceDetail(acceptId: number): AcceptanceDetail | null {
  const state = loadFlowState()
  const acceptance = state.acceptances.find((item) => item.id === acceptId)
  if (!acceptance) {
    return null
  }
  const chain = state.acceptances
    .filter((item) => item.dispatchId === acceptance.dispatchId)
    .sort((a, b) => a.round - b.round)
  const timeline: AcceptanceDetail['timeline'] = []
  for (const item of chain) {
    timeline.push({ kind: 'acceptance', round: item.round, item })
    if (item.sourceReworkId) {
      const rework = state.reworks.find((row) => row.id === item.sourceReworkId)
      if (rework) {
        timeline.push({ kind: 'rework', item: rework })
      }
    }
  }
  const sourceRework = acceptance.sourceReworkId
    ? state.reworks.find((item) => item.id === acceptance.sourceReworkId) ?? null
    : null
  const repair = state.repairs.find((item) => item.id === acceptance.dispatchId) ?? null
  return { acceptance, repair, sourceRework, timeline }
}

export function getRework(reworkId: number): ReworkItem | null {
  return loadFlowState().reworks.find((item) => item.id === reworkId) ?? null
}

export interface FlowStats {
  repair: { label: string; value: number }[]
  acceptance: { label: string; value: number }[]
}

export function flowStats(): FlowStats {
  const state = loadFlowState()
  const repairRows = state.repairs.map((repair) => toRepairViewRow(state, repair))
  const pendingDispatch = repairRows.filter((row) => row.status === '待派遣').length
  const inField = repairRows.filter((row) => row.status === '已派遣' || row.status === '维修中').length
  const pendingAccept = repairRows.filter((row) => row.status === '待验收' || row.status === '验收中').length
  const openRework = state.reworks.filter((item) => item.status !== '返修完成').length
  return {
    repair: [
      { label: '待派遣维修', value: pendingDispatch },
      { label: '现场维修中', value: inField },
      { label: '待验收维修', value: pendingAccept },
      { label: '未闭环返修', value: openRework },
    ],
    acceptance: [
      { label: '待验收记录', value: state.acceptances.filter((item) => item.status === '待验收').length },
      { label: '验收中记录', value: state.acceptances.filter((item) => item.status === '验收中').length },
      { label: '已通过（历史）', value: state.acceptances.filter((item) => item.status === '已通过').length },
      { label: '已退回（历史）', value: state.acceptances.filter((item) => item.status === '已退回').length },
    ],
  }
}

export function currentVersion(): number {
  return loadFlowState().version
}

// ---------------------------------------------------------------------------
// 看板汇总 / 导出 / 重置
// ---------------------------------------------------------------------------

export function flowOverviewEntry() {
  const state = loadFlowState()
  const pending =
    state.repairs.filter((item) => item.status !== '已返回').length +
    state.acceptances.filter((item) => !item.sealed).length +
    state.reworks.filter((item) => item.status !== '返修完成').length
  const abnormal =
    state.reworks.filter((item) => item.status !== '返修完成').length +
    state.ledger.filter((item) => item.status === '进行中').length
  return {
    out_repair: { created: state.repairs.length, pending, abnormal },
    repair_accept: {
      created: state.acceptances.length,
      pending: state.acceptances.filter((item) => !item.sealed).length,
      abnormal: state.acceptances.filter((item) => item.status === '已退回').length,
    },
  }
}

export function resetRepairFlow(): void {
  resetFlowState()
}


function csvCell(value: string | number): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportRepairsCsv(): { filename: string; content: string } {
  const { items } = listRepairViews()
  const header = ['派遣编号', '缺陷来源', '维修人员', '预计工时', '携带工具', '出发时间', '返回时间', '当前环节']
  const lines = [
    header.join(','),
    ...items.map((row) =>
      [
        row.派遣编号,
        row.缺陷来源,
        row.维修人员,
        row.预计工时,
        row.携带工具,
        row.出发时间,
        row.返回时间,
        row.status,
      ]
        .map(csvCell)
        .join(','),
    ),
  ]
  return { filename: '外出维修-清单.csv', content: `﻿${lines.join('\n')}` }
}

export function exportAcceptancesCsv(): { filename: string; content: string } {
  const { items } = listAcceptanceViews()
  const header = ['验收编号', '关联维修', '轮次', '验收人员', '验收日期', '维修质量', '验收结论', '复修要求', '验收状态']
  const lines = [
    header.join(','),
    ...items.map((row) =>
      [
        row.验收编号,
        row.关联维修,
        `第${row.round}轮`,
        row.验收人员,
        row.验收日期,
        row.维修质量,
        row.验收结论,
        row.复修要求,
        row.status,
      ]
        .map(csvCell)
        .join(','),
    ),
  ]
  return { filename: '维修验收-清单.csv', content: `﻿${lines.join('\n')}` }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function applyFilters<T extends object>(
  rows: T[],
  filters: Record<string, string>,
  fields: string[],
): T[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) =>
      fields.includes(field) ? String((row as Record<string, unknown>)[field] ?? '').includes(value.trim()) : true,
    ),
  )
}

function toOutcome(error: unknown): ActionOutcome {
  if (error instanceof FlowError || error instanceof ConcurrencyError) {
    return { ok: false, message: error.message }
  }
  const message = error instanceof Error ? error.message : '操作失败'
  return { ok: false, message }
}

// 供联调脚本/页面读取底层状态与重置入口。
export { loadFlowState, resetFlowState }
