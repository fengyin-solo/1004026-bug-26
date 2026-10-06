<template>
  <section class="page" data-module="repair_accept">
    <header class="page-head">
      <div>
        <h2>维修验收管理</h2>
        <p class="page-desc">
          验收结论封档后即为历史记录不可修改；退回返修只生成一条返修事项，返修完成后由新一轮验收承接。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出验收清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" :class="{ 'history-row': row.historical }">
          <td>{{ row.验收编号 }}</td>
          <td>{{ row.关联维修 }}</td>
          <td>第{{ row.round }}轮</td>
          <td>{{ row.验收人员 }}</td>
          <td>{{ row.验收日期 || '—' }}</td>
          <td>{{ row.维修质量 || '—' }}</td>
          <td>{{ row.验收结论 }}</td>
          <td class="rework-cell">{{ row.复修要求 || '—' }}</td>
          <td>
            <span class="status-badge" :class="statusClass(row.status)">{{ row.status }}</span>
            <span v-if="row.historical" class="history-tag">历史</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in row.actions"
              :key="action"
              class="link"
              :class="{ danger: action === '退回返修' }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link subtle" type="button" @click="openDetail(row.id)">验收详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无维修验收数据，维修返回后会自动生成</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条验收记录（含各轮次历史结论）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>

    <!-- 退回返修弹窗：复修要求必填 -->
    <div v-if="rejectTarget" class="modal-mask" @click.self="closeReject">
      <div class="modal">
        <h3>退回返修 · {{ rejectTarget.验收编号 }}（{{ rejectTarget.关联维修 }} 第{{ rejectTarget.round }}轮）</h3>
        <p class="modal-tip">确认退回后，本条验收结论封档为历史记录，并生成<b>一条</b>返修事项流转到外出维修工作台。</p>
        <label class="modal-field">
          <span>复修要求 <em>*</em></span>
          <textarea
            v-model="rejectReason"
            rows="4"
            placeholder="请明确返修部位、处理要求与复验标准"
          ></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeReject">取消</button>
          <button class="btn primary danger-bg" type="button" @click="confirmReject">确认退回</button>
        </div>
      </div>
    </div>

    <!-- 验收详情：完整链路时间轴 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal modal-wide">
        <h3>验收详情 · {{ detail.acceptance.验收编号 }}</h3>
        <dl class="detail-grid">
          <div><dt>关联维修</dt><dd>{{ detail.acceptance.关联维修 }}</dd></div>
          <div><dt>验收轮次</dt><dd>第{{ detail.acceptance.round }}轮</dd></div>
          <div><dt>验收人员</dt><dd>{{ detail.acceptance.验收人员 }}</dd></div>
          <div><dt>验收日期</dt><dd>{{ detail.acceptance.验收日期 || '—' }}</dd></div>
          <div><dt>验收结论</dt><dd>
            <span class="status-badge" :class="statusClass(detail.acceptance.status)">{{ detail.acceptance.status }}</span>
          </dd></div>
          <div><dt>是否历史结论</dt><dd>{{ detail.acceptance.sealed ? '是（已封档，不可变更）' : '否（当前进行中）' }}</dd></div>
        </dl>
        <div v-if="detail.acceptance.复修要求" class="detail-block">
          <h4>复修要求</h4>
          <p>{{ detail.acceptance.复修要求 }}</p>
        </div>

        <h4 class="timeline-title">链路时间轴</h4>
        <ol class="timeline">
          <li v-for="(node, index) in detail.timeline" :key="index" class="timeline-item">
            <template v-if="node.kind === 'acceptance'">
              <span class="timeline-dot" :class="statusClass(node.item.status)"></span>
              <div>
                <strong>第{{ node.item.round }}轮验收 · {{ node.item.验收编号 }}</strong>
                <p>{{ node.item.status }}<template v-if="node.item.concludedAt"> · 结论日期 {{ node.item.验收日期 }}</template></p>
                <p v-if="node.item.status === '已退回'" class="timeline-rework">退回原因：{{ node.item.复修要求 }}</p>
              </div>
            </template>
            <template v-else>
              <span class="timeline-dot badge-danger"></span>
              <div>
                <strong>返修事项 · {{ node.item.返修编号 }}</strong>
                <p>{{ node.item.status }} · 返修人 {{ node.item.返修人员 }}</p>
                <p class="timeline-rework">返修要求：{{ node.item.返修要求 }}</p>
              </div>
            </template>
          </li>
        </ol>

        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  flowStats,
  getAcceptanceDetail,
  listAcceptanceViews,
  passAcceptance,
  returnAcceptance,
  startAcceptance,
  type AcceptanceDetail,
  type AcceptanceViewRow,
} from '@/api/repair-flow-service'

