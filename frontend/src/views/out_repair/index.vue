<template>
  <section class="page" data-module="out_repair">
    <header class="page-head">
      <div>
        <h2>外出维修工作台</h2>
        <p class="page-desc">
          派遣 → 返回 → 验收；验收退回后只生成一条返修事项，返修完成自动由新一轮验收承接，旧验收结论封存为历史。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出维修清单</button>
        <button class="btn ghost" type="button" @click="resetChainData">重置演示链路</button>
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
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <h3 class="section-title">维修派遣</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>派遣编号</th>
          <th>缺陷来源</th>
          <th>维修人员</th>
          <th>预计工时</th>
          <th>出发/返回时间</th>
          <th>链路状态</th>
          <th>当前验收</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.dispatch.id)">
          <td>{{ row.dispatch.派遣编号 }}</td>
          <td>{{ row.dispatch.缺陷来源 }}</td>
          <td>{{ row.dispatch.维修人员 }}</td>
          <td>{{ row.dispatch.预计工时 }}</td>
          <td class="cell-narrow">{{ row.dispatch.出发时间 }}<br /><span class="muted-text">{{ row.dispatch.返回时间 || '未返回' }}</span></td>
          <td><span :class="['status-tag', statusClass(row.currentStatus)]">{{ row.currentStatus }}</span></td>
          <td>
            <template v-if="row.latest">
              {{ row.latest.验收编号 }} · {{ row.latest.status }}
              <span class="muted-text">（第 {{ Number(row.latest.round ?? 1) }} 轮 / 共 {{ row.totalRounds }} 轮）</span>
            </template>
            <span v-else class="muted-text">尚未发起验收</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action.key"
              class="link"
              type="button"
              @click="handleAction(action.key, row)"
            >
              {{ action.label }}
            </button>
            <button class="link" type="button" @click="openDetail(String(row.dispatch.chainId ?? row.dispatch.派遣编号))">
              链路详情
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="8" class="empty-state">暂无外出维修数据</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">返修事项（退回时每链仅一条可执行）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>返修编号</th>
          <th>关联维修</th>
          <th>来源验收</th>
          <th>返修要求</th>
          <th>维修人员</th>
          <th>登记时间</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="rework in reworkRows" :key="String(rework.id)">
          <td>{{ rework.返修编号 }}</td>
          <td>{{ rework.关联维修 }}</td>
          <td>{{ rework.来源验收 }}</td>
          <td>{{ rework.返修要求 }}</td>
          <td>{{ rework.维修人员 }}</td>
          <td class="cell-narrow">{{ rework.登记时间 }}</td>
          <td>
            <span :class="['status-tag', rework.status === '待返修' ? 'tag-rework' : 'tag-done']">{{ rework.status }}</span>
          </td>
          <td class="row-actions">
            <button v-if="rework.status === '待返修'" class="link" type="button" @click="finishRework(rework)">
              完成返修并开新验收
            </button>
            <button class="link" type="button" @click="openDetail(String(rework.chainId))">链路详情</button>
          </td>
        </tr>
        <tr v-if="!reworkRows.length">
          <td :colspan="8" class="empty-state">当前没有返修事项</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条维修派遣 · {{ openReworkCount }} 条待返修</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

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
  chainTimeline,
  completeRework,
  dispatchAction,
  expiredOps,
  pendingOps,
  reclaimChain,
  resetChain,
  resumeOp,
  reworkRows as listReworkRows,
  startAcceptance,
  workbenchRows,
  workbenchStats,
} from '@/api/repair-chain'
import { reloadState } from '@/data/local-store'
import type { EntryRow, PendingOp } from '@/data/types'

const rows = ref<ReturnType<typeof workbenchRows>>([])
const reworkRows = ref<EntryRow[]>([])
const errorMessage = ref('')
const detail = ref<ReturnType<typeof chainTimeline> & { chainId: string } | null>(null)

