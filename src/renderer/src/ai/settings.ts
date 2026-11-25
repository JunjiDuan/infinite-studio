import { AI_PROVIDERS, aiProvider, type AiProviderId, type AiProviderMeta, type AiProviderStatus } from '../../../shared/ai'
import { h, toast } from '../dom'
import { t } from '../i18n'
import { state } from '../store'
import { aiSettings, onAiChange, providerStatus, setProviderEndpoint, setProviderKey, updateAiSettings, type AiFeature } from './client'
import { completionStats, onCompletionStats, resetCompletionStats } from './inline'
import { projectRules } from './context'

/**
 * 设置页“智慧能力”：各功能用哪个服务 / 模型、上下文来源、终端 / 自适应等开关、使用统计、各服务的 API Key 和接口地址。
 */

function providerSelect(value: AiProviderId, onChange: (id: AiProviderId) => void): HTMLSelectElement {
  const sel = h('select', { class: 'ai-select', onChange: () => onChange(sel.value as AiProviderId) }, ...AI_PROVIDERS.map((p) => h('option', { value: p.id }, t(p.name))))
  sel.value = value
  return sel
}

let listSeq = 0
function modelInput(provider: AiProviderMeta, value: string | undefined, fallback: string, onChange: (m: string | undefined) => void): HTMLElement {
  const listId = `ai-models-${++listSeq}`
  const input = h('input', {
    class: 'text-input ai-model-input',
    value: value ?? '',
    placeholder: fallback || t('模型名称'),
    spellcheck: 'false',
    list: listId,
    'aria-label': t('模型'),
    onChange: () => onChange(input.value.trim() || undefined)
  })
  return h('span', { class: 'ai-model' }, input, h('datalist', { id: listId }, ...provider.models.map((m) => h('option', { value: m }))))
}

function checkbox(id: string, checked: boolean, onChange: (on: boolean) => void): HTMLInputElement {
  const el = h('input', { type: 'checkbox', id, checked, onChange: () => onChange(el.checked) })
  return el
}

/** 一个功能：标题行（可选开关）+ 服务 / 模型选择 */
function featureRow(kind: AiFeature, title: string, hint: string, toggle?: { id: string; on: boolean; set: (on: boolean) => void }): HTMLElement {
  const f = aiSettings()[kind]
  const meta = aiProvider(f.provider)!
  const fallback = kind === 'edit' ? meta.defaultModel : meta.completionModel
  const head = toggle
    ? h('label', { class: 'check-row', for: toggle.id }, checkbox(toggle.id, toggle.on, toggle.set), h('span', {}, title), h('span', { class: 'muted' }, hint))
    : h('div', { class: 'check-row' }, h('span', {}, title), h('span', { class: 'muted' }, hint))
  return h(
    'div',
    { class: 'ai-feature' },
    head,
    h(
      'div',
      { class: 'ai-feature-pick' },
      providerSelect(f.provider, (id) => updateAiSettings((x) => ((x[kind].provider = id), (x[kind].model = undefined)))),
      modelInput(meta, f.model, fallback, (m) => updateAiSettings((x) => (x[kind].model = m)))
    )
  )
}

function featureRows(): HTMLElement {
  const s = aiSettings()
  return h(
    'div',
    { class: 'ai-features' },
    featureRow('completion', t('行内补全'), t('灰色提示，Tab 接受'), { id: 'ai-completion-on', on: s.completion.enabled, set: (on) => updateAiSettings((x) => (x.completion.enabled = on)) }),
    featureRow('edit', t('内联编辑、AI 修复与问答'), t('Ctrl I · Alt Enter · 终端 / 调试 / 代码审查')),
    featureRow('nextEdit', t('下一处编辑预测'), t('改完一处后预测下一处，Tab 跳转 / 接受'), { id: 'ai-nes-on', on: s.nextEdit.enabled, set: (on) => updateAiSettings((x) => (x.nextEdit.enabled = on)) })
  )
}

function sourceLabel(st: AiProviderStatus | undefined, meta: AiProviderMeta): string {
  if (!st?.masked) return meta.keyOptional ? t('无需 Key（本地服务）') : t('未配置')
  if (st.source === 'env') return t('{0} · 来自环境变量', st.masked)
  if (st.source === 'dsh') return t('{0} · 复用 DeepSeek Harness 的 Key', st.masked)
  return t('{0} · 已保存（系统密钥加密）', st.masked)
}

