<template>
  <section class="page" data-module="repair_accept">
    <header class="page-head">
      <div>
        <h2>维修验收</h2>
        <p class="page-desc">
          同一维修可经历多轮验收：退回只封存本轮并生成唯一返修事项，返修完成后由新轮次验收承接；旧结论永久保留为历史，不作为现行结论。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出验收清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="interruptBanners.length" class="resume-banner">
      <template v-for="banner in interruptBanners" :key="banner.op.id">
        <p>
          检测到中断的「{{ banner.op.kind === 'complete_rework' ? '完成返修' : banner.op.kind === 'return' ? '退回返修' : '确认通过' }}」处理
          （{{ banner.op.chainId }}，断点：{{ stageLabel(banner.op) }}，处理人：{{ banner.op.holder }}），
          <span v-if="banner.expired" class="warn-text">处理锁已过期，可接管后继续。</span>
        </p>
        <div class="banner-actions">
          <button class="btn primary" type="button" @click="continueOp(banner.op, banner.expired)">从断点继续</button>
        </div>
      </template>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.key" class="legend-item">
        {{ item.label }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>验收编号 / 关联维修</span>
        <input v-model="keyword" placeholder="按编号检索" />
      </label>
      <label class="filter-item">
        <span>范围</span>
        <select v-model="historyFilter">
          <option value="all">全部轮次</option>
          <option value="current">仅当前轮次</option>
          <option value="history">仅历史轮次</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>验收编号</th>
          <th>轮次</th>
          <th>关联维修</th>
          <th>验收人员</th>
          <th>验收日期</th>
          <th>维修质量</th>
          <th>验收结论 / 复修要求</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ historyRow: row.history }">
          <td>{{ row.验收编号 }}</td>
          <td>{{ row.roundLabel }}</td>
          <td>{{ row.关联维修 }}</td>
          <td>{{ row.验收人员 }}</td>
          <td>{{ row.验收日期 }}</td>
          <td>{{ row.维修质量 || '—' }}</td>
          <td class="cell-conclusion">
            {{ row.验收结论 || '—' }}
            <div v-if="row.复修要求" class="muted-text">复修要求：{{ row.复修要求 }}</div>
          </td>
          <td><span :class="['status-tag', statusClass(String(row.status))]">{{ row.status }}</span></td>
          <td class="row-actions">
            <button v-if="row.actionable && row.status === '待验收'" class="link" type="button" @click="begin(row)">开始验收</button>
            <button v-if="row.actionable && row.status === '验收中'" class="link" type="button" @click="openConclusion(row, 'pass')">确认通过</button>
            <button v-if="row.actionable && row.status === '验收中'" class="link danger" type="button" @click="openConclusion(row, 'return')">退回返修</button>
            <span v-if="row.sealed && !row.actionable" class="frozen-text">{{ row.history ? '历史轮次已封存' : '本轮已封存，等待返修' }}</span>
            <button class="link" type="button" @click="openDetail(String(row.chainId))">链路详情</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="9" class="empty-state">没有符合条件的验收记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条验收记录（含历史轮次）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="conclusion" class="drawer-mask" @click.self="conclusion = null">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>{{ conclusion.mode === 'pass' ? '确认通过' : '退回返修' }} · {{ conclusion.row.验收编号 }}</h3>
          <button class="btn ghost" type="button" @click="conclusion = null">取消</button>
        </header>
        <form class="conclusion-form" @submit.prevent="submitConclusionForm">
          <label class="filter-item">
            <span>维修质量</span>
            <input v-model="conclusion.quality" :disabled="conclusion.mode === 'return'" placeholder="如：合格 / 不合格" />
          </label>
          <label class="filter-item">
            <span>验收结论</span>
            <textarea v-model="conclusion.summary" rows="3" placeholder="写明现场核验情况"></textarea>
          </label>
          <label v-if="conclusion.mode === 'return'" class="filter-item">
            <span>复修要求（将生成唯一返修事项）</span>
            <textarea v-model="conclusion.repairRequest" rows="3" placeholder="如：重新注浆并做闭水试验"></textarea>
          </label>
          <label class="fault-line" title="用于演示提交中断：刷新后可从断点继续，且不会多出返修事项或验收记录">
            <input type="checkbox" v-model="conclusion.simulateFault" />
            模拟提交中断（在「{{ faultStageLabel }}」前中断，刷新后从断点继续）
          </label>
          <p v-if="conclusion.mode === 'return'" class="muted-text">
            提交后：本验收轮次封存为「需返修」（历史），生成 1 条待返修事项，维修转入返修中；返修完成后自动开新一轮验收。
          </p>
          <div class="form-actions">
            <button class="btn primary" type="submit">提交</button>
            <button class="btn" type="button" @click="conclusion = null">取消</button>
          </div>
        </form>
      </aside>
    </div>

    <div v-if="detail" class="drawer-mask" @click.self="detail = null">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>链路详情 · {{ detail.chainId }}</h3>
          <button class="btn ghost" type="button" @click="detail = null">关闭</button>
        </header>
        <ul class="timeline">
          <li v-if="detail.dispatch" class="timeline-item">
            <strong>派遣 {{ detail.dispatch.派遣编号 }}</strong>
            <span class="muted-text">{{ detail.dispatch.缺陷来源 }} · {{ detail.dispatch.维修人员 }}</span>
            <span :class="['status-tag', statusClass(String(detail.dispatch.status))]">{{ detail.dispatch.status }}</span>
          </li>
          <li v-for="accept in detail.accepts" :key="`a-${accept.id}`" class="timeline-item">
            <strong>{{ accept.验收编号 }}（第 {{ Number(accept.round ?? 1) }} 轮）</strong>
            <span class="muted-text">{{ accept.验收人员 }} · {{ accept.验收日期 }}</span>
            <span :class="['status-tag', statusClass(String(accept.status))]">{{ accept.status }}</span>
            <p v-if="accept.验收结论" class="timeline-note">结论：{{ accept.验收结论 }}<template v-if="accept.复修要求">；复修要求：{{ accept.复修要求 }}</template></p>
          </li>
          <li v-for="rework in detail.reworks" :key="`r-${rework.id}`" class="timeline-item">
            <strong>{{ rework.返修编号 }}</strong>
            <span class="muted-text">来源 {{ rework.来源验收 }}</span>
            <span :class="['status-tag', rework.status === '待返修' ? 'tag-rework' : 'tag-done']">{{ rework.status }}</span>
            <p class="timeline-note">{{ rework.返修要求 }}</p>
          </li>
        </ul>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  ChainError,
  LockBusyError,
  StageFault,
  acceptStats,
  acceptanceRows,
  beginAcceptance,
  chainTimeline,
  expiredOps,
  pendingOps,
  reclaimChain,
  resumeOp,
  submitPass,
  submitReturn,
} from '@/api/repair-chain'
import { reloadState } from '@/data/local-store'
import type { AcceptanceRow } from '@/api/repair-chain'
import type { PendingOp } from '@/data/types'

