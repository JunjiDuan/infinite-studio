/**
 * IDE 提供给内置 AI 对话的工具（MCP 服务 infinite-studio）：
 *   getDiagnostics（编辑器的诊断）、ai/ideTools.ts 里的编辑器 / 语言服务 / 索引 / 终端工具 + 插件提供的工具（PDF、演示文稿、思维导图……，见 market.ts）。
 *
 * Claude Code 通过 SDK MCP 通道直接调用这里；Codex 和 ACP 系的 agent 通过主进程的 MCP 桥接（mcpBridge.ts）转过来。
 */
import { PANEL_MCP_SERVER, PANEL_TOOLS, type McpToolDef } from '../../shared/ide'
import { panelDiagnostics } from './ide'
import { callPluginTool, isReadOnlyPluginTool, pluginToolDefs, pluginToolLabel, type ToolResult } from './market'
import { callIdeTool, IDE_TOOL_LABELS } from './ai/ideTools'
import { t } from './i18n'

export type { ToolResult }

/** 全部工具（每次列出时按当前安装、启用的插件生成） */
export function agentToolDefs(): McpToolDef[] {
  return [...PANEL_TOOLS, ...pluginToolDefs()]
}

/** 不用征求同意的工具 */
export function isReadOnlyAgentTool(name: string): boolean {
  const own = PANEL_TOOLS.find((t) => t.name === name)
  if (own) return !!own.annotations?.readOnlyHint
  return isReadOnlyPluginTool(name)
}

/** 完整工具名 mcp__infinite-studio__x → x；不是我们的返回 null */
export function ownToolName(full: string): string | null {
  const m = full.match(/^mcp__(.+?)__(.+)$/)
  return m && m[1] === PANEL_MCP_SERVER ? m[2] : null
}

/** 对话里显示：插件名 + 工具名 */
export function agentToolLabel(name: string): { plugin: string; tool: string } | null {
  if (IDE_TOOL_LABELS[name]) return { plugin: 'Infinite Studio', tool: t(IDE_TOOL_LABELS[name]) }
  return pluginToolLabel(name)
}

export async function callAgentTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === 'getDiagnostics') {
    const list = panelDiagnostics(typeof args.uri === 'string' && args.uri ? args.uri : undefined, typeof args.minSeverity === 'string' ? args.minSeverity : undefined)
    return { content: [{ type: 'text', text: JSON.stringify(list) }] }
  }
  const own = await callIdeTool(name, args)
  if (own) return own
  return callPluginTool(name, args)
}

/** 主进程转来的 MCP 桥接请求（Codex / ACP 对话） */
export function initAgentTools(): void {
  window.api.agentTools.onRequest((id, method, params) => {
    void (async () => {
      let result: unknown
      try {
        if (method === 'list') result = agentToolDefs()
        else {
          const name = String(params.name ?? '')
          const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}
          result = await callAgentTool(name, args)
        }
      } catch (e) {
        result = method === 'list' ? [] : { content: [{ type: 'text', text: String((e as Error)?.message ?? e) }], isError: true }
      }
      window.api.agentTools.reply(id, result)
    })()
  })
}