function providerCard(meta: AiProviderMeta, st: AiProviderStatus | undefined, refresh: () => void): HTMLElement {
  const keyInput = h('input', {
    class: 'text-input',
    type: 'password',
    placeholder: st?.source === 'stored' ? t('输入新的 Key 以替换') : t('粘贴 API Key'),
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': t('{0} API Key', t(meta.name))
  })
  const result = h('span', { class: 'ai-test-result muted' })
  const busy = (fn: () => Promise<void>) => async (e: MouseEvent) => {
    const btn = e.currentTarget as HTMLButtonElement
    btn.disabled = true
    try {
      await fn()
    } catch (e) {
      toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      btn.disabled = false
    }
  }
  const save = h('button', {
    class: 'btn small',
    onClick: busy(
      async () => {
        const v = keyInput.value.trim()
        if (!v) return keyInput.focus()
        await setProviderKey(meta.id, v)
        keyInput.value = ''
        toast(t('已保存 {0} 的 API Key', t(meta.name)))
        refresh()
      }
    )
  }, t('保存'))
  const clear = h('button', {
    class: 'btn small',
    hidden: st?.source !== 'stored',
    onClick: () =>
      void setProviderKey(meta.id, null).then(() => {
        toast(t('已删除 {0} 的 API Key', t(meta.name)))
        refresh()
      })
  }, t('删除'))
  const test = h('button', {
    class: 'btn small',
    onClick: busy(
      async () => {
        result.textContent = t('测试中…')
        result.dataset.kind = ''
        const f = aiSettings()
        const model = f.edit.provider === meta.id ? f.edit.model : f.completion.provider === meta.id ? f.completion.model : undefined
        const r = await window.api.ai.test(meta.id, model)
        result.textContent = r.ok ? t('连接正常') : r.error
        result.dataset.kind = r.ok ? 'ok' : 'error'
      }
    )
  }, t('测试'))

  const rows: (HTMLElement | null)[] = [
    h('div', { class: 'ai-key-row' }, keyInput, save, clear, test),
    result
  ]
  if (meta.baseUrl) {
    const url = h('input', {
      class: 'text-input',
      value: st?.baseUrl ?? '',
      placeholder: meta.baseUrl,
      spellcheck: 'false',
      'aria-label': t('接口地址'),
      onChange: () =>
        void setProviderEndpoint(meta.id, url.value.trim() || null)
          .then(() => toast(t('已更新接口地址')))
          .catch((e) => toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
    })
    rows.push(h('div', { class: 'ai-url-row' }, h('span', { class: 'muted' }, t('接口地址')), url))
  }
  if (meta.id === 'openai') {
    const fim = h('input', {
      type: 'checkbox',
      id: 'ai-openai-fim',
      checked: !!st?.fim,
      onChange: () => void setProviderEndpoint(meta.id, st?.baseUrl ?? null, fim.checked)
    })
    rows.push(
      h(
        'label',
        { class: 'check-row', for: 'ai-openai-fim' },
        fim,
        h('span', {}, t('行内补全使用 FIM 接口（/completions + suffix）')),
        h('span', { class: 'muted' }, t('Ollama、vLLM 等的代码模型通常支持'))
      )
    )
  }
  return h(
    'details',
    { class: 'ai-provider' },
    h(
      'summary',
      {},
      h('span', { class: 'ai-provider-name' }, t(meta.name)),
      h('span', { class: 'ai-provider-state', 'data-on': String(!!st?.configured) }, sourceLabel(st, meta)),
      h('span', { class: 'grow' }),
      meta.keyUrl ? h('a', { class: 'link-btn', href: meta.keyUrl, target: '_blank', rel: 'noreferrer', onClick: (e: MouseEvent) => e.stopPropagation() }, t('获取 Key')) : null
    ),
    h('div', { class: 'ai-provider-body' }, ...rows)
  )
}

/* ---------------- 上下文 ---------------- */

function contextRows(onOpenFile: (path: string) => void): HTMLElement {
  const c = aiSettings().context
  const set = (k: keyof typeof c) => (on: boolean) => updateAiSettings((x) => (x.context[k] = on))
  const indexInfo = h('span', { class: 'muted ai-ctx-info' })
  const rulesInfo = h('span', { class: 'muted ai-ctx-info' })
  const rebuild = h('button', {
    class: 'btn small',
    onClick: async () => {
      if (!state.root) return toast(t('请先打开文件夹'))
      await window.api.ai.indexRebuild(state.root)
      toast(t('正在重新建立项目索引'))
      setTimeout(refreshIndex, 600)
    }
  }, t('重建索引'))
  const newRules = h('button', {
    class: 'btn small',
    onClick: async () => {
      const root = state.root
      if (!root) return toast(t('请先打开文件夹'))
      const sep = root.includes('\\') ? '\\' : '/'
      const dir = root.replace(/[\\/]+$/, '') + sep + '.infinite'
      const file = dir + sep + 'rules.md'
      const exists = await window.api.fs.readFile(file).catch(() => null)
      if (!exists?.ok) {
        await window.api.fs.createDir(root, '.infinite').catch(() => undefined)
        await window.api.fs.writeFile(file, t('# 项目规则\n\n写给 AI 的项目约定，行内补全、内联编辑、终端修复等功能都会遵守。例如：\n\n- 技术栈：TypeScript + Electron，不引入新依赖\n- 代码风格：两个空格缩进，不写分号\n- 注释用中文\n'))
      }
      onOpenFile(file)
    }
  }, t('编辑规则文件'))
  const refreshIndex = async () => {
    if (!state.root) return void (indexInfo.textContent = t('未打开文件夹'))
    const st = await window.api.ai.indexStatus(state.root).catch(() => null)
    if (!st) return void (indexInfo.textContent = '')
    indexInfo.textContent = st.building && !st.updatedAt ? t('正在建立…') : st.updatedAt ? t('{0} 个文件 · {1} 段代码{2}', st.files, st.chunks, st.building ? t('（更新中）') : '') : t('第一次使用时自动建立')
  }
  const refreshRules = async () => {
    if (!state.root) return void (rulesInfo.textContent = t('未打开文件夹'))
    const r = await projectRules(true)
    rulesInfo.textContent = r.files.length ? t('已找到：{0}', r.files.join('、')) : t('没有找到规则文件')
  }
  void refreshIndex()
  void refreshRules()
  return h(
    'div',
    { class: 'ai-ctx' },
    h('label', { class: 'check-row', for: 'ai-ctx-tabs' }, checkbox('ai-ctx-tabs', c.openTabs, set('openTabs')), h('span', {}, t('打开的标签页')), h('span', { class: 'muted' }, t('和光标附近相似的代码片段'))),
    h('label', { class: 'check-row', for: 'ai-ctx-lsp' }, checkbox('ai-ctx-lsp', c.lsp, set('lsp')), h('span', {}, t('语言服务')), h('span', { class: 'muted' }, t('导入符号的定义和签名'))),
    h(
      'div',
      { class: 'ai-ctx-row' },
      h('label', { class: 'check-row', for: 'ai-ctx-index' }, checkbox('ai-ctx-index', c.index, set('index')), h('span', {}, t('项目索引')), h('span', { class: 'muted' }, t('检索整个项目里的相关代码'))),
      h('span', { class: 'grow' }),
      indexInfo,
      rebuild
    ),
    h(
      'div',
      { class: 'ai-ctx-row' },
      h('label', { class: 'check-row', for: 'ai-ctx-rules' }, checkbox('ai-ctx-rules', c.rules, set('rules')), h('span', {}, t('项目规则')), h('span', { class: 'muted' }, '.infinite/rules.md · AGENTS.md · CLAUDE.md')),
      h('span', { class: 'grow' }),
      rulesInfo,
      newRules
    )
  )
}

/* ---------------- 智能功能开关与统计 ---------------- */

let statsSub: (() => void) | null = null

function smartRows(): HTMLElement {
  const s = aiSettings()
  const stats = h('div', { class: 'ai-stats' })
  const renderStats = () => {
    const st = completionStats()
    stats.replaceChildren(
      h('span', {}, t('最近 {0} 次建议', st.shown)),
      h('span', {}, t('接受率 {0}%', st.shown ? Math.round(st.rate * 100) : 0)),
      h('span', {}, t('接受后删掉 {0} 次', st.reverted)),
      h('span', {}, t('当前触发延迟 {0} 毫秒', st.debounce)),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onClick: () => (resetCompletionStats(), toast(t('已清空统计'))) }, t('清空统计'))
    )
  }
  renderStats()
  statsSub?.()
  statsSub = onCompletionStats(renderStats)
  return h(
    'div',
    { class: 'ai-smart' },
    h(
      'label',
      { class: 'check-row', for: 'ai-term-fix' },
      checkbox('ai-term-fix', s.terminalFix, (on) => updateAiSettings((x) => (x.terminalFix = on))),
      h('span', {}, t('终端报错一键修复')),
      h('span', { class: 'muted' }, t('编译 / 运行失败时在终端右上角提供“AI 解释并修复”'))
    ),
    h(
      'label',
      { class: 'check-row', for: 'ai-adaptive' },
      checkbox('ai-adaptive', s.adaptive, (on) => updateAiSettings((x) => (x.adaptive = on))),
      h('span', {}, t('自适应行内补全')),
      h('span', { class: 'muted' }, t('按接受率调整触发延迟；字符串里不自动补全，注释里很少被接受时也不再自动补全'))
    ),
    stats
  )
}