const rows = ref<AcceptanceRow[]>([])
const errorMessage = ref('')
const keyword = ref('')
const historyFilter = ref<'all' | 'current' | 'history'>('all')
const detail = ref<ReturnType<typeof chainTimeline> & { chainId: string } | null>(null)

const conclusion = ref<{
  row: AcceptanceRow
  mode: 'pass' | 'return'
  quality: string
  summary: string
  repairRequest: string
  simulateFault: boolean
} | null>(null)

const stats = computed(acceptStats)
const statCards = computed(() => [
  { label: '待验收', value: stats.value.waitingAccept },
  { label: '验收中', value: stats.value.accepting },
  { label: '本轮已通过（闭环）', value: stats.value.closedPassed },
  { label: '返修中链路', value: stats.value.reworkingChains },
])

const statusSummary = computed(() => [
  { key: 'waiting', label: '待验收', count: rows.value.filter((row) => !row.history && row.status === '待验收').length },
  { key: 'accepting', label: '验收中', count: rows.value.filter((row) => !row.history && row.status === '验收中').length },
  { key: 'passed', label: '当前轮已通过', count: rows.value.filter((row) => !row.history && row.status === '已通过').length },
  { key: 'rework', label: '当前轮需返修', count: rows.value.filter((row) => !row.history && row.status === '需返修').length },
  { key: 'history', label: '历史轮次', count: rows.value.filter((row) => row.history).length },
])

const filteredRows = computed(() => {
  const kw = keyword.value.trim()
  return rows.value.filter((row) => {
    if (historyFilter.value === 'current' && row.history) return false
    if (historyFilter.value === 'history' && !row.history) return false
    if (kw && !`${row.验收编号}${row.关联维修}`.includes(kw)) return false
    return true
  })
})

