/** 内置插件定义。主进程只按 id 查这里的命令，不执行页面传来的任意字符串。 */
/** 插件分类：大模型 / 编程语言 / 生产力工具 / 语言（界面语言包） */
export type PluginCategory = 'llm' | 'language' | 'productivity' | 'locale'

export interface PluginDef {
  id: string
  category: PluginCategory
  name: string
  publisher: string
  description: string
  /** 命令行可执行文件名（不带扩展名）；编程语言插件为空，由主进程按语言检测工具链 */
  command: string
  /** npm 全局包名，用于一键安装（大模型插件） */
  npmPackage?: string
  /** 不走 npm 的大模型插件：官方安装脚本（在终端里执行） */
  installScript?: { win: string; unix: string }
  /** 大模型插件：有内置对话面板（协议驱动）；没有的只能在终端里运行 */
  chat?: boolean
  /** JS 入口用本机安装的 node 运行（工具拒绝在 Electron 内置的 Node 里运行时） */
  systemNode?: boolean
  /** 在终端中运行时附加的参数 */
  launchArgs?: string
  homepage: string
  /** 编程语言插件：负责的 Monaco 语言 id */
  languages?: string[]
}

export const PLUGINS: PluginDef[] = [
  {
    id: 'claude',
    category: 'llm',
    name: 'Claude Code',
    publisher: 'Anthropic',
    description: '在终端里和 Claude 结对编程：读懂代码库、改代码、跑命令。',
    command: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    chat: true,
    homepage: 'https://docs.claude.com/en/docs/claude-code/overview'
  },
  {
    id: 'codex',
    category: 'llm',
    name: 'Codex',
    publisher: 'OpenAI',
    description: 'OpenAI 的命令行编程助手，在项目目录里读写代码、执行任务。',
    command: 'codex',
    npmPackage: '@openai/codex',
    chat: true,
    homepage: 'https://github.com/openai/codex'
  },
  {
    id: 'antigravity',
    category: 'llm',
    name: 'Gemini',
    publisher: 'Google',
    description: 'Google 的命令行编程助手，由 Gemini 模型驱动（Antigravity CLI，命令 agy）：读懂代码库、改代码、跑命令。个人 Google 账号登录即可使用，有免费额度。',
    command: 'agy',
    // 官方安装脚本：校验 SHA512 后放到 %LOCALAPPDATA%gyin（Windows）/ ~/.local/bin
    installScript: {
      win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
      unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
    },
    chat: true,
    homepage: 'https://antigravity.google/docs/cli'
  },
  {
    id: 'deepseek',
    category: 'llm',
    name: 'DeepSeek Harness',
    publisher: 'DeepSeek',
    description: 'DeepSeek 的开源智能体框架（dsh），在工作区里读写文件、执行命令、分派子任务。',
    command: 'dsh',
    npmPackage: '@deepseek-ai/dsh',
    chat: true,
    systemNode: true,
    launchArgs: 'web',
    homepage: 'https://github.com/deepseek-ai/deepseek-harness'
  },
  {
    id: 'kimi',
    category: 'llm',
    name: 'Kimi Code',
    publisher: 'Moonshot AI',
    description: 'Moonshot AI 的命令行编程助手，由 Kimi 模型驱动，在项目目录里写代码、跑命令。',
    command: 'kimi',
    npmPackage: '@moonshot-ai/kimi-code',
    chat: true,
    homepage: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started'
  },
  {
    id: 'python',
    category: 'language',
    name: 'Python',
    publisher: 'Infinite Studio',
    description: '运行和调试 Python 脚本：断点、单步、变量与调用栈，附带 basedpyright 语言服务。',
    command: '',
    homepage: 'https://www.python.org/',
    languages: ['python']
  },
  {
    id: 'java',
    category: 'language',
    name: 'Java',
    publisher: 'Infinite Studio',
    description: '编译、运行和调试 Java 程序（基于 JDK 自带的 javac 和 jdb）。',
    command: '',
    homepage: 'https://learn.microsoft.com/java/openjdk/',
    languages: ['java']
  },
  {
    id: 'cpp',
    category: 'language',
    name: 'C/C++',
    publisher: 'Infinite Studio',
    description: '用 GCC 编译、运行 C/C++ 程序，用 GDB 调试，附带 clangd 语言服务。',
    command: '',
    homepage: 'https://winlibs.com/',
    languages: ['c', 'cpp']
  },
  {
    id: 'csharp',
    category: 'language',
    name: 'C#',
    publisher: 'Infinite Studio',
    description: '用 .NET SDK 编译、运行 C# 项目和单文件程序，用 netcoredbg 调试，附带 csharp-ls 语言服务。',
    command: '',
    homepage: 'https://dotnet.microsoft.com/',
    languages: ['csharp']
  }
]

