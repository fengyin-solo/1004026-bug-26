// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OutRepairView from '@/views/out_repair/index.vue'
import RepairAcceptView from '@/views/repair_accept/index.vue'

const RouterLinkStub = defineComponent({
  props: ['to'],
  setup(props, { slots }) {
    return () => h('a', { 'data-to': String(props.to) }, slots.default?.())
  },
})

function mount(component: ReturnType<typeof defineComponent>): HTMLElement {
  const app = createApp(component)
  app.component('RouterLink', RouterLinkStub)
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  return root
}

beforeEach(() => {
  // jsdom 自带 window/localStorage；local-store 直接读写真实的 localStorage。
  window.localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('两个工作台页面渲染冒烟', () => {
  it('外出维修工作台：渲染派遣、唯一返修事项与链路状态', async () => {
    const root = mount(OutRepairView as never)
    await nextTick()
    const text = root.textContent ?? ''
    expect(text).toContain('外出维修工作台')
    expect(text).toContain('OUT_-0003')
    expect(text).toContain('返修事项')
    expect(text).toContain('REWK-0001')
    expect(text).toContain('返修中')
    // 种子里 OUT_-0003 只有一条待返修事项，页面不能渲染出两个「完成返修」入口
    const finishButtons = [...root.querySelectorAll('button')].filter(
      (btn) => btn.textContent?.includes('完成返修并开新验收'),
    )
    expect(finishButtons).toHaveLength(1)
  })

  it('维修验收页：当前轮次可操作，历史轮次显示封存', async () => {
    const root = mount(RepairAcceptView as never)
    await nextTick()
    const text = root.textContent ?? ''
    expect(text).toContain('维修验收')
    // 经历两轮的链：历史第 1 轮与当前第 2 轮都在
    expect(text).toContain('REPA-0005-01')
    expect(text).toContain('REPA-0005-02')
    expect(text).toContain('历史')
  })

  it('端到端点击：退回返修后刷新视图，旧轮封存且只出现一条返修事项', async () => {
    // 种子里 REPA-0002-01 是「验收中」（OUT_-0002 链）
    const acceptRoot = mount(RepairAcceptView as never)
    await nextTick()
    const returnButton = [...acceptRoot.querySelectorAll('button')].find((btn) =>
      btn.textContent?.includes('退回返修'),
    ) as HTMLButtonElement
    expect(returnButton).toBeTruthy()
    returnButton.click()
    await nextTick()
    // 抽屉出现：填复修要求并提交
    const textareas = acceptRoot.querySelectorAll('textarea')
    expect(textareas.length).toBeGreaterThan(0)
    const requestBox = textareas[textareas.length - 1] as HTMLTextAreaElement
    requestBox.value = '重做密封并复检'
    requestBox.dispatchEvent(new Event('input'))
    await nextTick()
    const submit = [...acceptRoot.querySelectorAll('button')].find(
      (btn) => btn.textContent?.trim() === '提交',
    ) as HTMLButtonElement
    submit.click()
    await nextTick()

    // 该链验收已封存
    const text = acceptRoot.textContent ?? ''
    expect(text).toContain('已封存，等待返修')

    // 外出工作台：OUT_-0002 转返修中，返修事项表新增且只有它一条待办
    const repairRoot = mount(OutRepairView as never)
    await nextTick()
    const repairText = repairRoot.textContent ?? ''
    expect(repairText).toContain('OUT_-0002')
    const finishButtons = [...repairRoot.querySelectorAll('button')].filter(
      (btn) => btn.textContent?.includes('完成返修并开新验收'),
    )
    // 种子原有 REWK-0001(OUT_-0003) 一条待办 + 本次退回新增一条 = 2
    expect(finishButtons).toHaveLength(2)
  })
})
