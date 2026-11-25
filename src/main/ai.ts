import { app, ipcMain, safeStorage, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { AI_PROVIDERS, aiProvider, type AiChatRequest, type AiCompleteRequest, type AiProviderId, type AiProviderStatus, type AiResult } from '../shared/ai'
import { deepseekHarnessKey } from './agents'
import { tm } from './i18n'

/**
 * 编辑器内置 AI 的模型服务：行内补全（FIM 或对话接口）和流式对话（内联编辑、AI 修复）。
 *
 * - DeepSeek / Kimi / 自定义服务走 OpenAI 兼容接口（fetch + SSE）
 * - Claude 走官方 SDK（@anthropic-ai/sdk）
 *
 * API Key 用 safeStorage（系统密钥）加密后存在 userData/ai.json，只在主进程里解密；
 * 没填时依次尝试环境变量，DeepSeek 还会复用 DeepSeek Harness 已配置的 Key。
 */

interface Store {
  /** 服务 id → safeStorage 加密后的 Key（base64） */
  keys?: Partial<Record<AiProviderId, string>>
  /** 服务 id → 自定义接口地址 */
  baseUrl?: Partial<Record<AiProviderId, string>>
  /** 自定义服务的补全是否用 FIM 接口 */
  fim?: Partial<Record<AiProviderId, boolean>>
}

const storeFile = () => path.join(app.getPath('userData'), 'ai.json')

let storeCache: Store | null = null
async function readStore(): Promise<Store> {
  if (storeCache) return storeCache
  try {
    const raw = JSON.parse(await fs.readFile(storeFile(), 'utf8')) as Store
    storeCache = raw && typeof raw === 'object' ? raw : {}
  } catch {
    storeCache = {}
  }
  return storeCache
}

let writing: Promise<void> = Promise.resolve()
function writeStore(next: Store): Promise<void> {
  storeCache = next
  const job = writing.then(async () => {
    await fs.mkdir(path.dirname(storeFile()), { recursive: true })
    const tmp = `${storeFile()}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, storeFile())
  })
  writing = job.catch(() => undefined)
  return job
}

const ENV_KEYS: Record<AiProviderId, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  kimi: 'MOONSHOT_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY'
}

const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 5)}…${k.slice(-4)}` : '••••')

async function resolveKey(id: AiProviderId): Promise<{ key: string; source: 'stored' | 'env' | 'dsh' } | null> {
  const enc = (await readStore()).keys?.[id]
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      const key = safeStorage.decryptString(Buffer.from(enc, 'base64'))
      if (key) return { key, source: 'stored' }
    } catch {
      /* 换了系统账户等原因解不开：当作没填 */
    }
  }
  const env = process.env[ENV_KEYS[id]]
  if (env) return { key: env, source: 'env' }
  if (id === 'deepseek') {
    const dsh = await deepseekHarnessKey()
    if (dsh) return { key: dsh.key, source: dsh.source === 'env' ? 'env' : 'dsh' }
  }
  return null
}

async function status(): Promise<AiProviderStatus[]> {
  const store = await readStore()
  return Promise.all(
    AI_PROVIDERS.map(async (p) => {
      const k = await resolveKey(p.id)
      return {
        id: p.id,
        configured: !!k || !!p.keyOptional,
        masked: k ? mask(k.key) : undefined,
        source: k?.source,
        baseUrl: store.baseUrl?.[p.id] || undefined,
        fim: store.fim?.[p.id] ?? p.fim
      }
    })
  )
}

async function setKey(id: AiProviderId, key: string | null): Promise<void> {
  if (!aiProvider(id)) throw new Error('unknown provider')
  const store = { ...(await readStore()) }
  const keys = { ...(store.keys ?? {}) }
  if (key === null || !key.trim()) delete keys[id]
  else {
    key = key.trim()
    if (key.length > 512 || /[\r\n\s]/.test(key)) throw new Error(tm('API Key 格式不正确'))
    if (!safeStorage.isEncryptionAvailable()) throw new Error(tm('系统密钥存储不可用，无法安全保存 API Key'))
    keys[id] = safeStorage.encryptString(key).toString('base64')
  }
  store.keys = keys
  await writeStore(store)
}

async function setEndpoint(id: AiProviderId, baseUrl: string | null, fim?: boolean): Promise<void> {
  const meta = aiProvider(id)
  if (!meta || id === 'anthropic') throw new Error('unknown provider')
  const store = { ...(await readStore()) }
  const urls = { ...(store.baseUrl ?? {}) }
  const url = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!url || url === meta.baseUrl) delete urls[id]
  else {
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(tm('接口地址必须以 http:// 或 https:// 开头'))
    urls[id] = url
  }
  store.baseUrl = urls
  if (typeof fim === 'boolean' && id === 'openai') store.fim = { ...(store.fim ?? {}), [id]: fim }
  await writeStore(store)
}

