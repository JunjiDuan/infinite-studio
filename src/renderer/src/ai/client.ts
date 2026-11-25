import { AI_PROVIDERS, DEFAULT_AI_SETTINGS, aiProvider, type AiChatRequest, type AiFeatureSettings, type AiPick, type AiProviderId, type AiProviderStatus, type AiResult } from '../../../shared/ai'
import { persist, state } from '../store'
import { t } from '../i18n'

/**
 * 编辑器内置 AI 的界面端入口：读写功能设置、发请求（实际请求在主进程）。
 */

const isProvider = (v: unknown): v is AiProviderId => typeof v === 'string' && !!aiProvider(v)

/** 当前的功能设置（补上默认值、去掉坏数据） */
export function aiSettings(): AiFeatureSettings {
  const raw = state.settings.ai as Partial<AiFeatureSettings> | undefined
  const D = DEFAULT_AI_SETTINGS
  const model = (m: unknown) => (typeof m === 'string' && m.trim() ? m.trim().slice(0, 200) : undefined)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const pick = (v: Partial<AiPick> | undefined, d: AiPick): AiPick => ({ provider: isProvider(v?.provider) ? v.provider : d.provider, model: model(v?.model) })
  const c = raw?.completion
  const n = raw?.nextEdit
  const x = raw?.context
  return {
    completion: { enabled: bool(c?.enabled, D.completion.enabled), ...pick(c, D.completion) },
    edit: pick(raw?.edit, D.edit),
    // 下一处编辑预测没单独设置过时跟随行内补全的服务
    nextEdit: { enabled: bool(n?.enabled, D.nextEdit.enabled), ...pick(n, isProvider(c?.provider) ? { provider: c.provider } : D.nextEdit) },
    context: {
      openTabs: bool(x?.openTabs, D.context.openTabs),
      lsp: bool(x?.lsp, D.context.lsp),
      index: bool(x?.index, D.context.index),
      rules: bool(x?.rules, D.context.rules)
    },
    terminalFix: bool(raw?.terminalFix, D.terminalFix),
    adaptive: bool(raw?.adaptive, D.adaptive)
  }
}

const listeners = new Set<() => void>()
export function onAiChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function notify(): void {
  listeners.forEach((fn) => fn())
}

export function updateAiSettings(fn: (s: AiFeatureSettings) => void): void {
  const s = aiSettings()
  fn(s)
  state.settings.ai = s
  persist()
  notify()
}

export type AiFeature = 'completion' | 'edit' | 'nextEdit'

/** 显示用的“服务 · 模型” */
export function modelLabel(kind: AiFeature): string {
  const f = aiSettings()[kind]
  const meta = aiProvider(f.provider)!
  const m = f.model || (kind === 'edit' ? meta.defaultModel : meta.completionModel)
  return m ? `${t(meta.name)} · ${m}` : t(meta.name)
}

/* ---------------- 服务状态（有没有 Key） ---------------- */

let statusCache: Promise<AiProviderStatus[]> | null = null

export function providerStatus(force = false): Promise<AiProviderStatus[]> {
  if (!statusCache || force) {
    statusCache = window.api.ai.status().catch(() => AI_PROVIDERS.map((p) => ({ id: p.id, configured: false })))
  }
  return statusCache
}

export async function setProviderKey(id: AiProviderId, key: string | null): Promise<void> {
  await window.api.ai.setKey(id, key)
  await providerStatus(true)
  notify()
}

export async function setProviderEndpoint(id: AiProviderId, baseUrl: string | null, fim?: boolean): Promise<void> {
  await window.api.ai.setEndpoint(id, baseUrl, fim)
  await providerStatus(true)
  notify()
}

/* ---------------- 请求 ---------------- */

let seq = 0
export const nextRequestId = (): string => `ai${Date.now().toString(36)}-${++seq}`

const deltaHandlers = new Map<string, (text: string) => void>()
let deltaSub: (() => void) | null = null

/** 流式对话：onText 收到每段文本；返回结果和取消函数。feature 决定用哪个功能设置的服务 / 模型（默认内联编辑） */
export function streamChat(
  req: Omit<AiChatRequest, 'provider' | 'model'>,
  onText: (text: string) => void,
  feature: AiFeature = 'edit'
): { done: Promise<AiResult>; cancel: () => void } {
  deltaSub ??= window.api.ai.onDelta((id, text) => deltaHandlers.get(id)?.(text))
  const f = aiSettings()[feature]
  const id = nextRequestId()
  deltaHandlers.set(id, onText)
  const done = window.api.ai
    .chat(id, { ...req, provider: f.provider, model: f.model, kind: req.kind ?? (feature === 'edit' ? 'edit' : 'completion') })
    .catch((e): AiResult => ({ ok: false, error: String((e as Error)?.message ?? e) }))
    .finally(() => deltaHandlers.delete(id))
  return { done, cancel: () => window.api.ai.cancel(id) }
}

/** 不需要流式显示的一次性请求 */
export function askOnce(req: Omit<AiChatRequest, 'provider' | 'model'>, feature: AiFeature = 'edit'): { done: Promise<AiResult>; cancel: () => void } {
  return streamChat(req, () => {}, feature)
}

/** 从模型回复里取出第一个代码块；没有代码块时原样返回 */
export function extractCode(reply: string): string {
  const m = reply.match(/```[^\n`]*\n([\s\S]*?)\n?```/)
  if (m) return m[1]
  // 还在流式输出、代码块没闭合
  const open = reply.match(/```[^\n`]*\n([\s\S]*)$/)
  return open ? open[1] : reply
}