/** 工具链里的一个组件（解释器、编译器、调试器、语言服务） */
export interface ToolComponent {
  name: string
  ok: boolean
  /** 版本或路径 */
  detail?: string
  /** 可选组件：没装也能运行和调试 */
  optional?: boolean
}

export interface PluginStatus {
  installed: boolean
  version?: string
  /** 在终端里启动时用的命令（Windows 上带 .exe / .cmd，绕开 PowerShell 执行策略） */
  launch?: string
  /** 编程语言插件：各组件的检测结果 */
  components?: ToolComponent[]
  /** 编程语言插件：缺少的组件的一键安装命令（在终端里执行）；全部装好时为空 */
  installScript?: string
}

/** 运行 / 调试的计划，由主进程按工具链生成 */
export interface RunPlan {
  /** 在内置终端里执行的命令（已按当前 shell 转义） */
  command: string
  cwd: string
}

/* ---------------- 插件市场（从 GitHub 下载安装的插件） ---------------- */

/** 插件市场所在的仓库（插件放在仓库的 marketplace/ 目录） */
export const MARKET_REPO = 'JunjiDuan/infinite-studio'

/** 插件包里的 manifest.json */
export interface PluginManifest {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  category: PluginCategory
  homepage?: string
  /** 需要的最低 IDE 版本 */
  minStudio?: string
  /** 包内的图标文件（SVG / PNG） */
  icon?: string
  /** 自定义编辑器：打开这些扩展名的文件时，用插件页面代替文本编辑器 */
  editor?: {
    /** 页面入口（包内的 HTML 文件） */
    entry: string
    /** 小写、带点，例如 [".mind"] */
    extensions: string[]
    /** 文件按二进制读写（PDF、PPTX 等）；否则按 UTF-8 文本 */
    binary?: boolean
  }
  /** “新建”命令：在工作区里新建一个这种文件 */
  newFile?: {
    label: string
    extension: string
    /** 新文件的初始内容（文本） */
    template?: string
  }
  /** 需要的最低插件接口版本（PLUGIN_API），不写为 1。IDE 版本不够时拒绝安装 */
  minApi?: number
  /** 额外权限（默认都没有），见 PLUGIN_PERMISSIONS */
  permissions?: PluginPermission[]
  /** 语言包（category 为 locale）：安装后可在“多语言设置”里切换成这种界面语言 */
  locale?: LocalePackInfo
  /** 网页面板（需要 webPanel 权限）：在编辑器右侧的分栏里显示这些网站，例如网页版大模型 */
  webPanel?: WebPanelInfo
  /** 提供给 IDE 里 AI 助手（Claude Code、Codex 等）的工具，页面里用 studio.tools.register 实现（接口版本 5） */
  agentTools?: AgentToolDecl[]
}

/**
 * manifest 里声明的一个 AI 工具。IDE 把它注册成 MCP 工具 mcp__infinite-studio__<插件 id>_<name>，
 * 并自动加上 file 参数（要操作的文件）。AI 调用时 IDE 打开这个文件（没打开的话），再交给插件页面执行。
 * name 为 "screenshot" 时是 IDE 提供的截图工具：先调用页面里同名的处理函数（切到要看的位置），再截取插件标签的画面。
 */
export interface AgentToolDecl {
  /** 字母、数字、下划线，1–48 个字符 */
  name: string
  /** 给 AI 看的说明（英文效果最好） */
  description: string
  /** 参数的 JSON Schema（type: object）；不用写 file */
  inputSchema?: Record<string, unknown>
  /** 只读取、不修改文档：AI 调用时不用征求用户同意，调用后也不保存 */
  readOnly?: boolean
  /** 调用最长等多久（秒），默认 60，最多 900 */
  timeout?: number
}

