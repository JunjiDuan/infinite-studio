/**
 * AI 对话面板（Claude Code / Codex）的共享定义。
 *
 * 两个插件都按官方 VS Code 扩展的方式驱动命令行：
 * - Claude Code：常驻 `claude -p --input-format stream-json`，通过 control_request 协议交互；
 * - Codex：常驻 `codex app-server`，JSON-RPC 协议。
 * - Kimi Code / DeepSeek Harness：常驻 ACP 服务（`kimi acp` / `dsh --profile acp`），JSON-RPC 协议。
 */

export interface AgentMode {
  id: string
  label: string
  hint: string
}

/** Claude Code 的权限模式（与 VS Code 扩展一致）。第一个是默认值。 */
export const CLAUDE_MODES: AgentMode[] = [
  { id: 'default', label: '编辑前询问', hint: '修改文件、运行命令前都会征求你的同意' },
  { id: 'acceptEdits', label: '自动编辑', hint: '直接修改文件；运行命令等其它操作仍会询问' },
  { id: 'plan', label: '计划模式', hint: '先探索代码并给出方案，确认后才动手' },
  { id: 'bypassPermissions', label: '跳过权限', hint: '不经确认执行所有操作（包括运行命令），请谨慎使用' }
]

/** Codex 的模式（与 VS Code 扩展一致）：对话 / Agent / Agent（完全访问） */
export interface CodexMode extends AgentMode {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval: 'on-request' | 'never'
}

export const CODEX_MODES: CodexMode[] = [
  { id: 'agent', label: 'Agent', hint: '可以读写工作区内的文件、运行命令；越界操作前会询问', sandbox: 'workspace-write', approval: 'on-request' },
  { id: 'chat', label: '对话', hint: '只读：可以查看代码、回答问题，修改或运行命令前会询问', sandbox: 'read-only', approval: 'on-request' },
  { id: 'full', label: 'Agent（完全访问）', hint: '不受沙箱限制、不再询问，可访问网络和整个磁盘，请谨慎使用', sandbox: 'danger-full-access', approval: 'never' }
]

/** Kimi Code 的模式（ACP session/set_mode，id 与 kimi acp 一致） */
export const KIMI_MODES: AgentMode[] = [
  { id: 'default', label: '编辑前询问', hint: '修改文件、运行命令前都会征求你的同意' },
  { id: 'plan', label: '计划模式', hint: '只读：先探索代码并给出方案，不执行工具' },
  { id: 'auto', label: '自动批准', hint: '安全的操作自动执行，有风险的仍会询问' },
  { id: 'yolo', label: '全部批准', hint: '不经确认执行所有操作（包括运行命令），请谨慎使用' }
]

/** DeepSeek Harness 的 ACP 没有模式，授权请求由界面按模式应答 */
export const DEEPSEEK_MODES: AgentMode[] = [
  { id: 'ask', label: '编辑前询问', hint: '修改文件、运行命令前都会征求你的同意' },
  { id: 'auto', label: '自动批准', hint: '自动同意所有授权请求（仍受工作区沙箱限制），请谨慎使用' }
]

export const AGENT_MODES: Record<string, AgentMode[]> = { claude: CLAUDE_MODES, codex: CODEX_MODES, kimi: KIMI_MODES, deepseek: DEEPSEEK_MODES }

/** 走 ACP（Agent Client Protocol）的插件 → 启动参数 */
export const ACP_ARGS: Record<string, string[]> = { kimi: ['acp'], deepseek: ['--profile', 'acp'] }

/** 启动一个对话进程 */
export interface AgentStart {
  plugin: string
  cwd?: string
  /** Claude：权限模式 */
  mode?: string
  /** Claude：模型别名或 id */
  model?: string
  /** Claude：思考强度 */
  effort?: string
  /** Claude：续接的会话 id */
  resume?: string
  /** Claude：只保留到这条消息（uuid）为止的历史 */
  resumeAt?: string
}

/** Claude 的登录方式：claude.ai 订阅 / Anthropic Console（API 计费） */
export type ClaudeLoginMethod = 'claudeai' | 'console'

/** 登录流程的进度 */
export type LoginEvent =
  | { type: 'url'; url: string }
  | { type: 'code'; code: string }
  | { type: 'output'; text: string }
  | { type: 'exit'; ok: boolean; message?: string }

/** 历史会话 */
export interface SessionInfo {
  id: string
  title: string
  /** 毫秒时间戳 */
  updatedAt: number
}

/** 订阅额度的一个窗口（5 小时 / 每周等） */
export interface RateWindow {
  /** 显示名，例如“5 小时”“每周” */
  label: string
  /** 已用百分比 0-100 */
  usedPercent: number
  /** 重置时间（毫秒时间戳） */
  resetsAt?: number
}

export interface RateLimits {
  windows: RateWindow[]
  /** 取得这份数据的时间（毫秒） */
  updatedAt: number
}

/** 某一天的 token 消耗 */
export interface DayUsage {
  /** 不含缓存的输入 */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** 本地日期 YYYY-MM-DD → 当天消耗 */
export type DailyUsage = Record<string, DayUsage>
