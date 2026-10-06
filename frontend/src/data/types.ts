/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 内部模块（如返修事项）由链路自动维护，不出现在独立导航与看板模块表里。 */
  internal?: boolean
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 链路操作的多步事务类型：退回返修 / 确认通过 / 完成返修。 */
export type PendingKind = 'return' | 'pass' | 'complete_rework'

/**
 * 中断事务日志：每完成一个阶段就随阶段数据一起落盘，nextStage 指向下一个待执行阶段。
 * 刷新、关闭页面后凭它从断点继续，创建类阶段靠链上查重保证幂等（不会多出一条）。
 */
export type PendingOp = {
  id: string
  kind: PendingKind
  chainId: string
  acceptanceId: number
  /** 退回时生成的返修事项编号，阶段执行后回填。 */
  reworkId?: number
  /** 返修完成后新建的承接验收编号，阶段执行后回填。 */
  newAcceptanceId?: number
  nextStage: string
  holder: string
  lockToken: string
  startedAt: number
  detail: string
}

/** 链级处理锁：同一维修链同一时刻只允许一个处理人推进。 */
export type LockRecord = {
  token: string
  holder: string
  expiresAt: number
}

/** localStorage 里的整体结构：业务分桶 + 中断事务 + 链级锁，一次写入整体提交。 */
export type StoredState = {
  version: 2
  buckets: Record<string, EntryRow[]>
  pending: PendingOp[]
  locks: Record<string, LockRecord>
}

/** 验收结论录入：退回时 repairRequest 必填。 */
export type ConclusionInput = {
  quality: string
  summary: string
  repairRequest: string
}
