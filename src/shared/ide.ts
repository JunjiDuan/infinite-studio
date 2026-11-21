/**
 * IDE 桥接（和官方 VS Code 扩展一致）的共享定义。
 *
 * 1. 终端里的 claude：通过 WebSocket MCP 服务（主进程 ide.ts）连到编辑器，工具和 VS Code 扩展的同名：
 *    openDiff / getDiagnostics / close_tab / closeAllDiffTabs
 * 2. 内置对话面板：通过 SDK MCP 通道（control_request: mcp_message）提供 getDiagnostics，
 *    另外用 PreToolUse / PostToolUse 钩子在 Claude 改文件前后对比诊断，把新出现的问题告诉 Claude。
 */

export interface IdeToolResult {
  content?: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  error?: string
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

const SCHEMA = 'http://json-schema.org/draft-07/schema#'
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
  $schema: SCHEMA
})

/** WebSocket 服务提供给终端里 claude 的工具（名称、参数和 VS Code 扩展完全一致） */
export const IDE_TOOLS: McpToolDef[] = [
  {
    name: 'openDiff',
    description: 'Open a git diff for the file',
    inputSchema: obj(
      {
        old_file_path: { type: 'string', description: 'Path to the file to show diff for. If not provided, uses active editor.' },
        new_file_path: { type: 'string', description: 'Path to the file to show diff for. If not provided, uses active editor.' },
        new_file_contents: { type: 'string', description: 'Contents of the new file. If not provided then the current file contents of new_file_path will be used.' },
        tab_name: { type: 'string', description: 'Path to the file to show diff for. If not provided, uses active editor.' }
      },
      ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name']
    )
  },
  {
    name: 'getDiagnostics',
    description: 'Get language diagnostics from the editor',
    inputSchema: obj({ uri: { type: 'string', description: 'Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files.' } })
  },
  {
    name: 'close_tab',
    inputSchema: obj({ tab_name: { type: 'string' } }, ['tab_name'])
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Close all diff tabs in the editor',
    inputSchema: obj({})
  }
]

export const SEVERITIES = ['Error', 'Warning', 'Information', 'Hint'] as const

/** 内置面板里 SDK MCP 服务的名字（工具名为 mcp__infinite-studio__getDiagnostics） */
export const PANEL_MCP_SERVER = 'infinite-studio'

/** SDK MCP 服务提供给内置面板的工具 */
export const PANEL_TOOLS: McpToolDef[] = [
  {
    name: 'getDiagnostics',
    description:
      'Get the errors, warnings and other diagnostics the editor currently shows in its Problems panel, including those for unsaved changes in open editors. Returns a JSON array with one entry per file, each listing that file\'s diagnostics. Pass `uri` to check one file; its entry is returned even when it has no diagnostics. Omit `uri` to get only the files that have at least one diagnostic. Pass `minSeverity` to include only diagnostics at least that severe, for example `Warning` for errors and warnings only; without `uri`, files left with none are omitted. Language servers only analyze open files, so a missing file or an empty list can mean the file has not been checked, not that it is clean.',
    inputSchema: obj({
      uri: { type: 'string', description: 'file:// URI of the one file to check. Omit to get every file that has at least one diagnostic (at or above `minSeverity`, when given).' },
      minSeverity: { type: 'string', enum: [...SEVERITIES], description: 'Include only diagnostics at least this severe. From most to least severe: Error, Warning, Information, Hint. Omit to include every severity.' }
    }),
    annotations: { title: 'Get diagnostics', readOnlyHint: true }
  }
]
