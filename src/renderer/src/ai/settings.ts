import { AI_PROVIDERS, aiProvider, type AiProviderId, type AiProviderMeta, type AiProviderStatus } from '../../../shared/ai'
import { h, toast } from '../dom'
import { t } from '../i18n'
import { aiSettings, onAiChange, providerStatus, setProviderEndpoint, setProviderKey, updateAiSettings } from './client'

/**
 * 设置页“AI 能力”一节：各功能用哪个服务 / 模型，各服务的 API Key 和接口地址。
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

function featureRows(): HTMLElement {
  const s = aiSettings()
  const comp = aiProvider(s.completion.provider)!
  const edit = aiProvider(s.edit.provider)!
  const enabled = h('input', {
    type: 'checkbox',
    id: 'ai-completion-on',
    checked: s.completion.enabled,
    onChange: () => updateAiSettings((x) => (x.completion.enabled = enabled.checked))
  })
  return h(
    'div',
    { class: 'ai-features' },
    h(
      'div',
      { class: 'ai-feature' },
      h('label', { class: 'check-row', for: 'ai-completion-on' }, enabled, h('span', {}, t('行内补全')), h('span', { class: 'muted' }, t('灰色提示，Tab 接受'))),
      h(
        'div',
        { class: 'ai-feature-pick' },
        providerSelect(s.completion.provider, (id) => updateAiSettings((x) => ((x.completion.provider = id), (x.completion.model = undefined)))),
        modelInput(comp, s.completion.model, comp.completionModel, (m) => updateAiSettings((x) => (x.completion.model = m)))
      )
    ),
    h(
      'div',
      { class: 'ai-feature' },
      h('div', { class: 'check-row' }, h('span', {}, t('内联编辑与 AI 修复')), h('span', { class: 'muted' }, t('Ctrl I · Alt Enter'))),
      h(
        'div',
        { class: 'ai-feature-pick' },
        providerSelect(s.edit.provider, (id) => updateAiSettings((x) => ((x.edit.provider = id), (x.edit.model = undefined)))),
        modelInput(edit, s.edit.model, edit.defaultModel, (m) => updateAiSettings((x) => (x.edit.model = m)))
      )
    )
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

/** 设置页里的“AI 能力”内容 */
export function buildAiSettings(): HTMLElement {
  const root = h('div', { class: 'ai-settings' })
  const providers = h('div', { class: 'ai-providers' })
  let features = featureRows()
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
  root.append(
    features,
    h('p', { class: 'muted ai-note' }, t('API Key 只保存在本机，用系统密钥加密；请求直接从本机发往你选择的服务。')),
    providers
  )
  onAiChange(() => {
    // 功能设置变了（状态栏开关等）：重画功能行，保留焦点所在的输入框时不打扰
    if (root.contains(document.activeElement) && features.contains(document.activeElement)) return
    const next = featureRows()
    features.replaceWith(next)
    features = next
  })
  renderProviders()
  rerender = renderProviders
  return root
}

let rerender: (() => void) | null = null

/** 打开设置页时刷新服务状态（环境变量、DeepSeek Harness 的 Key 可能在外面改过） */
export function refreshAiSettings(): void {
  void providerStatus(true).then(() => rerender?.())
}
