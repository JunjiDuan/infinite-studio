/** 内置插件定义。主进程只按 id 查这里的命令，不执行页面传来的任意字符串。 */
/** 插件分类：大模型 / 编程语言 / 生产力工具 */
export type PluginCategory = 'llm' | 'language' | 'productivity'

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
}

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
  /** 插件包（zip）的下载地址，依次尝试 */
  urls: string[]
  sha256: string
  size?: number
}

export type MarketResult<T> = { ok: true; value: T } | { ok: false; error: string }
