/**
 * 维修验收链路的专属数据层：外出维修 → 验收 → 返修 → 新一轮验收。
 *
 * 与通用条目库（local-store）分开存储：这里的每一条记录都带业务关联，
 * 验收结论一旦封档就不再被覆盖，返修事项与验收记录一一对应。
 */

const STORAGE_KEY = 'underground-pipeline-inspection:repair-flow-v1'

export type RepairStage = '待派遣' | '已派遣' | '维修中' | '已返回'
export type AcceptStage = '待验收' | '验收中' | '已通过' | '已退回'
export type ReworkStage = '待返修' | '返修中' | '返修完成'

/** 外出维修（派遣单）：维修侧的主记录。 */
export interface RepairOrder {
  id: number
  派遣编号: string
  缺陷来源: string
  维修人员: string
  预计工时: string
  携带工具: string
  出发时间: string
  返回时间: string
  status: RepairStage
  createdAt: string
  updatedAt: string
}

/** 验收记录：同一维修每返修一轮就新增一条，结论封档后不可变。 */
export interface AcceptanceRecord {
  id: number
  验收编号: string
  dispatchId: number
  /** 关联维修（冗余派遣编号，便于列表展示与检索）。 */
  关联维修: string
  /** 第几轮验收：首次为 1，每返修一次 +1。 */
  round: number
  验收人员: string
  验收日期: string
  维修质量: string
  /** 未出结论为空；通过为「合格」，退回为「需返修」。 */
  验收结论: string
  复修要求: string
  status: AcceptStage
  /** 上一轮验收记录 id，首轮为 null。 */
  prevAcceptId: number | null
  /** 由哪条返修事项触发（新一轮验收），首轮为 null。 */
  sourceReworkId: number | null
  sealed: boolean
  createdAt: string
  concludedAt: string | null
}