/** agentTools[].name */
export const AGENT_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/

/** manifest 里的 webPanel 字段 */
export interface WebPanelInfo {
  /** 编辑器右上角按钮的提示文字；不写时用插件名 */
  title?: string
  sites: WebSite[]
}

/** 网页面板里可以打开的一个网站 */
export interface WebSite {
  /** 小写字母、数字、连字符；登录状态按它分开保存 */
  id: string
  name: string
  /** 首页（https），“新对话”也回到这里 */
  url: string
  /** 包内的图标文件 */
  icon?: string
  /** 一句话介绍，显示在选择弹窗里 */
  description?: string
  /**
   * 可以在面板里打开的主机名（"*.example.com" 同时匹配 example.com 和它的子域名），
   * 包括登录要经过的网站（例如 accounts.google.com）。其他链接用系统浏览器打开
   */
  hosts: string[]
  /** 输入框的 CSS 选择器，依次尝试。“发送到网页助手”时把内容粘贴进第一个找到的输入框 */
  input?: string[]
}

/** 网站 id */
export const WEB_SITE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** webPanel.hosts 里的一项 */
export const WEB_HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** 主机名是否匹配 webPanel.hosts 里的一项（"*.a.com" 同时匹配 a.com 和它的子域名） */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return h === base || h.endsWith('.' + base)
  }
  return h === pattern
}

/** 语言包 manifest 里的 locale 字段 */
export interface LocalePackInfo {
  /** BCP 47 语言代码，例如 "es"、"pt-BR" */
  code: string
  /** 这种语言自己的名称，例如 "Español" */
  name: string
  /** 包内的翻译表（JSON）：键是界面源码里的中文原文，值是译文；缺的条目显示英文 */
  strings: string
}

/** 语言包的语言代码 */
export const LOCALE_CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** 启动时交给界面的语言包内容（翻译表） */
export interface LocalePack {
  id: string
  code: string
  name: string
  strings: Record<string, string>
}

/**
 * 插件接口版本：IDE 给插件的接口（SDK 能调用的方法、事件、权限）扩展一次就加 1。
 * 插件在 manifest 里写 minApi；只用到老接口的插件在新旧 IDE 上都能装。
 *   1  load / save / dirty / theme / export / toast / openExternal / openText / openLink / readAsset
 *   2  call() 通用调用：fs.* / dialog.* / clipboard.* / net.fetch / editor.* / terminal.run / commands；
 *      权限；嵌套预览框；文件监视
 *   3  语言包（category: locale，manifest.locale）
 *   4  网页面板（manifest.webPanel + webPanel 权限）；市场插件可以放在“大模型”分类（category: llm）
 *   5  AI 工具（manifest.agentTools + studio.tools.register）；studio.agent.send 把内容发到 AI 对话
 */
export const PLUGIN_API = 5

/** 插件可以声明的权限 */
export const PLUGIN_PERMISSIONS = ['network', 'eval', 'workspace-write', 'clipboard-read', 'terminal', 'webPanel'] as const
/**
 *   network          页面可以加载 http(s) 资源；可以用 net.fetch（不受跨域限制）
 *   eval             页面可以用 eval / new Function
 *   workspace-write  可以在工作区里写入、新建、重命名、删除文件（不声明时只能写当前文件）
 *   clipboard-read   可以读取剪贴板（写入不需要权限）
 *   terminal         可以在 IDE 终端里运行命令（每次会话第一次运行前会询问用户）
 *   webPanel         可以在分栏里显示 manifest.webPanel 声明的网站（独立的登录状态，网页拿不到 IDE 的任何接口）
 */
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** registry.json 里的一项 */
export interface RemotePlugin {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  category: PluginCategory
  homepage?: string
  minStudio?: string
  /** 插件需要的额外权限，安装前显示在卡片上 */
  permissions?: PluginPermission[]
  /** 需要的最低插件接口版本（PLUGIN_API） */
  minApi?: number
  /** 插件包（zip）的下载地址，依次尝试 */
  urls: string[]
  sha256: string
  size?: number
}

export type MarketResult<T> = { ok: true; value: T } | { ok: false; error: string }
