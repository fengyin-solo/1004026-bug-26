import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 链路测试不依赖浏览器：用内存版 localStorage 代替。
 * local-store 在模块加载时判定 typeof window === 'undefined'，自动落到 seedState()，
 * 这里再暴露一个最小 Storage 桩，保证写读路径都能被测到。
 */
class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: new MemoryStorage(), addEventListener: () => undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import { bucket, resetAll } from '@/data/local-store'
import {
  ACCEPT_KEY,
  ChainError,
  LockBusyError,
  OUT_REPAIR_KEY,
  REWORK_KEY,
  StageFault,
  acceptStats,
  acceptanceRows,
  beginAcceptance,
  chainTimeline,
  completeRework,
  dispatchAction,
  expiredOps,
  pendingOps,
  reclaimChain,
  resetChain,
  resumeAll,
  resumeOp,
  startAcceptance,
  submitPass,
  submitReturn,
  workbenchRows,
  workbenchStats,
} from '@/api/repair-chain'
import type { EntryRow } from '@/data/types'

const PASS_INPUT = { quality: '合格', summary: '现场核验合格', repairRequest: '' }

function dispatchByCode(code: string): EntryRow {
  const row = bucket(OUT_REPAIR_KEY).find((item) => item.派遣编号 === code)
  if (!row) throw new Error(`种子缺少派遣 ${code}`)
  return row
}

/** 把一条派遣推进到「已返回、首轮验收中」，返回该验收记录。 */
function freshAcceptingChain(code: string): EntryRow {
  const dispatch = dispatchByCode(code)
  if (dispatch.status === '维修中') {
    dispatchAction(Number(dispatch.id), '返回确认')
  }
  startAcceptance(Number(dispatch.id), '验收员甲')
  const waiting = acceptanceRows().find((row) => row.chainId === code && row.status === '待验收')
  if (!waiting) throw new Error('首轮验收未创建')
  beginAcceptance(Number(waiting.id))
  return bucket(ACCEPT_KEY).find((row) => row.id === waiting.id) as EntryRow
}

function rowsByStatus(key: string, status: string): EntryRow[] {
  return bucket(key).filter((row) => row.status === status)
}

function openReworksOf(chainId: string): EntryRow[] {
  return bucket(REWORK_KEY).filter((row) => row.chainId === chainId && row.status === '待返修')
}

