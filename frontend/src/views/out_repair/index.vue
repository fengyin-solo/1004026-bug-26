<template>
  <section class="page" data-module="out_repair">
    <header class="page-head">
      <div>
        <h2>外出维修工作台</h2>
        <p class="page-desc">派遣 → 出发 → 返回（自动生成验收）；验收退回后在此承接唯一返修事项，返修完成自动转入新一轮验收。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出台账</button>
        <button v-if="isDev" class="btn ghost danger" type="button" @click="resetFlow">重置链路演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="interrupted.length" class="resume-banner">
      <span>
        检测到 {{ interrupted.length }} 笔提交在中途中断（如页面关闭、网络断开）。
        数据已停在中断环节，点击续做不会重复生成记录。
      </span>
      <div class="resume-actions">
        <button
          v-for="task in interrupted"
          :key="task.ledger.opId"
          class="btn small"
          type="button"
          @click="resume(task)"
        >
          续做：{{ task.编号 }}（{{ task.resumeLabel }}）
        </button>
      </div>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前环节</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.派遣编号 }}</td>
          <td>{{ row.缺陷来源 }}</td>
          <td>{{ row.维修人员 }}</td>
          <td>{{ row.预计工时 }}</td>
          <td>{{ row.携带工具 }}</td>
          <td>{{ row.出发时间 || '—' }}</td>
          <td>{{ row.返回时间 || '—' }}</td>
          <td>
            <span class="status-badge" :class="statusClass(row.status)">{{ row.status }}</span>
            <div v-if="row.statusNote" class="cell-note">{{ row.statusNote }}</div>
          </td>
          <td class="row-actions">
            <button
              v-for="action in row.actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button
              v-if="row.status === '待验收' || row.status === '验收中'"
              class="link"
              type="button"
              @click="goAccept"
            >
              去验收
            </button>
            <span v-if="!row.actions.length && row.status !== '待验收' && row.status !== '验收中'" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无外出维修数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条外出维修记录；「需返修」严格对应一条未闭环返修事项</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 开发联调：模拟提交中断，验证断点续做 -->
    <div v-if="isDev" class="fault-bar">
      <span class="fault-title">故障注入（仅开发环境）</span>
      <button class="btn small" type="button" @click="armAndReturn">模拟「退回返修」在封档后中断</button>
      <button class="btn small" type="button" @click="armAndFinish">模拟「返修完成」在核销返修后中断</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { downloadEntries } from '@/api/local-service'
import {
  armFault,
  clearFault,
  dispatchRepair,
  finishRework,
  flowStats,
  listInterrupted,
  listRepairViews,
  resetRepairFlow,
  resumeInterrupted,
  returnRepair,
  startRepair,
  startRework,
  type InterruptedTask,
  type RepairViewRow,
} from '@/api/repair-flow-service'

const isDev = import.meta.env.DEV
const router = useRouter()

const columns = ['派遣编号', '缺陷来源', '维修人员', '预计工时', '携带工具', '出发时间', '返回时间']
const filterFields = ['派遣编号', '缺陷来源', '维修人员']

const rows = ref<RepairViewRow[]>([])
const total = ref(0)
const stats = ref(flowStats().repair)
const interrupted = ref<InterruptedTask[]>([])
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})

function statusClass(status: string): string {
  if (status === '需返修') return 'badge-danger'
  if (status === '待验收' || status === '验收中') return 'badge-warn'
  if (status === '已闭环') return 'badge-done'
  if (status === '待派遣') return 'badge-muted'
  return 'badge-info'
}

function flash(result: { ok: boolean; message: string }) {
  if (result.ok) {
    okMessage.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    okMessage.value = ''
  }
}

function runAction(action: string, row: RepairViewRow) {
  let result: { ok: boolean; message: string }
  if (action === '下达派遣') {
    result = dispatchRepair(row.id)
  } else if (action === '出发维修') {
    result = startRepair(row.id)
  } else if (action === '返回确认') {
    result = returnRepair(row.id)
  } else if (action === '开始返修') {
    result = row.openRework ? startRework(row.openRework.id) : { ok: false, message: '未找到返修事项' }
  } else if (action === '返修完成') {
    result = row.openRework
      ? finishRework(row.openRework.id, row.viewVersion)
      : { ok: false, message: '未找到返修事项' }
  } else {
    result = { ok: false, message: `未知动作：${action}` }
  }
  flash(result)
  reload()
}

function resume(task: InterruptedTask) {
  flash(resumeInterrupted(task))
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('out_repair')
}

function goAccept() {
  void router.push('/repair_accept')
}

function resetFlow() {
  resetRepairFlow()
  clearFault()
  flash({ ok: true, message: '链路数据已重置为演示数据' })
  reload()
}

// 故障注入：先给下一次操作武装故障点，再自动走到对应环节，提示工作人员去验收页/点完成。
function armAndReturn() {
  armFault('return_accept.after_seal')
  flash({ ok: true, message: '故障已武装：请到维修验收页对一条「验收中」记录执行退回返修，将在封档后中断' })
}

function armAndFinish() {
  armFault('finish_rework.after_rework')
  flash({ ok: true, message: '故障已武装：请对一条「返修中」事项执行返修完成，将在核销返修后中断' })
}

function reload() {
  const payload = listRepairViews(filters.value)
  rows.value = payload.items
  total.value = payload.total
  stats.value = flowStats().repair
  interrupted.value = listInterrupted()
}

onMounted(reload)
</script>

<style scoped>
.cell-note {
  font-size: 12px;
  color: var(--muted, #667085);
  margin-top: 2px;
  max-width: 260px;
}
.muted-text {
  color: #98a2b3;
  font-size: 13px;
}
.status-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.badge-danger {
  background: #fef3f2;
  color: #b42318;
}
.badge-warn {
  background: #fffaeb;
  color: #b54708;
}
.badge-done {
  background: #ecfdf3;
  color: #027a48;
}
.badge-muted {
  background: #f2f4f7;
  color: #667085;
}
.badge-info {
  background: #eff8ff;
  color: #175cd3;
}
.ok-text {
  color: #027a48;
}
.resume-banner {
  background: #fffaeb;
  border: 1px solid #fedf89;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 13px;
  color: #b54708;
}
.resume-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.btn.small {
  padding: 3px 10px;
  font-size: 12px;
}
.btn.danger {
  color: #b42318;
}
.fault-bar {
  margin-top: 12px;
  padding: 8px 12px;
  border: 1px dashed #fda29b;
  border-radius: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  background: #fffbfa;
}
.fault-title {
  font-size: 12px;
  color: #b42318;
  font-weight: 600;
}
</style>