const AI_KEYS: [string, string][] = [
  [t('AI 内联编辑'), 'Ctrl I'],
  [t('接受 AI 行内补全'), 'Tab'],
  [t('跳到 / 接受下一处编辑预测'), 'Tab'],
  [t('忽略下一处编辑预测'), 'Esc'],
  [t('接受 / 拒绝 AI 修改'), 'Ctrl Enter / Esc'],
  [t('快速修复（含用 AI 修复）'), 'Alt Enter']
]

/**
 * “智慧能力”设置页的各节。section 是设置页的分节函数；assistant 是“AI 助手对话”一节的内容（由设置页提供，和它的同步逻辑放在一起）。
 * onOpenFile 打开文件（会先关掉设置页）。
 */
export function buildAiPane(section: (title: string, ...body: (Node | null)[]) => HTMLElement, assistant: HTMLElement, onOpenFile: (path: string) => void): HTMLElement[] {
  const providers = h('div', { class: 'ai-providers' })
  let features = featureRows()
  const featureHost = h('div', {}, features)
  const ctxHost = h('div', {}, contextRows(onOpenFile))
  const smartHost = h('div', {}, smartRows())
  const open = new Set<string>()
  const renderProviders = () =>
    void providerStatus().then((list) => {
      // 记住哪些服务是展开的，重画后保持
      providers.querySelectorAll<HTMLDetailsElement>('details[data-id]').forEach((d) => (d.open ? open.add(d.dataset.id!) : open.delete(d.dataset.id!)))
      providers.replaceChildren(
        ...AI_PROVIDERS.map((p) => {
          const card = providerCard(p, list.find((x) => x.id === p.id), () => void providerStatus(true).then(renderProviders))
          card.dataset.id = p.id
          ;(card as HTMLDetailsElement).open = open.has(p.id)
          return card
        })
      )
    })
  onAiChange(() => {
    // 功能设置变了（状态栏开关等）：重画功能行；焦点在里面时不打扰
    if (featureHost.contains(document.activeElement)) return
    const next = featureRows()
    features.replaceWith(next)
    features = next
  })
  renderProviders()
  rerender = () => {
    renderProviders()
    ctxHost.replaceChildren(contextRows(onOpenFile))
    smartHost.replaceChildren(smartRows())
  }
  return [
    section(t('模型'), featureHost),
    section(t('智能功能'), smartHost),
    section(t('上下文'), h('p', { class: 'muted ai-note' }, t('发给模型的上下文越完整，补全和修改越贴合项目。所有内容只发往你选择的服务。')), ctxHost),
    section(t('AI 助手对话'), assistant),
    section(t('服务与 API Key'), h('p', { class: 'muted ai-note' }, t('API Key 只保存在本机，用系统密钥加密；请求直接从本机发往你选择的服务。')), providers),
    section(t('快捷键'), h('div', { class: 'sys-keys' }, ...AI_KEYS.map(([k, v]) => h('div', {}, h('span', {}, k), h('kbd', {}, v)))))
  ]
}

let rerender: (() => void) | null = null

/** 打开设置页时刷新服务状态（环境变量、DeepSeek Harness 的 Key 可能在外面改过）、索引和规则文件 */
export function refreshAiSettings(): void {
  void providerStatus(true).then(() => rerender?.())
}
