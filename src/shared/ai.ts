/**
 * 编辑器内置 AI（行内补全、Ctrl I 内联编辑、诊断旁的 AI 修复）共用的模型服务定义。
 * 请求都在主进程发出：API Key 只保存在主进程（系统密钥加密），界面拿不到明文。
 */

export type AiProviderId = 'deepseek' | 'kimi' | 'anthropic' | 'openai'

export interface AiProviderMeta {
  id: AiProviderId
  name: string
  /** 推荐的模型（设置里的下拉提示，也可以手填别的） */
  models: string[]
  /** 内联编辑 / AI 修复的默认模型 */
  defaultModel: string
  /** 行内补全的默认模型 */
  completionModel: string
  /** 默认的接口地址（Claude 走官方 SDK，不可改） */
  baseUrl?: string
  /** 行内补全默认用 FIM 接口（prompt + suffix），否则用对话接口 */
  fim: boolean
  /** 申请 API Key 的网页 */
  keyUrl?: string
  /** 没有 Key 也能用（本地 Ollama 等） */
  keyOptional?: boolean
}

export const AI_PROVIDERS: AiProviderMeta[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    completionModel: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    fim: true,
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    models: ['kimi-k2-turbo-preview', 'kimi-k2-0905-preview', 'kimi-latest'],
    defaultModel: 'kimi-k2-turbo-preview',
    completionModel: 'kimi-k2-turbo-preview',
    baseUrl: 'https://api.moonshot.cn/v1',
    fim: false,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'anthropic',
    name: 'Claude',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-opus-5-5',
    completionModel: 'claude-opus-5-5',
    fim: false,
    keyUrl: 'https://platform.claude.com/settings/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI 兼容',
    models: [],
    defaultModel: '',
    completionModel: '',
    baseUrl: 'http://localhost:11434/v1',
    fim: false,
    keyOptional: true
  }
]

export function aiProvider(id: string | undefined): AiProviderMeta | undefined {
  return AI_PROVIDERS.find((p) => p.id === id)
}

/** 某个服务的配置状态（不含明文 Key） */
export interface AiProviderStatus {
  id: AiProviderId
  configured: boolean
  /** 打码后的 Key */
  masked?: string
  /** stored：设置里填的；env：环境变量；dsh：DeepSeek Harness 的凭据文件 */
  source?: 'stored' | 'env' | 'dsh'
  /** 自定义的接口地址（没改过时为空） */
  baseUrl?: string
  /** 行内补全是否用 FIM 接口（只有自定义服务可以改） */
  fim?: boolean
}

/** 设置里各功能用哪个服务 / 模型（存在 settings.json，不含 Key） */
export interface AiFeatureSettings {
  completion: { enabled: boolean; provider: AiProviderId; model?: string }
  edit: { provider: AiProviderId; model?: string }
}

export const DEFAULT_AI_SETTINGS: AiFeatureSettings = {
  completion: { enabled: true, provider: 'deepseek' },
  edit: { provider: 'deepseek' }
}

/** 行内补全请求：光标前后的代码 */
export interface AiCompleteRequest {
  provider: AiProviderId
  model?: string
  prefix: string
  suffix: string
  language: string
  path: string
  /** 其他打开的文件里的片段，帮助模型理解上下文 */
  context?: string
}

export interface AiMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 对话请求（内联编辑、AI 修复）：流式返回 */
export interface AiChatRequest {
  provider: AiProviderId
  model?: string
  system: string
  messages: AiMessage[]
  maxTokens?: number
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string; cancelled?: boolean }