/* ---------------- 请求 ---------------- */

/** 进行中的请求：`窗口id:请求id` → 取消用的控制器 */
const running = new Map<string, AbortController>()

class Cancelled extends Error {}

function begin(wc: WebContents, reqId: string, timeoutMs: number): { signal: AbortSignal; end: () => void; key: string } {
  const key = `${wc.id}:${reqId}`
  running.get(key)?.abort()
  const ctl = new AbortController()
  running.set(key, ctl)
  const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(timeoutMs)])
  return { signal, key, end: () => running.get(key) === ctl && running.delete(key) }
}

async function endpoint(id: AiProviderId): Promise<{ baseUrl: string; key: string | null; fim: boolean }> {
  const meta = aiProvider(id)!
  const store = await readStore()
  const k = await resolveKey(id)
  if (!k && !meta.keyOptional) throw new Error(tm('还没有配置 {0} 的 API Key（设置 → 智慧能力）', tm(meta.name)))
  return { baseUrl: store.baseUrl?.[id] || meta.baseUrl || '', key: k?.key ?? null, fim: store.fim?.[id] ?? meta.fim }
}

function modelFor(id: AiProviderId, model: string | undefined, kind: 'completion' | 'edit'): string {
  const meta = aiProvider(id)!
  const m = (model ?? '').trim() || (kind === 'completion' ? meta.completionModel : meta.defaultModel)
  if (!m) throw new Error(tm('请在设置里填写 {0} 使用的模型名称', tm(meta.name)))
  return m
}

async function httpError(res: Response): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
    detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message || ''
  } catch {
    /* 不是 JSON */
  }
  if (res.status === 401 || res.status === 403) return new Error(tm('API Key 无效或没有权限') + (detail ? `：${detail}` : ''))
  if (res.status === 429) return new Error(tm('请求太频繁或额度已用完') + (detail ? `：${detail}` : ''))
  return new Error(`HTTP ${res.status}${detail ? `：${detail}` : ''}`)
}

function headers(key: string | null): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

/** OpenAI 兼容的流式对话；每段文本调用 onText */
async function openaiChat(id: AiProviderId, req: AiChatRequest, model: string, signal: AbortSignal, onText: (s: string) => void): Promise<string> {
  const ep = await endpoint(id)
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(ep.key),
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0,
      max_tokens: req.maxTokens ?? 8192,
      messages: [{ role: 'system', content: req.system }, ...req.messages]
    })
  })
  if (!res.ok || !res.body) throw await httpError(res)
  let out = ''
  let buf = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return out
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const s = j.choices?.[0]?.delta?.content
        if (s) {
          out += s
          onText(s)
        }
      } catch {
        /* 心跳等非 JSON 行 */
      }
    }
  }
  return out
}

