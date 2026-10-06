/**
 * 验收—维修—返修链路验证脚本：node scripts/verify-repair-flow.mjs
 *
 * 用 esbuild 把 TS 服务打包后在 Node 里运行，localStorage 用内存版 shim。
 * 覆盖：完整链路、退回只留一条返修、新验收承接与旧结论历史化、
 * 提交中断续做不重复、并发退回只成功一人、非法流转拦截。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function assert(condition, message) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
}

const harness = `
import {
  armFault, clearFault,
  dispatchRepair, startRepair, returnRepair,
  startAcceptance, passAcceptance, returnAcceptance,
  startRework, finishRework,
  listInterrupted, resumeInterrupted,
  listRepairViews, listAcceptanceViews, getAcceptanceDetail,
  loadFlowState, resetRepairFlow, currentVersion,
} from '@/api/repair-flow-service'

globalThis.__flow = {
  armFault, clearFault,
  dispatchRepair, startRepair, returnRepair,
  startAcceptance, passAcceptance, returnAcceptance,
  startRework, finishRework,
  listInterrupted, resumeInterrupted,
  listRepairViews, listAcceptanceViews, getAcceptanceDetail,
  loadFlowState, resetRepairFlow, currentVersion,
}
`
const dir = mkdtempSync(join(tmpdir(), 'repair-flow-'))
const entry = join(dir, 'harness.ts')
writeFileSync(entry, harness)
const outfile = join(dir, 'harness.mjs')

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  alias: { '@': join(process.cwd(), 'src') },
})
await import(pathToFileURL(outfile).href)
const svc = globalThis.__flow

function repairView(dispatchId) {
  return svc.listRepairViews().items.find((row) => row.id === dispatchId)
}
function activeAcceptance(dispatchId) {
  const state = svc.loadFlowState()
  return state.acceptances
    .filter((item) => item.dispatchId === dispatchId && !item.sealed)
    .sort((a, b) => b.round - a.round)[0]
}

// --- 1. 正常链路：派遣→维修→返回→验收通过 -------------------------------
console.log('\n[1] 正常链路闭环')
svc.resetRepairFlow()
let r = svc.dispatchRepair(1)
assert(r.ok, '待派遣 → 下达派遣成功')
r = svc.startRepair(1)
assert(r.ok, '已派遣 → 出发维修成功')
r = svc.returnRepair(1)
assert(r.ok, '维修中 → 返回确认成功并生成首轮验收')
let acc1 = activeAcceptance(1)
assert(!!acc1 && acc1.round === 1 && acc1.status === '待验收', '生成第 1 轮待验收记录')
r = svc.returnRepair(1)
assert(!r.ok, '重复返回确认被拒绝（幂等）')
r = svc.startAcceptance(acc1.id)
assert(r.ok, '待验收 → 发起验收成功')
const v1 = svc.currentVersion()
r = svc.passAcceptance(acc1.id, v1)
assert(r.ok, '验收中 → 确认通过成功')
const closed = repairView(1)
assert(closed.status === '已闭环', '工作台显示已闭环')
r = svc.passAcceptance(acc1.id, svc.currentVersion())
assert(!r.ok, '已封档验收不能再次确认通过（历史结论不被覆盖）')

// --- 2. 退回链路：只生成一条返修，新验收承接，旧结论历史化 -----------------
console.log('\n[2] 退回返修与新一轮验收承接')
// repair 5 的第 1 轮验收（id=2）处于待验收
const acc2 = activeAcceptance(5)
svc.startAcceptance(acc2.id)
r = svc.returnAcceptance(acc2.id, '', svc.currentVersion())
assert(!r.ok && r.message.includes('复修要求'), '退回时复修要求必填')
const stateBefore = svc.loadFlowState()
const reworkCountBefore = stateBefore.reworks.length
r = svc.returnAcceptance(acc2.id, '接口渗漏需重做密封', svc.currentVersion())
assert(r.ok, '验收中 → 退回返修成功')
const stateAfter = svc.loadFlowState()
assert(stateAfter.reworks.length === reworkCountBefore + 1, '恰好新增一条返修事项')
const newRework = stateAfter.reworks.find((item) => item.sourceAcceptId === acc2.id)
assert(!!newRework && newRework.status === '待返修', '返修事项为待返修')
assert(
  stateAfter.acceptances.find((item) => item.id === acc2.id).status === '已退回' &&
    stateAfter.acceptances.find((item) => item.id === acc2.id).sealed,
  '旧验收封档为「已退回」',
)
const rejectView = svc.listAcceptanceViews().items.find((row) => row.id === acc2.id)
assert(rejectView.historical && rejectView.actions.length === 0, '验收列表中旧记录为历史且无操作按钮')
assert(!rejectView.status.includes('需返修') || rejectView.status === '已退回', '列表不再把历史结论显示成需返修')
const workbench5 = repairView(5)
assert(workbench5.status === '需返修' && workbench5.openRework?.id === newRework.id, '工作台同步显示需返修并指向该返修事项')

// 再次退回同一验收必须失败
r = svc.returnAcceptance(acc2.id, '再次退回', svc.currentVersion())
assert(!r.ok, '已退回的历史验收不能重复退回（多人重复退回防护）')
// 同一维修已有未闭环返修时，任何退回尝试都不允许再产生一条
r = svc.startRework(newRework.id)
assert(r.ok, '待返修 → 开始返修成功')
r = svc.startRework(newRework.id)
assert(!r.ok, '重复开工被拒绝')
const v2 = svc.currentVersion()
r = svc.finishRework(newRework.id, v2)
assert(r.ok, '返修中 → 返修完成成功')
const stateRound2 = svc.loadFlowState()
const reworkDone = stateRound2.reworks.find((item) => item.id === newRework.id)
assert(reworkDone.status === '返修完成' && reworkDone.nextAcceptId !== null, '返修闭环并挂接新验收')
const acc3 = activeAcceptance(5)
assert(
  !!acc3 && acc3.round === 2 && acc3.status === '待验收' &&
    acc3.prevAcceptId === acc2.id && acc3.sourceReworkId === newRework.id,
  '第 2 轮验收承接，关联上轮验收与返修事项',
)
r = svc.finishRework(newRework.id, svc.currentVersion())
assert(!r.ok, '返修完成重复提交被拒绝（不会多生成验收）')
// 第二轮验收通过，历史退回结论不受影响
svc.startAcceptance(acc3.id)
r = svc.passAcceptance(acc3.id, svc.currentVersion())
assert(r.ok, '第 2 轮验收确认通过')
const history = svc.loadFlowState().acceptances.filter((item) => item.dispatchId === 5).map((item) => `${item.round}:${item.status}`)
assert(history.includes('1:已退回') && history.includes('2:已通过'), '旧结论保持已退回，新结论为已通过')
const detail = svc.getAcceptanceDetail(acc3.id)
assert(detail.timeline.filter((n) => n.kind === 'acceptance').length === 2
  && detail.timeline.some((n) => n.kind === 'rework'), '验收详情时间轴含两轮验收与返修节点')

// --- 3. 提交中断：退回在封档后中断，续做只补建返修不重复 -------------------
console.log('\n[3] 退回提交中断与断点续做')
// repair 6 的第 1 轮验收（id=3）处于验收中
const acc4 = (() => {
  const s = svc.loadFlowState()
  return s.acceptances.find((item) => item.id === 3)
})()
assert(acc4.status === '验收中', '前置：REPA-0003 为验收中')
svc.armFault('return_accept.after_seal')
r = svc.returnAcceptance(acc4.id, '套环紧固力矩不足', svc.currentVersion())
assert(!r.ok && r.message.includes('模拟中断'), '退回在封档后模拟中断')
svc.clearFault()
let interrupted = svc.listInterrupted()
assert(interrupted.length >= 1 && interrupted.some((t) => t.kind === 'return_accept' && t.refId === acc4.id),
  '列出进行中的退回中断任务')
const sealedView = svc.listAcceptanceViews().items.find((row) => row.id === acc4.id)
assert(sealedView.status === '已退回' && sealedView.historical, '中断时验收已封档（列表与状态不矛盾）')
const rwBeforeResume = svc.loadFlowState().reworks.filter((item) => item.sourceAcceptId === acc4.id).length
assert(rwBeforeResume === 0, '中断时返修事项尚未生成')
// 页面提示处理（再次提交同一验收）应被引导到续做而非报错或新建
r = svc.returnAcceptance(acc4.id, '套环紧固力矩不足', svc.currentVersion())
assert(r.ok, '再次提交自动走断点续做并成功')
const rwAfterResume = svc.loadFlowState().reworks.filter((item) => item.sourceAcceptId === acc4.id)
assert(rwAfterResume.length === 1, '续做后恰好只有一条返修事项（没有多出一条）')
assert(svc.listInterrupted().filter((t) => t.refId === acc4.id).length === 0, '中断任务已核销')
// 再次续做无副作用
r = svc.resumeInterrupted({ kind: 'return_accept', refId: 9999, ledger: {}, 编号: '', 关联维修: '', resumeLabel: '' })
assert(!r.ok, '不存在的中断任务续做被拒绝')

// --- 4. 提交中断：返修完成在核销返修后中断，续做只补建验收 -----------------
console.log('\n[4] 返修完成中断与断点续做')
const rw4 = rwAfterResume[0]
svc.startRework(rw4.id)
svc.armFault('finish_rework.after_rework')
r = svc.finishRework(rw4.id, svc.currentVersion())
assert(!r.ok && r.message.includes('模拟中断'), '返修完成在核销返修后模拟中断')
svc.clearFault()
const mid = svc.loadFlowState()
assert(mid.reworks.find((item) => item.id === rw4.id).status === '返修完成', '中断时返修已核销为完成')
assert(
  mid.acceptances.filter((item) => item.dispatchId === 6 && !item.sealed).length === 0,
  '中断时新一轮验收尚未生成',
)
assert(svc.listInterrupted().some((t) => t.kind === 'finish_rework' && t.refId === rw4.id), '列出返修完成中断任务')
const task = svc.listInterrupted().find((t) => t.kind === 'finish_rework' && t.refId === rw4.id)
r = svc.resumeInterrupted(task)
assert(r.ok, '从返修完成中断环节续做成功')
const after = svc.loadFlowState()
const newAccs = after.acceptances.filter((item) => item.dispatchId === 6 && item.round === 2)
assert(newAccs.length === 1 && newAccs[0].status === '待验收', '续做只补建一条第 2 轮验收')
assert(after.reworks.find((item) => item.id === rw4.id).nextAcceptId === newAccs[0].id, '返修挂接到补建的验收')
assert(svc.listInterrupted().length === 0, '所有中断任务核销完成')
// 续做后再点完成返修，不产生第二条
r = svc.finishRework(rw4.id, svc.currentVersion())
assert(!r.ok, '续做后重复完成返修被拒绝')

// --- 5. 并发：两人同时退回同一验收，只有一人成功 --------------------------
console.log('\n[5] 并发退回 CAS')
// repair 3 维修中 → 返回 → 发起验收，构造一条验收中记录
svc.dispatchRepair(3)
svc.startRepair(3)
svc.returnRepair(3)
const accC = activeAcceptance(3)
svc.startAcceptance(accC.id)
const versionSeen = svc.currentVersion()
const first = svc.returnAcceptance(accC.id, '并发退回-甲', versionSeen)
assert(first.ok, '工作人员甲按看到的版本退回成功')
const second = svc.returnAcceptance(accC.id, '并发退回-乙', versionSeen)
assert(!second.ok, '工作人员乙的重复退回被拒绝（不会生成第二条返修）')
const stateConc = svc.loadFlowState()
assert(
  stateConc.reworks.filter((item) => item.sourceAcceptId === accC.id).length === 1,
  '并发退回后仍只有一条返修事项',
)
// 返修完成同样受 CAS 保护：基于旧版本不能完成
const rwC = stateConc.reworks.find((item) => item.sourceAcceptId === accC.id)
svc.startRework(rwC.id)
const staleVersion = versionSeen
const finStale = svc.finishRework(rwC.id, staleVersion)
assert(!finStale.ok && finStale.message.includes('其他人员'), '基于过期版本完成返修被 CAS 拒绝')
const finFresh = svc.finishRework(rwC.id, svc.currentVersion())
assert(finFresh.ok, '基于最新版本完成返修成功')

// --- 6. 非法流转拦截 -------------------------------------------------------
console.log('\n[6] 非法流转与链路守卫')
const fresh = svc.loadFlowState()
const waiting = fresh.repairs.find((item) => item.status === '待派遣')
if (waiting) {
  assert(!svc.startRepair(waiting.id).ok, '待派遣不能直接出发维修')
}
// seed：repair 7 的返修（id=1）待返修；repair 8 第 2 轮验收（id=6）待验收
const s6 = svc.loadFlowState()
const waitingRework = s6.reworks.find((item) => item.id === 1)
assert(waitingRework.status === '待返修', '前置：seed 返修事项待返修')
assert(!svc.finishRework(1, svc.currentVersion()).ok, '待返修不能直接完成（必须先开工）')
const acc6 = s6.acceptances.find((item) => item.id === 6)
assert(!svc.passAcceptance(6, svc.currentVersion()).ok, '待验收不能直接确认通过（必须先发起）')
assert(repairView(7).status === '需返修', '工作台对 seed 中待返修维修显示需返修')
assert(repairView(8).status === '待验收', '工作台对返修完成后的复验显示待验收')

// 清理
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
