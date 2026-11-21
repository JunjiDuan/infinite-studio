/** 内置插件定义。主进程只按 id 查这里的命令，不执行页面传来的任意字符串。 */
export interface PluginDef {
  id: string
  name: string
  publisher: string
  description: string
  /** 命令行可执行文件名（不带扩展名） */
  command: string
  /** npm 全局包名，用于一键安装 */
  npmPackage: string
  homepage: string
}

export const PLUGINS: PluginDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    publisher: 'Anthropic',
    description: '在终端里和 Claude 结对编程：读懂代码库、改代码、跑命令。',
    command: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    homepage: 'https://docs.claude.com/en/docs/claude-code/overview'
  },
  {
    id: 'codex',
    name: 'Codex',
    publisher: 'OpenAI',
    description: 'OpenAI 的命令行编程助手，在项目目录里读写代码、执行任务。',
    command: 'codex',
    npmPackage: '@openai/codex',
    homepage: 'https://github.com/openai/codex'
  }
]

export interface PluginStatus {
  installed: boolean
  version?: string
  /** 在终端里启动时用的命令（Windows 上带 .exe / .cmd，绕开 PowerShell 执行策略） */
  launch?: string
}