/** Claude 当前这几个模型支持服务端拒答回退（fallbacks: "default"） */
const CLAUDE_FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
/** 支持 output_config.effort 的 Claude 模型 */
const CLAUDE_EFFORT_MODELS = new Set([...CLAUDE_FALLBACK_MODELS, 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7'])

const clients = new Map<string, Anthropic>()
function claudeClient(key: string | null): Anthropic {
  const k = key ?? ''
  let c = clients.get(k)
  if (!c) {
    // 没有 Key 时交给 SDK 自己找凭据（ant auth login 的登录信息等）
    c = key ? new Anthropic({ apiKey: key, maxRetries: 1 }) : new Anthropic({ maxRetries: 1 })
    clients.set(k, c)
  }
  return c
}

async function claudeChat(
  req: AiChatRequest,
  model: string,
  effort: 'low' | 'medium' | 'high',
  signal: AbortSignal,
  onText: (s: string) => void
): Promise<string> {
  const k = await resolveKey('anthropic')
  const client = claudeClient(k?.key ?? null)
  const fallback = CLAUDE_FALLBACK_MODELS.has(model)
  try {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: req.maxTokens ?? 32000,
        // 提示缓存：系统提示和第一条消息（内联编辑时是整段文件）在多轮修改、重复请求之间复用，省钱也更快出第一个字
        system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
        messages: req.messages.map((m, i) =>
          i === 0 && m.role === 'user' && m.content.length > 2000
            ? { role: m.role, content: [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }] }
            : m
        ),
        ...(CLAUDE_EFFORT_MODELS.has(model) ? { output_config: { effort } } : {}),
        // 安全分类器拒答时由服务端换模型重试
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
      },
      { signal }
    )
    let out = ''
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        out += event.delta.text
        onText(event.delta.text)
      }
    }
    const msg = await stream.finalMessage()
    if (msg.stop_reason === 'refusal') throw new Error(tm('Claude 拒绝了这个请求'))
    return out
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw new Cancelled()
    if (e instanceof Anthropic.AuthenticationError) throw new Error(k ? tm('API Key 无效或没有权限') : tm('还没有配置 {0} 的 API Key（设置 → 智慧能力）', 'Claude'))
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error(tm('API Key 无效或没有权限'))
    if (e instanceof Anthropic.NotFoundError) throw new Error(tm('模型不存在：{0}', model))
    if (e instanceof Anthropic.RateLimitError) throw new Error(tm('请求太频繁或额度已用完'))
    if (e instanceof Anthropic.APIConnectionError) throw new Error(tm('无法连接到 {0}', 'Claude'))
    throw e
  }
}

async function chat(id: AiProviderId, req: AiChatRequest, kind: 'completion' | 'edit', signal: AbortSignal, onText: (s: string) => void): Promise<string> {
  const model = modelFor(id, req.model, kind)
  if (id === 'anthropic') return claudeChat(req, model, kind === 'completion' ? 'low' : 'medium', signal, onText)
  return openaiChat(id, req, model, signal, onText)
}

/* ---------------- 行内补全 ---------------- */

const CURSOR = '<CURSOR>'
const COMPLETE_SYSTEM = [
  'You are the inline code completion engine of an IDE.',
  `You receive the contents of a file around the user's cursor, marked with ${CURSOR}.`,
  `Reply with exactly the text to insert at ${CURSOR} and nothing else: no explanation, no markdown code fences,`,
  'and never repeat code that already appears before or after the cursor.',
  'Keep it short: finish the current line, statement or small block (at most about 15 lines).',
  'Match the indentation and style of the surrounding code. If nothing useful should be inserted, reply with an empty message.'
].join(' ')

/** 去掉模型偶尔加上的 ``` 代码块包装 */
function stripFences(s: string): string {
  const m = s.match(/^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1] : s
}

