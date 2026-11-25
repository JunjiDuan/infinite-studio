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
  },
  {
    name: 'getOpenEditors',
    description:
      'List the files open in the editor tabs, most recently used first, with their language and whether they have unsaved changes. The active editor also reports the cursor position and the selected text (if any). Use it to see what the user is looking at.',
    inputSchema: obj({}),
    annotations: { title: 'Get open editors', readOnlyHint: true }
  },
  {
    name: 'goToDefinition',
    description:
      'Find where a symbol is defined, using the language server (works across files and into libraries). Give the file and line where the symbol is used, plus the symbol name (or a column). Returns the definition locations with a preview of the surrounding code.',
    inputSchema: obj(
      {
        path: { type: 'string', description: 'Absolute path (or path relative to the project folder) of the file where the symbol appears.' },
        line: { type: 'number', description: '1-based line number where the symbol appears.' },
        symbol: { type: 'string', description: 'The symbol name as written on that line. Used to find the column.' },
        column: { type: 'number', description: '1-based column inside the symbol; only needed when `symbol` is not given or appears several times on the line.' }
      },
      ['path', 'line']
    ),
    annotations: { title: 'Go to definition', readOnlyHint: true }
  },
  {
    name: 'findReferences',
    description:
      'Find all references to a symbol in the project, using the language server. Give a place where the symbol appears (file, line, symbol name). Returns each reference with its line text. More precise than text search: it ignores unrelated identifiers with the same name.',
    inputSchema: obj(
      {
        path: { type: 'string', description: 'Absolute path (or path relative to the project folder) of a file where the symbol appears.' },
        line: { type: 'number', description: '1-based line number where the symbol appears.' },
        symbol: { type: 'string', description: 'The symbol name as written on that line.' },
        column: { type: 'number', description: '1-based column inside the symbol, if `symbol` is not given.' },
        includeDeclaration: { type: 'boolean', description: 'Also return the declaration itself (default true).' }
      },
      ['path', 'line']
    ),
    annotations: { title: 'Find references', readOnlyHint: true }
  },
  {
    name: 'getHover',
    description: 'Get the type signature and documentation of a symbol from the language server (what the editor shows on hover).',
    inputSchema: obj(
      {
        path: { type: 'string', description: 'Absolute path (or path relative to the project folder) of the file.' },
        line: { type: 'number', description: '1-based line number.' },
        symbol: { type: 'string', description: 'The symbol name as written on that line.' },
        column: { type: 'number', description: '1-based column inside the symbol, if `symbol` is not given.' }
      },
      ['path', 'line']
    ),
    annotations: { title: 'Get type info', readOnlyHint: true }
  },
  {
    name: 'getDocumentSymbols',
    description: 'List the classes, functions, methods and other symbols declared in a file, with their line ranges (an outline of the file).',
    inputSchema: obj({ path: { type: 'string', description: 'Absolute path (or path relative to the project folder) of the file.' } }, ['path']),
    annotations: { title: 'Get file outline', readOnlyHint: true }
  },
  {
    name: 'searchCode',
    description:
      'Semantic-ish code search over the project index: finds the functions and classes most related to a natural-language or identifier query (ranked by BM25 over identifiers, split on camelCase / snake_case). Returns code snippets with their paths and line ranges. Use it to locate relevant code when you do not know the exact names; use text search for exact strings.',
    inputSchema: obj(
      {
        query: { type: 'string', description: 'What to look for, e.g. "where the user session token is refreshed" or "parseConfig yaml".' },
        limit: { type: 'number', description: 'Maximum number of snippets (default 8, max 20).' }
      },
      ['query']
    ),
    annotations: { title: 'Search code', readOnlyHint: true }
  },
  {
    name: 'getGitDiff',
    description: 'Get the uncommitted changes in the project as a unified diff (working tree by default, or only the staged changes).',
    inputSchema: obj({ staged: { type: 'boolean', description: 'Only the staged changes (default false: unstaged working-tree changes).' } }),
    annotations: { title: 'Get git diff', readOnlyHint: true }
  },
  {
    name: 'getTerminalOutput',
    description: "Read the recent output of the IDE's integrated terminals (the active terminal first). Useful to see build errors, test failures or server logs the user is looking at.",
    inputSchema: obj({ maxLines: { type: 'number', description: 'Lines per terminal, counted from the end (default 120, max 1000).' } }),
    annotations: { title: 'Get terminal output', readOnlyHint: true }
  },
  {
    name: 'runTests',
    description:
      "Run the project's test suite with its standard command (detected from package.json, Cargo, Go, Maven, Gradle, .NET or pytest) and return the exit code and output. Optionally pass a test name filter.",
    inputSchema: obj({ filter: { type: 'string', description: 'Optional test name / pattern to run a subset (passed to the runner, e.g. pytest -k, go test -run).' } }),
    annotations: { title: 'Run tests', readOnlyHint: false }
  }
]