const stats = computed(workbenchStats)
const statCards = computed(() => [
  { label: '待派遣/已派遣', value: stats.value.waitingDispatch },
  { label: '维修中', value: stats.value.repairing },
  { label: '已返回待验收', value: stats.value.returnedWaitingAccept },
  { label: '返修中', value: stats.value.reworking },
  { label: '返修完成待复验', value: stats.value.reworkDoneWaitingAccept },
  { label: '已闭环', value: stats.value.closed },
])
const openReworkCount = computed(() => stats.value.openRework)

const statusSummary = computed(() =>
  ['待派遣', '已派遣', '维修中', '已返回', '返修中', '返修完成', '已闭环'].map((status) => ({
    status,
    count: rows.value.filter((row) => row.currentStatus === status).length,
  })),
)

const interruptBanners = computed(() => {
  const expiredIds = new Set(expiredOps().map((op) => op.id))
  return pendingOps().map((op) => ({ op, expired: expiredIds.has(op.id) }))
})

type ActionKey = 'dispatch' | 'depart' | 'return' | 'startAccept'
type RowModel = ReturnType<typeof workbenchRows>[number]

function actionsFor(row: RowModel): { key: ActionKey; label: string }[] {
  const list: { key: ActionKey; label: string }[] = []
  switch (row.currentStatus) {
    case '待派遣':
      list.push({ key: 'dispatch', label: '下达派遣' })
      break
    case '已派遣':
      list.push({ key: 'depart', label: '出发维修' })
      break
    case '维修中':
      list.push({ key: 'return', label: '返回确认' })
      break
    case '已返回':
      if (!row.latest) {
        list.push({ key: 'startAccept', label: '发起验收' })
      }
      break
    case '返修中':
      // 返修动作集中在下方返修事项表里，一条链只有一个按钮，避免重复造事。
      break
    default:
      break
  }
  return list
}

function reload() {
  reloadState()
  rows.value = workbenchRows()
  reworkRows.value = listReworkRows()
}

function handleAction(key: ActionKey, row: RowModel) {
  errorMessage.value = ''
  try {
    const id = Number(row.dispatch.id)
    if (key === 'dispatch') dispatchAction(id, '下达派遣')
    if (key === 'depart') dispatchAction(id, '出发维修')
    if (key === 'return') dispatchAction(id, '返回确认')
    if (key === 'startAccept') startAcceptance(id, '验收科 值班验收员')
    reload()
  } catch (error) {
    reportError(error)
  }
}

function finishRework(rework: EntryRow) {
  errorMessage.value = ''
  const dispatch = rows.value.find((row) => String(row.dispatch.chainId) === String(rework.chainId))?.dispatch
  if (!dispatch) {
    errorMessage.value = '找不到返修事项对应的维修派遣'
    return
  }
  try {
    completeRework(Number(dispatch.id))
    reload()
  } catch (error) {
    reportError(error)
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

async function continueOp(op: PendingOp, expired: boolean) {
  errorMessage.value = ''
  try {
    if (expired) {
      reclaimChain(op.chainId)
      errorMessage.value = '已接管，请重新发起该处理（历史中断的半截数据已清理到最近断点）'
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
  downloadEntries('out_repair')
}

function resetChainData() {
  resetChain()
  reload()
}

onMounted(() => {
  reload()
})
</script>

<style scoped>
.section-title { font-size: 15px; margin: 18px 0 8px; }
.cell-narrow { font-size: 12px; line-height: 1.5; }
.muted-text { color: var(--muted); font-size: 12px; }
.warn-text { color: #b54708; }
.resume-banner { background: #fffbeb; border: 1px solid #f5c97b; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.banner-actions { margin-top: 6px; }
.drawer-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; justify-content: flex-end; z-index: 50; }
.drawer { width: 420px; max-width: 90vw; background: #fff; height: 100%; padding: 16px; overflow-y: auto; }
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.timeline { list-style: none; margin: 12px 0 0; padding: 0; }
.timeline-item { border-left: 3px solid var(--border); padding: 8px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
.timeline-note { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
</style>