/** 返修事项：一条退回只能产生一条，闭环后承接出新验收。 */
export interface ReworkItem {
  id: number
  返修编号: string
  dispatchId: number
  关联维修: string
  sourceAcceptId: number
  返修要求: string
  返修人员: string
  status: ReworkStage
  nextAcceptId: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

/** 多步操作的账本：中断后凭它从中断环节继续，且不重复生成记录。 */
export interface OpLedgerEntry {
  opId: string
  type: 'return_accept' | 'finish_rework'
  /** 操作主要关联的验收或返修记录 id。 */
  refId: number
  dispatchId: number
  status: '进行中' | '已完成'
  createdAt: string
  finishedAt: string | null
}

export interface RepairFlowState {
  /** 乐观锁版本：每次提交 +1，提交时校验，防止多人并发覆盖。 */
  version: number
  repairs: RepairOrder[]
  acceptances: AcceptanceRecord[]
  reworks: ReworkItem[]
  ledger: OpLedgerEntry[]
  seq: { repair: number; accept: number; rework: number }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function padId(value: number): string {
  return String(value).padStart(4, '0')
}

function now(): string {
  return new Date().toISOString()
}

/** 首次播种的示例链路：覆盖待派遣、维修中、待验收、验收中、已通过、需返修、返修后复验各环节。 */
export function seedFlowState(): RepairFlowState {
  const repairs: RepairOrder[] = [
    { id: 1, 派遣编号: 'OUT-0001', 缺陷来源: '巡检上报-井盖周边路面沉降', 维修人员: '李建国', 预计工时: '4小时', 携带工具: '探地雷达、水平仪', 出发时间: '', 返回时间: '', status: '待派遣', createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z' },
    { id: 2, 派遣编号: 'OUT-0002', 缺陷来源: '市民热线-雨污混接异味', 维修人员: '王海涛', 预计工时: '3小时', 携带工具: '管道潜望镜、疏通机', 出发时间: '2026-09-02T09:00:00.000Z', 返回时间: '', status: '已派遣', createdAt: '2026-09-02T08:30:00.000Z', updatedAt: '2026-09-02T09:00:00.000Z' },
    { id: 3, 派遣编号: 'OUT-0003', 缺陷来源: '缺陷记录 DEFE-0017-管节错位', 维修人员: '赵志强', 预计工时: '6小时', 携带工具: '非开挖修复机具', 出发时间: '2026-09-03T08:40:00.000Z', 返回时间: '', status: '维修中', createdAt: '2026-09-03T08:00:00.000Z', updatedAt: '2026-09-03T08:40:00.000Z' },
    { id: 4, 派遣编号: 'OUT-0004', 缺陷来源: '流量计报警-下游流量偏低', 维修人员: '李建国', 预计工时: '5小时', 携带工具: '听漏仪、相关仪', 出发时间: '2026-09-04T08:20:00.000Z', 返回时间: '2026-09-04T13:10:00.000Z', status: '已返回', createdAt: '2026-09-04T08:00:00.000Z', updatedAt: '2026-09-04T13:10:00.000Z' },
    { id: 5, 派遣编号: 'OUT-0005', 缺陷来源: '巡检上报-支管接口渗漏', 维修人员: '孙明远', 预计工时: '4小时', 携带工具: '快速封堵器、密封胶', 出发时间: '2026-09-06T08:30:00.000Z', 返回时间: '2026-09-06T12:00:00.000Z', status: '已返回', createdAt: '2026-09-06T08:00:00.000Z', updatedAt: '2026-09-06T12:00:00.000Z' },
    { id: 6, 派遣编号: 'OUT-0006', 缺陷来源: '缺陷记录 DEFE-0021-管道裂纹', 维修人员: '王海涛', 预计工时: '8小时', 携带工具: '不锈钢套环、力矩扳手', 出发时间: '2026-09-08T08:10:00.000Z', 返回时间: '2026-09-08T16:30:00.000Z', status: '已返回', createdAt: '2026-09-08T08:00:00.000Z', updatedAt: '2026-09-08T16:30:00.000Z' },
    { id: 7, 派遣编号: 'OUT-0007', 缺陷来源: '雨后复查-检查井井筒渗漏', 维修人员: '赵志强', 预计工时: '5小时', 携带工具: '注浆机、防水砂浆', 出发时间: '2026-09-10T08:20:00.000Z', 返回时间: '2026-09-10T13:00:00.000Z', status: '已返回', createdAt: '2026-09-10T08:00:00.000Z', updatedAt: '2026-09-10T13:00:00.000Z' },
    { id: 8, 派遣编号: 'OUT-0008', 缺陷来源: '水质异常排查-管线淤积堵塞', 维修人员: '孙明远', 预计工时: '6小时', 携带工具: '高压清洗车、吸污车', 出发时间: '2026-09-12T08:10:00.000Z', 返回时间: '2026-09-12T14:40:00.000Z', status: '已返回', createdAt: '2026-09-12T08:00:00.000Z', updatedAt: '2026-09-12T14:40:00.000Z' },
  ]

  const acceptances: AcceptanceRecord[] = [
    { id: 1, 验收编号: 'REPA-0001', dispatchId: 4, 关联维修: 'OUT-0004', round: 1, 验收人员: '周验收', 验收日期: '2026-09-05', 维修质量: '合格', 验收结论: '合格', 复修要求: '', status: '已通过', prevAcceptId: null, sourceReworkId: null, sealed: true, createdAt: '2026-09-04T13:20:00.000Z', concludedAt: '2026-09-05T10:00:00.000Z' },
    { id: 2, 验收编号: 'REPA-0002', dispatchId: 5, 关联维修: 'OUT-0005', round: 1, 验收人员: '周验收', 验收日期: '', 维修质量: '', 验收结论: '', 复修要求: '', status: '待验收', prevAcceptId: null, sourceReworkId: null, sealed: false, createdAt: '2026-09-06T12:10:00.000Z', concludedAt: null },
    { id: 3, 验收编号: 'REPA-0003', dispatchId: 6, 关联维修: 'OUT-0006', round: 1, 验收人员: '吴验收', 验收日期: '2026-09-09', 维修质量: '', 验收结论: '', 复修要求: '', status: '验收中', prevAcceptId: null, sourceReworkId: null, sealed: false, createdAt: '2026-09-08T16:40:00.000Z', concludedAt: null },
    { id: 4, 验收编号: 'REPA-0004', dispatchId: 7, 关联维修: 'OUT-0007', round: 1, 验收人员: '吴验收', 验收日期: '2026-09-11', 维修质量: '不合格', 验收结论: '需返修', 复修要求: '井筒注浆不饱满，井壁仍有渗漏点，需重新注浆并做 24 小时闭水观察', status: '已退回', prevAcceptId: null, sourceReworkId: null, sealed: true, createdAt: '2026-09-10T13:10:00.000Z', concludedAt: '2026-09-11T11:00:00.000Z' },
    { id: 5, 验收编号: 'REPA-0005', dispatchId: 8, 关联维修: 'OUT-0008', round: 1, 验收人员: '周验收', 验收日期: '2026-09-13', 维修质量: '不合格', 验收结论: '需返修', 复修要求: '下游管段清洗不彻底，仍有淤积残留，需重新清通并复核过水能力', status: '已退回', prevAcceptId: null, sourceReworkId: null, sealed: true, createdAt: '2026-09-12T14:50:00.000Z', concludedAt: '2026-09-13T10:30:00.000Z' },
    { id: 6, 验收编号: 'REPA-0006', dispatchId: 8, 关联维修: 'OUT-0008', round: 2, 验收人员: '周验收', 验收日期: '', 维修质量: '', 验收结论: '', 复修要求: '', status: '待验收', prevAcceptId: 5, sourceReworkId: 2, sealed: false, createdAt: '2026-09-15T09:20:00.000Z', concludedAt: null },
  ]

  const reworks: ReworkItem[] = [
    { id: 1, 返修编号: 'RW-0001', dispatchId: 7, 关联维修: 'OUT-0007', sourceAcceptId: 4, 返修要求: '井筒注浆不饱满，井壁仍有渗漏点，需重新注浆并做 24 小时闭水观察', 返修人员: '赵志强', status: '待返修', nextAcceptId: null, createdAt: '2026-09-11T11:05:00.000Z', startedAt: null, finishedAt: null },
    { id: 2, 返修编号: 'RW-0002', dispatchId: 8, 关联维修: 'OUT-0008', sourceAcceptId: 5, 返修要求: '下游管段清洗不彻底，仍有淤积残留，需重新清通并复核过水能力', 返修人员: '孙明远', status: '返修完成', nextAcceptId: 6, createdAt: '2026-09-13T10:35:00.000Z', startedAt: '2026-09-14T08:30:00.000Z', finishedAt: '2026-09-15T09:10:00.000Z' },
  ]

  return {
    version: 1,
    repairs,
    acceptances,
    reworks,
    ledger: [],
    seq: { repair: 8, accept: 6, rework: 2 },
  }
}

let cache: RepairFlowState | null = null

function readStorage(): RepairFlowState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedFlowState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedFlowState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return JSON.parse(raw) as RepairFlowState
  } catch {
    const seeded = seedFlowState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

/** 每次都从存储里拿最新状态：多标签页/并发场景下不依赖旧缓存。 */
export function loadFlowState(): RepairFlowState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveFlowState(state: RepairFlowState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetFlowState(): RepairFlowState {
  const seeded = seedFlowState()
  saveFlowState(seeded)
  return seeded
}

export function flowStorageKey(): string {
  return STORAGE_KEY
}

export const REPAIR_CODE = {
  repair: (id: number) => `OUT-${padId(id)}`,
  accept: (id: number) => `REPA-${padId(id)}`,
  rework: (id: number) => `RW-${padId(id)}`,
}

