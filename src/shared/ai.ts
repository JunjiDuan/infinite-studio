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
    // 行内补全要快：用最快的 Haiku，内联编辑仍用 Opus
    completionModel: 'claude-haiku-5-5',
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

/** 一个功能用哪个服务 / 模型 */
export interface AiPick {
  provider: AiProviderId
  model?: string
}

/** 设置里各功能用哪个服务 / 模型（存在 settings.json，不含 Key） */
export interface AiFeatureSettings {
  completion: AiPick & { enabled: boolean }
  edit: AiPick
  /** 下一处编辑预测（改了一处之后预测接下来要改的位置） */
  nextEdit: AiPick & { enabled: boolean }
  /** 发给模型的上下文来源 */
  context: {
    /** 其他打开的标签页里和光标附近相似的片段 */
    openTabs: boolean
    /** 通过语言服务取得的导入符号的定义 */
    lsp: boolean
    /** 项目索引里检索到的相关代码 */
    index: boolean
    /** 项目规则文件（.infinite/rules.md、AGENTS.md 等） */
    rules: boolean
  }
  /** 终端里出现报错时提供“用 AI 解释 / 修复” */
  terminalFix: boolean
  /** 按接受率自动调整行内补全的触发时机 */
  adaptive: boolean
}

export const DEFAULT_AI_SETTINGS: AiFeatureSettings = {
  completion: { enabled: true, provider: 'deepseek' },
  edit: { provider: 'deepseek' },
  nextEdit: { enabled: true, provider: 'deepseek' },
  context: { openTabs: true, lsp: true, index: true, rules: true },
  terminalFix: true,
  adaptive: true
}

/** 项目索引里检索到的一段代码 */
export interface AiSnippet {
  /** 绝对路径 */
  path: string
  /** 1 起始，含 */
  startLine: number
  endLine: number
  /** 所在的函数 / 类名（切分时识别出来的，可能为空） */
  symbol?: string
  text: string
  score: number
}

export interface AiIndexStatus {
  root: string
  files: number
  chunks: number
  /** 正在建立 / 更新 */
  building: boolean
  updatedAt: number
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
  /** completion：用补全的推理强度（更快）；默认 edit */
  kind?: 'completion' | 'edit'
}

export type AiResult = { ok: true; text: string } | { ok: false; error: string; cancelled?: boolean }
