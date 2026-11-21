import * as monaco from 'monaco-editor'
// monaco-editor 0.5x 的 exports 把 esm/vs/ 映射到了包根路径
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'
import type { ResolvedTheme } from './theme'

;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  }
}

// 打开的是单个文件而不是完整工程，关掉语义检查，避免满屏“找不到模块”的误报
try {
  const anyMonaco = monaco as unknown as Record<string, any>
  const tsApi = anyMonaco.typescript ?? (monaco.languages as unknown as Record<string, any>).typescript
  if (tsApi) {
    for (const d of [tsApi.typescriptDefaults, tsApi.javascriptDefaults]) {
      d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
      d?.setCompilerOptions({ target: 99, module: 99, allowJs: true, allowNonTsExtensions: true, jsx: 1 })
    }
  }
} catch (e) {
  console.warn('TypeScript 语言服务配置失败', e)
}

/** 单强调色语法高亮：关键字用强调色，字符串/类型用暖灰，其余全部是正文色 */
export function defineTheme(t: ResolvedTheme): void {
  const c = (hex: string) => hex.replace('#', '')
  monaco.editor.defineTheme('infinite', {
    base: t.light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: c(t.text) },
      { token: 'comment', foreground: c(t.muted), fontStyle: 'italic' },
      { token: 'keyword', foreground: c(t.accent) },
      { token: 'storage', foreground: c(t.accent) },
      { token: 'tag', foreground: c(t.accent) },
      { token: 'metatag', foreground: c(t.accent) },
      { token: 'string', foreground: c(t.str) },
      { token: 'string.escape', foreground: c(t.accent) },
      { token: 'regexp', foreground: c(t.str) },
      { token: 'number', foreground: c(t.str) },
      { token: 'constant', foreground: c(t.str) },
      { token: 'type', foreground: c(t.str) },
      { token: 'type.identifier', foreground: c(t.str) },
      { token: 'attribute.name', foreground: c(t.str) },
      { token: 'attribute.value', foreground: c(t.str) },
      { token: 'identifier', foreground: c(t.text) },
      { token: 'variable', foreground: c(t.text) },
      { token: 'delimiter', foreground: c(t.muted) },
      { token: 'operator', foreground: c(t.muted) },
      { token: 'string.key.json', foreground: c(t.text) },
      { token: 'string.value.json', foreground: c(t.str) },
      { token: 'keyword.json', foreground: c(t.accent) }
    ],
    colors: {
      'editor.background': t.bg,
      'editor.foreground': t.text,
      'editorGutter.background': t.bg,
      'editorLineNumber.foreground': t.muted + 'AA',
      'editorLineNumber.activeForeground': t.text,
      'editor.lineHighlightBackground': t.sel,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': t.accent,
      'editor.selectionBackground': t.accent + '40',
      'editor.inactiveSelectionBackground': t.accent + '22',
      'editor.selectionHighlightBackground': t.accent + '1A',
      'editor.wordHighlightBackground': t.accent + '1A',
      'editor.findMatchBackground': t.accent + '55',
      'editor.findMatchHighlightBackground': t.accent + '26',
      // 括号配对着色统一为灰色，保持“只有一个强调色”
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`editorBracketHighlight.foreground${i}`, t.muted])),
      'editorBracketHighlight.unexpectedBracket.foreground': t.muted,
      'editorBracketMatch.background': t.accent + '22',
      'editorBracketMatch.border': t.accent + '66',
      'editorIndentGuide.background1': t.line,
      'editorIndentGuide.activeBackground1': t.muted + '66',
      'editorWhitespace.foreground': t.line,
      'editorWidget.background': t.panel,
      'editorWidget.border': t.line,
      'editorSuggestWidget.background': t.panel,
      'editorSuggestWidget.border': t.line,
      'editorSuggestWidget.selectedBackground': t.sel,
      'editorSuggestWidget.highlightForeground': t.accent,
      'editorSuggestWidget.focusHighlightForeground': t.accent,
      'editorHoverWidget.background': t.panel,
      'editorHoverWidget.border': t.line,
      'editorOverviewRuler.border': '#00000000',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': t.muted + '30',
      'scrollbarSlider.hoverBackground': t.muted + '50',
      'scrollbarSlider.activeBackground': t.muted + '70',
      'focusBorder': t.accent + '88',
      'input.background': t.bg,
      'input.border': t.line,
      'list.hoverBackground': t.sel,
      'list.activeSelectionBackground': t.sel,
      'list.activeSelectionForeground': t.text,
      'list.highlightForeground': t.accent,
      'menu.background': t.panel,
      'menu.border': t.line,
      'menu.selectionBackground': t.sel
    }
  })
  monaco.editor.setTheme('infinite')
}

export function languageFor(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  const ext = name.includes('.') ? '.' + name.split('.').pop() : ''
  for (const l of monaco.languages.getLanguages()) {
    if (l.filenames?.some((f) => f.toLowerCase() === name)) return l.id
  }
  for (const l of monaco.languages.getLanguages()) {
    if (ext && l.extensions?.some((e) => e.toLowerCase() === ext)) return l.id
  }
  return 'plaintext'
}

export function languageName(id: string): string {
  if (id === 'plaintext') return '纯文本'
  const l = monaco.languages.getLanguages().find((x) => x.id === id)
  return l?.aliases?.[0] ?? id
}

export { monaco }
