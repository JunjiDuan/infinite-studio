/** 内置插件定义。主进程只按 id 查这里的命令，不执行页面传来的任意字符串。 */
/** 插件分类：大模型 / 编程语言 */
export type PluginCategory = 'llm' | 'language'

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
    homepage: 'https://github.com/openai/codex'
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