async function complete(req: AiCompleteRequest, signal: AbortSignal): Promise<string> {
  const id = req.provider
  const ep = await endpoint(id)
  const model = modelFor(id, req.model, 'completion')
  if (id !== 'anthropic' && ep.fim) {
    // FIM：DeepSeek 在 /beta/completions，其余 OpenAI 兼容服务（Ollama 等）在 /completions
    const url = id === 'deepseek' ? `${ep.baseUrl.replace(/\/v1$/, '')}/beta/completions` : `${ep.baseUrl}/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(ep.key),
      signal,
      body: JSON.stringify({ model, prompt: (req.context ? req.context + '\n' : '') + req.prefix, suffix: req.suffix, max_tokens: 160, temperature: 0, stream: false })
    })
    if (!res.ok) throw await httpError(res)
    const j = (await res.json()) as { choices?: { text?: string }[] }
    return j.choices?.[0]?.text ?? ''
  }
  const user = [
    req.context ? `Related code from other open files:\n${req.context}\n` : '',
    `File: ${req.path}`,
    `Language: ${req.language}`,
    '',
    req.prefix + CURSOR + req.suffix
  ].join('\n')
  const out = await chat(id, { provider: id, model, system: COMPLETE_SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: id === 'anthropic' ? 4096 : 256 }, 'completion', signal, () => {})
  return stripFences(out)
}

/* ---------------- IPC ---------------- */

function fail(e: unknown, signal?: AbortSignal): AiResult {
  // 先看信号：SDK 把超时也报成用户取消
  if (signal?.aborted) return (signal.reason as Error)?.name === 'TimeoutError' ? { ok: false, error: tm('请求超时') } : { ok: false, error: 'cancelled', cancelled: true }
  if (e instanceof Cancelled) return { ok: false, error: 'cancelled', cancelled: true }
  const err = e as Error & { cause?: { code?: string } }
  if (err?.name === 'AbortError') return { ok: false, error: 'cancelled', cancelled: true }
  if (err?.message === 'fetch failed') return { ok: false, error: tm('网络连接失败') + (err.cause?.code ? `（${err.cause.code}）` : '') }
  return { ok: false, error: String(err?.message ?? e) }
}

const validProvider = (id: unknown): id is AiProviderId => typeof id === 'string' && !!aiProvider(id)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

export function registerAiIpc(): void {
  ipcMain.handle('ai:status', () => status())
  ipcMain.handle('ai:setKey', (_e, id: unknown, key: unknown) => {
    if (!validProvider(id)) throw new Error('unknown provider')
    return setKey(id, typeof key === 'string' ? key : null)
  })
  ipcMain.handle('ai:setEndpoint', (_e, id: unknown, baseUrl: unknown, fim: unknown) => {
    if (!validProvider(id)) throw new Error('unknown provider')
    return setEndpoint(id, typeof baseUrl === 'string' ? baseUrl : null, typeof fim === 'boolean' ? fim : undefined)
  })
  ipcMain.on('ai:cancel', (e, reqId: unknown) => running.get(`${e.sender.id}:${String(reqId)}`)?.abort())

  ipcMain.handle('ai:complete', async (e, reqId: unknown, raw: AiCompleteRequest): Promise<AiResult> => {
    if (!raw || !validProvider(raw.provider)) return { ok: false, error: 'bad request' }
    const req: AiCompleteRequest = {
      provider: raw.provider,
      model: str(raw.model, 200) || undefined,
      prefix: str(raw.prefix, 20_000),
      suffix: str(raw.suffix, 10_000),
      language: str(raw.language, 100),
      path: str(raw.path, 1000),
      context: str(raw.context, 10_000) || undefined
    }
    const r = begin(e.sender, String(reqId), 20_000)
    try {
      return { ok: true, text: await complete(req, r.signal) }
    } catch (err) {
      return fail(err, r.signal)
    } finally {
      r.end()
    }
  })

  ipcMain.handle('ai:chat', async (e, reqId: unknown, raw: AiChatRequest): Promise<AiResult> => {
    if (!raw || !validProvider(raw.provider) || !Array.isArray(raw.messages)) return { ok: false, error: 'bad request' }
    const req: AiChatRequest = {
      provider: raw.provider,
      model: str(raw.model, 200) || undefined,
      system: str(raw.system, 20_000),
      messages: raw.messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => ({ role: m.role, content: str(m.content, 400_000) })),
      maxTokens: typeof raw.maxTokens === 'number' ? Math.max(256, Math.min(64_000, raw.maxTokens)) : undefined,
      kind: raw.kind === 'completion' ? 'completion' : 'edit'
    }
    const id = String(reqId)
    const r = begin(e.sender, id, 180_000)
    const wc = e.sender
    try {
      const text = await chat(req.provider, req, req.kind === 'completion' ? 'completion' : 'edit', r.signal, (s) => {
        if (!wc.isDestroyed()) wc.send('ai:delta', id, s)
      })
      return { ok: true, text }
    } catch (err) {
      return fail(err, r.signal)
    } finally {
      r.end()
    }
  })

  /** 设置里的“测试”：发一个很短的请求，看 Key 和模型能不能用 */
  ipcMain.handle('ai:test', async (e, id: unknown, model: unknown): Promise<AiResult> => {
    if (!validProvider(id)) return { ok: false, error: 'unknown provider' }
    const r = begin(e.sender, `test-${id}`, 60_000)
    try {
      const req: AiChatRequest = { provider: id, model: str(model, 200) || undefined, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: id === 'anthropic' ? 2048 : 16 }
      const text = await chat(id, req, 'edit', r.signal, () => {})
      return { ok: true, text: text.trim() || 'OK' }
    } catch (err) {
      return fail(err, r.signal)
    } finally {
      r.end()
    }
  })
}