describe('维修—验收—返修完整链路', () => {
  beforeEach(() => {
    resetAll()
  })

  it('正常路径：返回 → 发起验收 → 通过 → 维修闭环，历史结论即现行结论', () => {
    const acceptance = freshAcceptingChain('OUT_-0001')
    expect(acceptance.status).toBe('验收中')

    submitPass(Number(acceptance.id), PASS_INPUT, '验收员甲')

    const passed = bucket(ACCEPT_KEY).find((row) => row.id === acceptance.id) as EntryRow
    expect(passed.status).toBe('已通过')
    const dispatch = dispatchByCode('OUT_-0001')
    expect(dispatch.status).toBe('已闭环')
    expect(workbenchStats().closed).toBeGreaterThan(0)
    // 当前轮通过才计数；该链只有一轮，所以它同时是现行结论。
    expect(acceptStats().closedPassed).toBeGreaterThan(0)
    expect(pendingOps()).toHaveLength(0)
  })

  it('退回路径：只生成一条返修事项、验收封存为历史、维修转返修中', () => {
    const acceptance = freshAcceptingChain('OUT_-0001')

    submitReturn(
      Number(acceptance.id),
      { quality: '不合格', summary: '仍有渗漏', repairRequest: '重新注浆并做闭水试验' },
      '验收员甲',
    )

    // 1) 唯一一条待返修事项
    const sourceCode = String(acceptance.验收编号)
    const openReworks = openReworksOf('OUT_-0001')
    expect(openReworks).toHaveLength(1)
    expect(openReworks[0].返修要求).toBe('重新注浆并做闭水试验')
    expect(openReworks[0].来源验收).toBe(sourceCode)
    // 2) 旧验收轮次封存：虽还是最新轮，但已不可再提交结论；返修完成、新轮开出来后才变成历史
    const frozen = bucket(ACCEPT_KEY).find((row) => row.id === acceptance.id) as EntryRow
    expect(frozen.status).toBe('需返修')
    const frozenView = acceptanceRows().find((row) => row.id === acceptance.id)
    expect(frozenView?.history).toBe(false)
    expect(frozenView?.sealed).toBe(true)
    expect(frozenView?.actionable).toBe(false)
    // 3) 维修进入返修中，外出工作台能看到同一条待办
    expect(dispatchByCode('OUT_-0001').status).toBe('返修中')
    const bench = workbenchRows().find((row) => row.dispatch.派遣编号 === 'OUT_-0001')
    expect(bench?.openRework?.id).toBe(openReworks[0].id)
    expect(workbenchStats().reworking).toBeGreaterThan(0)
  })

  it('返修完成：新验收记录承接，旧「需返修」结论保持历史且不被当成现行状态', () => {
    const acceptance = freshAcceptingChain('OUT_-0001')
    submitReturn(
      Number(acceptance.id),
      { quality: '不合格', summary: '仍有渗漏', repairRequest: '重新注浆' },
      '验收员甲',
    )
    const dispatchId = Number(dispatchByCode('OUT_-0001').id)

    completeRework(dispatchId, '维修工甲')

    // 返修事项已完成
    expect(openReworksOf('OUT_-0001')).toHaveLength(0)
    // 维修处于返修完成、等待新一轮验收
    expect(dispatchByCode('OUT_-0001').status).toBe('返修完成')
    // 新一轮验收承接
    const rounds = bucket(ACCEPT_KEY).filter((row) => row.chainId === 'OUT_-0001')
    expect(rounds).toHaveLength(2)
    const second = rounds.find((row) => Number(row.round) === 2) as EntryRow
    expect(second.status).toBe('待验收')
    // 旧轮仍是需返修（历史），看板只把新轮算作待验收，返修中的统计不再含本链
    const stats = acceptStats()
    expect(stats.waitingAccept).toBeGreaterThan(0)
    const reworkingChains = new Set(
      acceptanceRows().filter((r) => !r.history && r.status === '需返修').map((r) => r.chainId),
    )
    expect(reworkingChains.has('OUT_-0001')).toBe(false)

    // 第二轮复验通过 → 闭环；第一轮的退回结论原样保留
    beginAcceptance(Number(second.id))
    submitPass(Number(second.id), { ...PASS_INPUT, summary: '复验合格' }, '验收员甲')
    expect(dispatchByCode('OUT_-0001').status).toBe('已闭环')
    const first = rounds.find((row) => Number(row.round) === 1) as EntryRow
    expect(first.status).toBe('需返修')
    expect(first.验收结论).toBe('仍有渗漏')
    const timeline = chainTimeline('OUT_-0001')
    expect(timeline.accepts.map((row) => row.status)).toEqual(['需返修', '已通过'])
    // 现行结论是第二轮通过，而不是历史上的任何记录
    const bench = workbenchRows().find((row) => row.dispatch.派遣编号 === 'OUT_-0001')
    expect(bench?.latest?.status).toBe('已通过')
  })

  it('提交中断：从断点继续，不重复生成返修事项，也不重复新建验收', () => {
    const acceptance = freshAcceptingChain('OUT_-0001')
    // 中断点放在「封存本轮验收」之前：第 1 阶段（生成返修事项）已提交。
    expect(() =>
      submitReturn(
        Number(acceptance.id),
        { quality: '不合格', summary: '渗漏', repairRequest: '重新注浆' },
        '验收员甲',
        { faultBeforeStage: 'freeze_acceptance', nowMs: 1_000_000, ttl: 60_000 },
      ),
    ).toThrow(StageFault)

    // 断点现场：1 条返修事项、1 条悬挂事务；验收仍是验收中、维修尚未转返修
    expect(openReworksOf('OUT_-0001')).toHaveLength(1)
    expect(pendingOps()).toHaveLength(1)
    const stuck = pendingOps()[0]
    expect(stuck.nextStage).toBe('freeze_acceptance')
    expect(bucket(ACCEPT_KEY).find((row) => row.id === acceptance.id)?.status).toBe('验收中')

    // 再次提交必须被拒绝（锁 + 悬挂事务），不能靠重新提交补流程
    expect(() =>
      submitReturn(
        Number(acceptance.id),
        { quality: '不合格', summary: '渗漏', repairRequest: '重新注浆' },
        '验收员乙',
        { nowMs: 1_001_000 },
      ),
    ).toThrow(LockBusyError)

    // 从断点继续
    resumeOp(stuck.id, { nowMs: 1_002_000, ttl: 60_000 })
    expect(openReworksOf('OUT_-0001')).toHaveLength(1) // 没有多出一条
    expect(bucket(ACCEPT_KEY).find((row) => row.id === acceptance.id)?.status).toBe('需返修')
    expect(dispatchByCode('OUT_-0001').status).toBe('返修中')
    expect(pendingOps()).toHaveLength(0)

    // 完成返修时在「开启新一轮验收」前中断：前两阶段已落盘
    const dispatchId = Number(dispatchByCode('OUT_-0001').id)
    expect(() =>
      completeRework(dispatchId, '维修工甲', {
        faultBeforeStage: 'open_next_round',
        nowMs: 2_000_000,
        ttl: 60_000,
      }),
    ).toThrow(StageFault)
    expect(dispatchByCode('OUT_-0001').status).toBe('返修完成')
    const roundsBefore = bucket(ACCEPT_KEY).filter((row) => row.chainId === 'OUT_-0001')
    expect(roundsBefore).toHaveLength(1) // 新验收还没建

    resumeAll({ nowMs: 2_001_000, ttl: 60_000 })
    const roundsAfter = bucket(ACCEPT_KEY).filter((row) => row.chainId === 'OUT_-0001')
    expect(roundsAfter).toHaveLength(2) // 继续后只建一条新验收
    expect(pendingOps()).toHaveLength(0)
  })

  it('多人同时退回同一验收：只有一人成功，另一人被处理锁挡住', () => {
    const acceptanceA = freshAcceptingChain('OUT_-0001')
    // 甲在第 1 阶段提交后中断，锁仍有效
    expect(() =>
      submitReturn(
        Number(acceptanceA.id),
        { quality: '不合格', summary: '渗漏', repairRequest: '重新注浆' },
        '验收员甲',
        { faultBeforeStage: 'freeze_acceptance', nowMs: 5_000_000, ttl: 60_000 },
      ),
    ).toThrow(StageFault)

    // 乙拿的是同一个页面状态（验收仍显示验收中），尝试退回 → 必须失败
    expect(() =>
      submitReturn(
        Number(acceptanceA.id),
        { quality: '不合格', summary: '我也觉得不行', repairRequest: '换管材' },
        '验收员乙',
        { nowMs: 5_001_000 },
      ),
    ).toThrow(LockBusyError)
    // 确认通过也不能插队
    expect(() =>
      submitPass(Number(acceptanceA.id), PASS_INPUT, '验收员乙', { nowMs: 5_002_000 }),
    ).toThrow(LockBusyError)

    // 只有甲的返修事项落了地（一条），乙的复修要求没有产生任何数据
    const openReworks = openReworksOf('OUT_-0001')
    expect(openReworks).toHaveLength(1)
    expect(openReworks[0].返修要求).toBe('重新注浆')
  })

  it('历史轮次冻结：不能对旧记录提交结论，必须处理最新一轮', () => {
    const acceptance = freshAcceptingChain('OUT_-0001')
    submitReturn(
      Number(acceptance.id),
      { quality: '不合格', summary: '渗漏', repairRequest: '重新注浆' },
      '验收员甲',
    )
    completeRework(Number(dispatchByCode('OUT_-0001').id), '维修工甲')
    const second = bucket(ACCEPT_KEY)
      .filter((row) => row.chainId === 'OUT_-0001')
      .find((row) => Number(row.round) === 2) as EntryRow
    beginAcceptance(Number(second.id))

    // 试图对历史第一轮做通过/退回都被拒绝
    expect(() => submitPass(Number(acceptance.id), PASS_INPUT, '验收员甲')).toThrow(ChainError)
    expect(() =>
      submitReturn(
        Number(acceptance.id),
        { quality: '不合格', summary: 'x', repairRequest: 'y' },
        '验收员甲',
      ),
    ).toThrow(ChainError)
    // 最新轮可以正常通过并闭环
    submitPass(Number(second.id), PASS_INPUT, '验收员甲')
    expect(dispatchByCode('OUT_-0001').status).toBe('已闭环')
  })

  it('发起验收幂等：已返回链重复发起不会多出验收；未返回不能发起', () => {
    const dispatch = dispatchByCode('OUT_-0001') // 种子里是维修中
    expect(() => startAcceptance(Number(dispatch.id), '验收员甲')).toThrow(ChainError)

    dispatchAction(Number(dispatch.id), '返回确认')
    startAcceptance(Number(dispatch.id), '验收员甲')
    expect(() => startAcceptance(Number(dispatch.id), '验收员甲')).toThrow(ChainError)
    expect(
      bucket(ACCEPT_KEY).filter((row) => row.chainId === 'OUT_-0001'),
    ).toHaveLength(1)
  })

  it('锁过期后可接管：清理悬挂事务，链上数据停留在最近断点可重新发起', () => {
    const acceptance = freshAcceptingChain('OUT_-0001')
    expect(() =>
      submitReturn(
        Number(acceptance.id),
        { quality: '不合格', summary: '渗漏', repairRequest: '重新注浆' },
        '验收员甲',
        { faultBeforeStage: 'freeze_acceptance', nowMs: 9_000_000, ttl: 1000 },
      ),
    ).toThrow(StageFault)

    // 锁仍有效时不能接管
    expect(() => reclaimChain('OUT_-0001', 9_000_500)).toThrow(LockBusyError)
    // 过期后出现在 expiredOps 中，可接管
    expect(expiredOps(9_002_000)).toHaveLength(1)
    reclaimChain('OUT_-0001', 9_002_000)
    expect(pendingOps()).toHaveLength(0)
    // 第 1 阶段的返修事项仍在（断点数据保留），重新退回时靠链上查重不会造第二条
    expect(openReworksOf('OUT_-0001')).toHaveLength(1)
  })
})
