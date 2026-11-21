import type { RateLimits, SessionInfo } from '../../../shared/agents'
import type { Hunk } from './diff'

/**
 * 对话视图（ChatView，界面）和协议驱动（Claude / Codex）之间的约定。
 * 驱动把各自协议的事件翻译成下面这些统一的界面操作。
 */

export interface ModelOption {
  id: string
  label: string
  description?: string
  /** 支持的思考强度；为空表示不可调 */
  efforts?: string[]
  defaultEffort?: string
  isDefault?: boolean
}

export interface SlashCommand {
  name: string
  description: string
  hint?: string
}

export interface ImageAttachment {
  name: string
  mime: string
  /** data:image/...;base64,... */
  dataUrl: string
}

export interface PromptContext {
  /** 当前打开的文件 */
  file?: string
  /** 编辑器里选中的内容 */
  selection?: { path: string; startLine: number; endLine: number; text: string }
  /** 最近使用的打开文件（新的在前，Codex 的 IDE 上下文用） */
  openTabs?: string[]
}

export interface UserInput {
  text: string
  images: ImageAttachment[]
  context: PromptContext
}

export type ToolStatus = 'running' | 'done' | 'error' | 'denied'

export type ToolIcon = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'web' | 'task' | 'todo' | 'mcp' | 'plan' | 'other'

export interface DiffInfo {
  path: string
  hunks: Hunk[]
  added: number
  removed: number
  /** 打开完整对比视图时取得两侧内容 */
  load?: () => Promise<{ original: string; modified: string }>
}

/** 一次工具调用的展示状态 */
export interface ToolView {
  icon: ToolIcon
  /** 动作名，例如“读取”“编辑”“运行” */
  verb: string
  /** 一行概要（路径、命令…） */
  summary: string
  /** 概要里的文件路径，点击打开 */
  path?: string
  line?: number
  status: ToolStatus
  /** 输入（命令等），展开后显示 */
  input?: string
  /** 输出 */
  output?: string
  /** 输出的简短描述，例如“读取了 120 行” */
  outputHint?: string
  diff?: DiffInfo
  /** Markdown 正文（计划等） */
  markdown?: string
  /** 子任务里的步骤 */
  steps?: string[]
  /** 默认展开 */
  expanded?: boolean
}

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface PermissionOption {
  id: string
  label: string
  /** 选中后显示输入框，让用户补充说明 */
  feedback?: boolean
}

export interface PermissionRequest {
  title: string
  /** 命令、原因等 */
  detail?: string
  /** 代码块显示的内容（命令） */
  code?: string
  diff?: DiffInfo
  /** Markdown 正文（计划） */
  markdown?: string
  options: PermissionOption[]
}

export interface PermissionAnswer {
  option: string
  feedback?: string
}

export interface Question {
  id: string
  header?: string
  question: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
  /** 允许自己填写 */
  allowOther: boolean
}

export interface TurnEnd {
  ok: boolean
  interrupted?: boolean
  error?: string
  durationMs?: number
  costUsd?: number
}

export interface LoginMethod {
  id: string
  label: string
  hint: string
  /** 需要用户输入的内容（例如 API Key），没有则直接开始 */
  input?: { label: string; placeholder: string; secret?: boolean }
}

/** 登录卡片提供给驱动的操作 */
export interface LoginUi {
  /** 显示授权链接；open 为 true 时由界面在浏览器里打开（命令行工具自己会打开时传 false） */
  url(url: string, open: boolean): void
  /** 设备码登录：显示一次性代码 */
  code(code: string): void
  /** 显示授权码输入框（浏览器回调失败时手动粘贴），提交时调用 submit */
  askCode(submit: (code: string) => void): void
  /** 用户取消时调用 */
  onCancel(fn: () => void): void
  /** 登录方式附带的输入（API Key） */
  readonly input?: string
}

/** 界面提供给驱动的操作 */
export interface ChatHost {
  readonly cwd: string | null
  /** 正在回放历史（不弹授权，不计时） */
  readonly replaying: boolean

  userMessage(text: string, opts?: { images?: number; id?: string; prev?: string; time?: number }): void
  /** 给最近一条还没有 id 的用户消息补上 id（Claude 回显后才知道 uuid） */
  ackUser(id: string, prev?: string): void
  text(id: string, text: string, append?: boolean): void
  thinking(id: string, text: string, opts?: { append?: boolean; done?: boolean }): void
  tool(id: string, patch: Partial<ToolView>): void
  getTool(id: string): ToolView | undefined
  todos(items: Todo[]): void
  note(text: string, kind?: 'info' | 'error' | 'action'): void

  permission(req: PermissionRequest, key?: string): Promise<PermissionAnswer>
  /** 取消一个还没回答的授权（进程那边已撤回） */
  cancelPermission(key: string): void
  ask(questions: Question[], key?: string): Promise<Record<string, string[]> | null>

  turnStarted(): void
  turnEnded(info: TurnEnd): void
  busy(): boolean
  status(text: string | null): void
  usage(used: number, window: number | null, costUsd?: number): void
  /** 订阅额度（5 小时 / 每周窗口） */
  rateLimits(r: RateLimits): void
  session(id: string | null, title?: string): void
  setMode(id: string): void
  capabilities(): void
  /** 进程意外退出 */
  crashed(message: string): void
}

/** 驱动提供给界面的操作 */
export interface Driver {
  readonly models: ModelOption[]
  readonly commands: SlashCommand[]
  readonly sessionId: string | null
  /** 没选模型时实际使用的模型 */
  readonly activeModel?: string
  /** 当前可以回退到某条用户消息 */
  readonly canRewind: boolean
  account?: string

  /** 准备进程（读取模型、命令列表等），失败时抛错 */
  start(): Promise<void>
  send(input: UserInput): Promise<void>
  interrupt(): void
  setMode(id: string): void
  setModel(id: string, effort?: string): void
  listSessions(): Promise<SessionInfo[]>
  /** 载入历史会话并回放到界面 */
  resume(id: string): Promise<void>
  /** 开始新会话 */
  reset(): void
  /** 登录方式（第一个是默认） */
  readonly loginMethods: LoginMethod[]
  /** 登录；完成后 resolve，失败或取消时抛错 */
  login(method: string, ui: LoginUi): Promise<void>
  logout(): Promise<void>
  /** 主动查询订阅额度（结果通过 host.rateLimits 推送）；不支持时没有这个方法 */
  readRateLimits?(): Promise<void>
  /** 回退：code 恢复文件，conversation 截断对话 */
  rewind?(messageId: string, prev: string | undefined, what: { code: boolean; conversation: boolean }): Promise<void>
  dispose(): void
}