const interruptBanners = computed(() => {
  const expiredIds = new Set(expiredOps().map((op) => op.id))
  return pendingOps().map((op) => ({ op, expired: expiredIds.has(op.id) }))
})

const faultStageLabel = computed(() => {
  if (!conclusion.value) return ''
  return conclusion.value.mode === 'return' ? '封存本轮验收' : '维修闭环'
})

function reload() {
  reloadState()
  rows.value = acceptanceRows()
}

function begin(row: AcceptanceRow) {
  errorMessage.value = ''
  try {
    beginAcceptance(Number(row.id))
    reload()
  } catch (error) {
    reportError(error)
  }
}

function openConclusion(row: AcceptanceRow, mode: 'pass' | 'return') {
  errorMessage.value = ''
  conclusion.value = {
    row,
    mode,
    quality: mode === 'pass' ? '合格' : '不合格',
    summary: '',
    repairRequest: String(row.复修要求 ?? ''),
    simulateFault: false,
  }
}

function submitConclusionForm() {
  if (!conclusion.value) {
    return
  }
  const { row, mode, quality, summary, repairRequest, simulateFault } = conclusion.value
  try {
    const options = simulateFault
      ? { faultBeforeStage: mode === 'return' ? 'freeze_acceptance' : 'close_dispatch' }
      : {}
    if (mode === 'return') {
      submitReturn(Number(row.id), { quality, summary, repairRequest }, '值班管理员', options)
    } else {
      submitPass(Number(row.id), { quality, summary, repairRequest }, '值班管理员', options)
    }
    conclusion.value = null
    reload()
  } catch (error) {
    reportError(error)
    if (!(error instanceof StageFault)) {
      return
    }
    conclusion.value = null
    reload()
  }
}

function stageLabel(op: PendingOp): string {
  const labels: Record<string, string> = {
    create_rework: '生成返修事项',
    freeze_acceptance: '封存本轮验收',
    move_dispatch: '维修转入返修',
    close_acceptance: '写入通过结论',
    close_dispatch: '维修闭环',
    complete_rework: '完成返修事项',
    open_next_round: '开启新一轮验收',
  }
  return labels[op.nextStage] ?? op.nextStage
}

function continueOp(op: PendingOp, expired: boolean) {
  errorMessage.value = ''
  try {
    if (expired) {
      reclaimChain(op.chainId)
      errorMessage.value = '已接管：失效锁与悬挂事务已清理，请重新发起该处理'
      reload()
      return
    }
    resumeOp(op.id)
    reload()
  } catch (error) {
    reportError(error)
  }
}

function openDetail(chainId: string) {
  detail.value = { chainId, ...chainTimeline(chainId) }
}

function statusClass(status: string): string {
  if (status === '已通过' || status === '已闭环' || status === '返修完成') return 'tag-done'
  if (status === '需返修' || status === '返修中') return 'tag-rework'
  if (status === '验收中' || status === '维修中') return 'tag-active'
  return 'tag-idle'
}

function reportError(error: unknown) {
  if (error instanceof StageFault) {
    errorMessage.value = `${error.message}。数据已停在断点，点上方「从断点继续」即可，不会多出记录。`
    reload()
    return
  }
  if (error instanceof LockBusyError) {
    errorMessage.value = error.message
    reload()
    return
  }
  if (error instanceof ChainError) {
    errorMessage.value = error.message
    return
  }
  errorMessage.value = '操作失败，请稍后重试'
}

function exportRows() {
  downloadEntries('repair_accept')
}

onMounted(reload)
</script>

<style scoped>
.cell-conclusion { max-width: 240px; }
.muted-text { color: var(--muted); font-size: 12px; }
.warn-text { color: #b54708; }
.frozen-text { color: var(--muted); font-size: 12px; margin-right: 8px; }
.link.danger { color: #b42318; }
.historyRow { background: #f8fafc; color: var(--muted); }
.resume-banner { background: #fffbeb; border: 1px solid #f5c97b; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.banner-actions { margin-top: 6px; }
.drawer-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; justify-content: flex-end; z-index: 50; }
.drawer { width: 420px; max-width: 90vw; background: #fff; height: 100%; padding: 16px; overflow-y: auto; }
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.timeline { list-style: none; margin: 12px 0 0; padding: 0; }
.timeline-item { border-left: 3px solid var(--border); padding: 8px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
.timeline-note { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.conclusion-form { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.conclusion-form textarea { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit; }
.fault-line { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.form-actions { display: flex; gap: 8px; }
</style>