const columns = ['验收编号', '关联维修', '轮次', '验收人员', '验收日期', '维修质量', '验收结论', '复修要求']
const filterFields = ['验收编号', '关联维修', '验收人员']

const rows = ref<AcceptanceViewRow[]>([])
const total = ref(0)
const stats = ref(flowStats().acceptance)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})

const rejectTarget = ref<AcceptanceViewRow | null>(null)
const rejectReason = ref('')
const detail = ref<AcceptanceDetail | null>(null)

function statusClass(status: string): string {
  if (status === '已退回') return 'badge-danger'
  if (status === '待验收' || status === '验收中') return 'badge-warn'
  if (status === '已通过') return 'badge-done'
  return 'badge-muted'
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

function runAction(action: string, row: AcceptanceViewRow) {
  if (action === '发起验收') {
    flash(startAcceptance(row.id))
    reload()
    return
  }
  if (action === '确认通过') {
    // 带页面加载时看到的版本号提交：若期间被他人处理过，CAS 拒绝并提示刷新。
    flash(passAcceptance(row.id, row.viewVersion))
    reload()
    return
  }
  if (action === '退回返修') {
    rejectTarget.value = row
    rejectReason.value = ''
  }
}

function confirmReject() {
  if (!rejectTarget.value) {
    return
  }
  const target = rejectTarget.value
  flash(returnAcceptance(target.id, rejectReason.value, target.viewVersion))
  closeReject()
  reload()
}

function closeReject() {
  rejectTarget.value = null
  rejectReason.value = ''
}

function openDetail(id: number) {
  detail.value = getAcceptanceDetail(id)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('repair_accept')
}

function reload() {
  const payload = listAcceptanceViews(filters.value)
  rows.value = payload.items
  total.value = payload.total
  stats.value = flowStats().acceptance
  if (detail.value) {
    detail.value = getAcceptanceDetail(detail.value.acceptance.id)
  }
}

onMounted(reload)
</script>

<style scoped>
.history-row {
  background: #fafbfc;
  color: #667085;
}
.history-tag {
  margin-left: 6px;
  font-size: 11px;
  background: #e4e7ec;
  color: #475467;
  border-radius: 4px;
  padding: 0 6px;
}
.rework-cell {
  max-width: 260px;
  font-size: 12px;
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
.link.danger {
  color: #b42318;
}
.link.subtle {
  color: #667085;
}
.ok-text {
  color: #027a48;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 20px 24px;
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  overflow: auto;
}
.modal-wide {
  width: 680px;
}
.modal h3 {
  margin: 0 0 8px;
  font-size: 16px;
}
.modal-tip {
  font-size: 13px;
  color: #667085;
  margin: 0 0 12px;
}
.modal-field {
  display: block;
  margin-bottom: 12px;
}
.modal-field span {
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}
.modal-field em {
  color: #b42318;
  font-style: normal;
}
.modal-field textarea {
  width: 100%;
  border: 1px solid #d0d5dd;
  border-radius: 6px;
  padding: 8px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  box-sizing: border-box;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.danger-bg {
  background: #d92d20;
  border-color: #d92d20;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 20px;
  margin: 0 0 12px;
}
.detail-grid dt {
  font-size: 12px;
  color: #98a2b3;
}
.detail-grid dd {
  margin: 2px 0 0;
  font-size: 13px;
}
.detail-block {
  background: #fef3f2;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.detail-block h4 {
  margin: 0 0 4px;
  font-size: 13px;
  color: #b42318;
}
.detail-block p {
  margin: 0;
  font-size: 13px;
}
.timeline-title {
  margin: 12px 0 8px;
  font-size: 14px;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 8px;
}
.timeline-item {
  display: flex;
  gap: 10px;
  padding: 6px 0;
  border-left: 2px solid #eaecf0;
  padding-left: 12px;
  position: relative;
}
.timeline-item:first-child {
  border-left-color: transparent;
}
.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 5px;
  flex: none;
  background: #d0d5dd;
}
.timeline-item strong {
  font-size: 13px;
}
.timeline-item p {
  margin: 2px 0 0;
  font-size: 12px;
  color: #667085;
}
.timeline-rework {
  color: #b42318 !important;
}
</style>
