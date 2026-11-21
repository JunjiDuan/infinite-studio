/**
 * 精简的 LSP 客户端。每种语言服务一个 Client，通过主进程桥接到语言服务进程。
 * 只把已打开为标签页的文档同步给服务端；跳转到其他文件时按需建只读模型。
 */
import type { LspServerInfo } from '../../shared/types'
import { basename, toast } from './dom'
import { findTab, normPath, onTab, openFile, samePath, tabs } from './editor'
import { languageFor, monaco } from './monaco'
import { emit, state } from './store'

// LSP 协议对象结构多变，这里统一按 JSON 处理
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
type Model = monaco.editor.ITextModel

/* ---------------- 坐标与类型转换 ---------------- */

const toPos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 })
const toRange = (r: Json) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1)
const fromRange = (r: monaco.IRange) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 }
})
const toTextEdit = (e: Json): monaco.languages.TextEdit => ({ range: toRange(e.range), text: e.newText })

function toDoc(d: Json): string | monaco.IMarkdownString | undefined {
  if (d == null) return undefined
  if (typeof d === 'string') return d
  return d.kind === 'markdown' ? { value: d.value } : d.value
}

function toMarkdown(c: Json): monaco.IMarkdownString[] {
  if (c == null) return []
  if (Array.isArray(c)) return c.flatMap(toMarkdown)
  if (typeof c === 'string') return c ? [{ value: c }] : []
  if ('kind' in c) return c.value ? [{ value: c.kind === 'markdown' ? c.value : '```\n' + c.value + '\n```' }] : []
  if ('language' in c) return [{ value: '```' + c.language + '\n' + c.value + '\n```' }]
  return []
}

const K = monaco.languages.CompletionItemKind
// LSP CompletionItemKind（1 起始）→ Monaco
const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module,
  10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference,
  19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter
}

const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint
}

/** Monaco 的 ts/js 不区分 jsx，按扩展名告诉服务端 */
function lspLanguageId(model: Model): string {
  const id = model.getLanguageId()
  const p = model.uri.path.toLowerCase()
  if (id === 'typescript' && p.endsWith('.tsx')) return 'typescriptreact'
  if (id === 'javascript' && p.endsWith('.jsx')) return 'javascriptreact'
  if (id === 'cpp' && /\.(c|h)$/.test(p)) return 'c'
  return id
}

/** 按文件路径找模型（服务端返回的 URI 编码、盘符大小写可能和 Monaco 不同） */
function findModel(uri: string): Model | null {
  const fsPath = monaco.Uri.parse(uri).fsPath
  return monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && samePath(m.uri.fsPath, fsPath)) ?? null
}

/** 跳转 / 引用的目标文件没打开时，读出来建一个模型供预览 */
async function ensureModel(uri: string): Promise<Model | null> {
  const existing = findModel(uri)
  if (existing) return existing
  const path = normPath(monaco.Uri.parse(uri).fsPath)
  const r = await window.api.fs.readFile(path)
  if (!r.ok) return null
  return findModel(uri) ?? monaco.editor.createModel(r.content, languageFor(path), monaco.Uri.file(path))
}

/* ---------------- 客户端 ---------------- */

type Status = 'starting' | 'ready' | 'failed' | 'stopped'

class Client {
  session = -1
  status: Status = 'starting'
  caps: Json = {}
  readonly owner: string
  readonly ready: Promise<void>
  private seq = 1
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private docs = new Map<Model, monaco.IDisposable>()
  private providers: monaco.IDisposable[] = []
  private pullTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly info: LspServerInfo,
    readonly root: string
  ) {
    this.owner = 'lsp-' + info.id
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    try {
      this.session = await window.api.lsp.start(this.info.id, this.root)
      sessions.set(this.session, this)
      const rootUri = monaco.Uri.file(this.root).toString()
      const res = await this.request('initialize', {
        processId: null,
        clientInfo: { name: 'Infinite Studio', version: '0.1.0' },
        locale: 'zh-cn',
        rootPath: this.root,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { workspaceFolders: true, configuration: true, applyEdit: true, workspaceEdit: { documentChanges: true }, diagnostics: { refreshSupport: true } },
          window: { workDoneProgress: true, showMessage: {} },
          textDocument: {
            synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
            completion: {
              contextSupport: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                labelDetailsSupport: true,
                deprecatedSupport: true,
                tagSupport: { valueSet: [1] },
                insertReplaceSupport: true,
                resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
              },
              completionList: { itemDefaults: ['editRange', 'insertTextFormat', 'commitCharacters', 'data'] }
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            documentHighlight: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            formatting: {},
            rangeFormatting: {},
            rename: { prepareSupport: true },
            publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false }
          }
        }
      })
      this.caps = res?.capabilities ?? {}
      this.notify('initialized', {})
      this.registerProviders()
      this.status = 'ready'
    } catch (e) {
      this.status = 'failed'
      console.warn(`${this.info.name} 语言服务启动失败`, e)
      toast(`${this.info.name} 语言服务启动失败`)
      throw e
    } finally {
      emit('lsp')
    }
  }

  /* ----- JSON-RPC ----- */

  request(method: string, params: Json, token?: monaco.CancellationToken): Promise<Json> {
    if (this.status === 'failed' || this.status === 'stopped') return Promise.resolve(null)
    const id = this.seq++
    window.api.lsp.send(this.session, { jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      token?.onCancellationRequested(() => {
        if (!this.pending.has(id)) return
        this.notify('$/cancelRequest', { id })
        this.pending.delete(id)
        resolve(null)
      })
    })
  }

  notify(method: string, params: Json): void {
    if (this.session < 0 || this.status === 'stopped') return
    window.api.lsp.send(this.session, { jsonrpc: '2.0', method, params })
  }

  private respond(id: Json, result: Json, error?: Json): void {
    window.api.lsp.send(this.session, error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })
  }

  handle(msg: Json): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) {
        // 请求被取消 / 内容已过期属于正常情况，不当作错误
        if (msg.error.code === -32800 || msg.error.code === -32801) p.resolve(null)
        else p.reject(new Error(msg.error.message))
      } else p.resolve(msg.result)
      return
    }
    if (msg.id !== undefined) {
      void this.onServerRequest(msg.id, msg.method, msg.params)
      return
    }
    this.onNotification(msg.method, msg.params)
  }

  private async onServerRequest(id: Json, method: string, params: Json): Promise<void> {
    switch (method) {
      case 'workspace/configuration':
        return this.respond(id, (params?.items ?? []).map(() => null))
      case 'workspace/workspaceFolders':
        return this.respond(id, [{ uri: monaco.Uri.file(this.root).toString(), name: basename(this.root) }])
      case 'workspace/applyEdit':
        try {
          await applyWorkspaceEdit(params.edit)
          return this.respond(id, { applied: true })
        } catch (e) {
          return this.respond(id, { applied: false, failureReason: String(e) })
        }
      case 'workspace/diagnostic/refresh':
        this.schedulePull(0)
        return this.respond(id, null)
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/foldingRange/refresh':
        return this.respond(id, null)
      default:
        return this.respond(id, null, { code: -32601, message: 'Method not found: ' + method })
    }
  }

  private onNotification(method: string, params: Json): void {
    if (method === 'textDocument/publishDiagnostics') {
      const model = findModel(params.uri)
      if (model && this.docs.has(model)) this.setMarkers(model, params.diagnostics ?? [])
    } else if (method === 'window/showMessage' && params?.type <= 2) {
      toast(`${this.info.name}：${params.message}`)
    } else if (method === 'window/logMessage') {
      console.debug(`[${this.info.name}]`, params?.message)
    }
  }

  onExit(code: number, stderr: string): void {
    const wasReady = this.status === 'ready'
    this.status = this.status === 'stopped' ? 'stopped' : 'failed'
    for (const p of this.pending.values()) p.resolve(null)
    this.pending.clear()
    this.disposeAll()
    if (wasReady) {
      toast(`${this.info.name} 语言服务已退出（${code}）`)
      console.warn(`${this.info.name} exited`, code, stderr)
    }
    emit('lsp')
  }

  /* ----- 文档同步 ----- */

  has(model: Model): boolean {
    return this.status === 'ready' && this.docs.has(model)
  }

  private syncKind(): number {
    const s = this.caps.textDocumentSync
    return typeof s === 'number' ? s : (s?.change ?? 1)
  }

  open(model: Model): void {
    if (this.docs.has(model) || model.isDisposed() || this.status !== 'ready') return
    const uri = model.uri.toString()
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId: lspLanguageId(model), version: model.getVersionId(), text: model.getValue() } })
    const sub = model.onDidChangeContent((e) => {
      const kind = this.syncKind()
      if (kind === 0) return
      // 多处同时修改（多光标）时直接发全文，避免顺序问题
      const contentChanges =
        kind === 2 && e.changes.length === 1
          ? e.changes.map((c) => ({ range: fromRange(c.range), rangeLength: c.rangeLength, text: c.text }))
          : [{ text: model.getValue() }]
      this.notify('textDocument/didChange', { textDocument: { uri, version: model.getVersionId() }, contentChanges })
      this.schedulePull()
    })
    this.docs.set(model, sub)
    this.schedulePull(0)
  }

  close(model: Model): void {
    const sub = this.docs.get(model)
    if (!sub) return
    sub.dispose()
    this.docs.delete(model)
    this.notify('textDocument/didClose', { textDocument: { uri: model.uri.toString() } })
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, this.owner, [])
  }

  save(model: Model): void {
    if (!this.docs.has(model)) return
    const s = this.caps.textDocumentSync
    if (typeof s === 'object' && s?.save) {
      const includeText = typeof s.save === 'object' && s.save.includeText
      this.notify('textDocument/didSave', { textDocument: { uri: model.uri.toString() }, ...(includeText ? { text: model.getValue() } : {}) })
    }
  }

  /* ----- 诊断：推送模式直接收；拉取模式（TS 7 用这种）在修改后主动请求 ----- */

  private setMarkers(model: Model, diags: Json[]): void {
    monaco.editor.setModelMarkers(
      model,
      this.owner,
      diags.map((d) => ({
        severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
        message: d.message,
        source: d.source,
        code: d.code == null ? undefined : String(typeof d.code === 'object' ? d.code.value : d.code),
        tags: d.tags,
        ...toRange(d.range)
      }))
    )
  }

  private schedulePull(delay = 500): void {
    if (!this.caps.diagnosticProvider) return
    clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => {
      // 改一个文件可能影响其他文件的诊断，所以对所有打开的文档都重新拉取
      for (const model of this.docs.keys()) void this.pull(model)
    }, delay)
  }

  private async pull(model: Model): Promise<void> {
    const version = model.getVersionId()
    try {
      const r = await this.request('textDocument/diagnostic', { textDocument: { uri: model.uri.toString() } })
      if (!r || model.isDisposed() || !this.docs.has(model) || model.getVersionId() !== version) return
      if (r.kind === 'full') this.setMarkers(model, r.items ?? [])
    } catch {
      /* 服务端繁忙时偶尔失败，下次修改会再拉 */
    }
  }

  /* ----- 语言功能 ----- */

  private registerProviders(): void {
    const c = this.caps
    const L = monaco.languages
    const doc = (m: Model) => ({ uri: m.uri.toString() })

    for (const lang of this.info.languages) {
      if (c.completionProvider) {
        this.providers.push(
          L.registerCompletionItemProvider(lang, {
            triggerCharacters: c.completionProvider.triggerCharacters,
            provideCompletionItems: async (model, position, context, token) => {
              if (!this.has(model)) return null
              const res = await this.request(
                'textDocument/completion',
                {
                  textDocument: doc(model),
                  position: toPos(position),
                  context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter }
                },
                token
              )
              if (!res) return null
              const items: Json[] = Array.isArray(res) ? res : (res.items ?? [])
              const word = model.getWordUntilPosition(position)
              const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
              const defaults = Array.isArray(res) ? undefined : res.itemDefaults
              return { suggestions: items.map((it) => this.toSuggestion(it, fallback, defaults)), incomplete: !Array.isArray(res) && !!res.isIncomplete }
            },
            resolveCompletionItem: c.completionProvider.resolveProvider
              ? async (item, token) => {
                  const raw = (item as Json)._lsp
                  if (!raw) return item
                  const r = await this.request('completionItem/resolve', raw, token)
                  if (r) {
                    item.detail = r.detail ?? item.detail
                    item.documentation = toDoc(r.documentation) ?? item.documentation
                    if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(toTextEdit)
                  }
                  return item
                }
              : undefined
          })
        )
      }

      if (c.hoverProvider) {
        this.providers.push(
          L.registerHoverProvider(lang, {
            provideHover: async (model, position, token) => {
              if (!this.has(model)) return null
              const r = await this.request('textDocument/hover', { textDocument: doc(model), position: toPos(position) }, token)
              const contents = toMarkdown(r?.contents)
              return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null
            }
          })
        )
      }

      if (c.signatureHelpProvider) {
        this.providers.push(
          L.registerSignatureHelpProvider(lang, {
            signatureHelpTriggerCharacters: c.signatureHelpProvider.triggerCharacters,
            signatureHelpRetriggerCharacters: c.signatureHelpProvider.retriggerCharacters,
            provideSignatureHelp: async (model, position, token, context) => {
              if (!this.has(model)) return null
              const r = await this.request(
                'textDocument/signatureHelp',
                { textDocument: doc(model), position: toPos(position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } },
                token
              )
              if (!r?.signatures?.length) return null
              return {
                value: {
                  signatures: r.signatures.map((s: Json) => ({
                    label: s.label,
                    documentation: toDoc(s.documentation),
                    parameters: (s.parameters ?? []).map((p: Json) => ({ label: p.label, documentation: toDoc(p.documentation) })),
                    activeParameter: s.activeParameter
                  })),
                  activeSignature: r.activeSignature ?? 0,
                  activeParameter: r.activeParameter ?? 0
                },
                dispose() {}
              }
            }
          })
        )
      }

      const locationProvider = (method: string) => async (model: Model, position: monaco.Position, token: monaco.CancellationToken) => {
        if (!this.has(model)) return null
        const r = await this.request(method, { textDocument: doc(model), position: toPos(position) }, token)
        return this.toLocations(r)
      }
      if (c.definitionProvider) this.providers.push(L.registerDefinitionProvider(lang, { provideDefinition: locationProvider('textDocument/definition') }))
      if (c.typeDefinitionProvider) this.providers.push(L.registerTypeDefinitionProvider(lang, { provideTypeDefinition: locationProvider('textDocument/typeDefinition') }))
      if (c.implementationProvider) this.providers.push(L.registerImplementationProvider(lang, { provideImplementation: locationProvider('textDocument/implementation') }))

      if (c.referencesProvider) {
        this.providers.push(
          L.registerReferenceProvider(lang, {
            provideReferences: async (model, position, context, token) => {
              if (!this.has(model)) return null
              const r = await this.request('textDocument/references', { textDocument: doc(model), position: toPos(position), context: { includeDeclaration: context.includeDeclaration } }, token)
              return this.toLocations(r)
            }
          })
        )
      }

      if (c.documentHighlightProvider) {
        this.providers.push(
          L.registerDocumentHighlightProvider(lang, {
            provideDocumentHighlights: async (model, position, token) => {
              if (!this.has(model)) return null
              const r = await this.request('textDocument/documentHighlight', { textDocument: doc(model), position: toPos(position) }, token)
              return (r ?? []).map((x: Json) => ({ range: toRange(x.range), kind: x.kind ? x.kind - 1 : monaco.languages.DocumentHighlightKind.Text }))
            }
          })
        )
      }

      if (c.documentSymbolProvider) {
        const toSymbol = (s: Json): monaco.languages.DocumentSymbol => ({
          name: s.name,
          detail: s.detail ?? s.containerName ?? '',
          kind: (s.kind ?? 13) - 1,
          tags: [],
          range: toRange(s.range ?? s.location.range),
          selectionRange: toRange(s.selectionRange ?? s.range ?? s.location.range),
          children: s.children?.map(toSymbol)
        })
        this.providers.push(
          L.registerDocumentSymbolProvider(lang, {
            displayName: this.info.name,
            provideDocumentSymbols: async (model, token) => {
              if (!this.has(model)) return null
              const r = await this.request('textDocument/documentSymbol', { textDocument: doc(model) }, token)
              return (r ?? []).map(toSymbol)
            }
          })
        )
      }

      if (c.renameProvider) {
        const prepare = typeof c.renameProvider === 'object' && c.renameProvider.prepareProvider
        this.providers.push(
          L.registerRenameProvider(lang, {
            provideRenameEdits: async (model, position, newName, token) => {
              if (!this.has(model)) return null
              const r = await this.request('textDocument/rename', { textDocument: doc(model), position: toPos(position), newName }, token)
              return r ? await toMonacoWorkspaceEdit(r) : null
            },
            resolveRenameLocation: prepare
              ? async (model, position, token) => {
                  const reject = { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: '这里没有可以重命名的符号' }
                  if (!this.has(model)) return reject
                  const r = await this.request('textDocument/prepareRename', { textDocument: doc(model), position: toPos(position) }, token)
                  if (!r) return reject
                  if (r.range) return { range: toRange(r.range), text: r.placeholder ?? model.getValueInRange(toRange(r.range)) }
                  if (r.start) return { range: toRange(r), text: model.getValueInRange(toRange(r)) }
                  const w = model.getWordAtPosition(position)
                  return w ? { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), text: w.word } : reject
                }
              : undefined
          })
        )
      }

      if (c.documentFormattingProvider) {
        this.providers.push(
          L.registerDocumentFormattingEditProvider(lang, {
            displayName: this.info.name,
            provideDocumentFormattingEdits: async (model, options, token) => {
              if (!this.has(model)) return null
              const r = await this.request('textDocument/formatting', { textDocument: doc(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }, token)
              return (r ?? []).map(toTextEdit)
            }
          })
        )
      }

      if (c.documentRangeFormattingProvider) {
        this.providers.push(
          L.registerDocumentRangeFormattingEditProvider(lang, {
            displayName: this.info.name,
            provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
              if (!this.has(model)) return null
              const r = await this.request(
                'textDocument/rangeFormatting',
                { textDocument: doc(model), range: fromRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
                token
              )
              return (r ?? []).map(toTextEdit)
            }
          })
        )
      }
    }
  }

  private toSuggestion(it: Json, fallback: monaco.IRange, defaults: Json): monaco.languages.CompletionItem {
    let range: monaco.languages.CompletionItem['range'] = fallback
    let insertText: string = it.insertText ?? it.label
    const te = it.textEdit
    if (te?.range) {
      range = toRange(te.range)
      insertText = te.newText
    } else if (te?.insert) {
      range = { insert: toRange(te.insert), replace: toRange(te.replace) }
      insertText = te.newText
    } else if (defaults?.editRange) {
      const er = defaults.editRange
      range = er.insert ? { insert: toRange(er.insert), replace: toRange(er.replace) } : toRange(er)
      insertText = it.textEditText ?? insertText
    }
    const snippet = (it.insertTextFormat ?? defaults?.insertTextFormat) === 2
    const cmd = it.command?.command
    const item: monaco.languages.CompletionItem = {
      label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
      kind: COMPLETION_KIND[it.kind] ?? K.Text,
      insertText,
      insertTextRules: snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      range,
      detail: it.detail,
      documentation: toDoc(it.documentation),
      sortText: it.sortText,
      filterText: it.filterText,
      preselect: it.preselect,
      commitCharacters: it.commitCharacters ?? defaults?.commitCharacters,
      additionalTextEdits: it.additionalTextEdits?.map(toTextEdit),
      tags: it.deprecated || it.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
      command: cmd === 'editor.action.triggerParameterHints' || cmd === 'editor.action.triggerSuggest' ? { id: cmd, title: it.command.title } : undefined
    }
    ;(item as Json)._lsp = defaults?.data !== undefined && it.data === undefined ? { ...it, data: defaults.data } : it
    return item
  }

  private async toLocations(r: Json): Promise<monaco.languages.Location[]> {
    if (!r) return []
    const out: monaco.languages.Location[] = []
    for (const l of Array.isArray(r) ? r : [r]) {
      const uri = l.targetUri ?? l.uri
      const range = l.targetSelectionRange ?? l.range
      if (!uri || !range) continue
      const model = await ensureModel(uri)
      if (model) out.push({ uri: model.uri, range: toRange(range) })
    }
    return out
  }

  private disposeAll(): void {
    clearTimeout(this.pullTimer)
    for (const d of this.providers) d.dispose()
    this.providers = []
    for (const [model, sub] of this.docs) {
      sub.dispose()
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, this.owner, [])
    }
    this.docs.clear()
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return
    const wasReady = this.status === 'ready'
    if (wasReady) {
      try {
        await Promise.race([this.request('shutdown', null), new Promise((r) => setTimeout(r, 1000))])
      } catch {
        /* 忽略 */
      }
      this.notify('exit', null)
    }
    this.status = 'stopped'
    this.disposeAll()
    if (this.session >= 0) window.api.lsp.stop(this.session)
    sessions.delete(this.session)
    emit('lsp')
  }
}

/* ---------------- 工作区编辑 ---------------- */

/** 把 LSP 的 WorkspaceEdit 拆成 文件 → 编辑列表；涉及的文件会作为标签在后台打开（改动后显示未保存，由你决定是否保存） */
async function collectEdits(we: Json): Promise<{ model: Model; edits: monaco.languages.TextEdit[] }[]> {
  const byUri = new Map<string, Json[]>()
  if (we.changes) for (const [uri, edits] of Object.entries(we.changes)) byUri.set(uri, edits as Json[])
  let skipped = 0
  for (const dc of we.documentChanges ?? []) {
    if (dc.kind) {
      skipped++
      continue
    }
    byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) ?? []), ...dc.edits])
  }
  if (skipped) toast(`有 ${skipped} 个创建 / 重命名 / 删除文件的操作暂不支持，已跳过`)
  const out: { model: Model; edits: monaco.languages.TextEdit[] }[] = []
  for (const [uri, edits] of byUri) {
    const path = normPath(monaco.Uri.parse(uri).fsPath)
    const tab = findTab(path) ?? (await openFile(path, { activate: false }))
    if (tab) out.push({ model: tab.model, edits: edits.map(toTextEdit) })
  }
  return out
}

async function toMonacoWorkspaceEdit(we: Json): Promise<monaco.languages.WorkspaceEdit> {
  const groups = await collectEdits(we)
  return { edits: groups.flatMap(({ model, edits }) => edits.map((textEdit) => ({ resource: model.uri, textEdit, versionId: undefined }))) }
}

async function applyWorkspaceEdit(we: Json): Promise<void> {
  for (const { model, edits } of await collectEdits(we)) {
    model.pushEditOperations([], edits.map((e) => ({ range: e.range, text: e.text })), () => null)
  }
}

/* ---------------- 管理 ---------------- */

const sessions = new Map<number, Client>()
let clients = new Map<string, Client>()
let available: LspServerInfo[] | null = null
let attachedRoot: string | null = null

async function serverFor(languageId: string): Promise<LspServerInfo | undefined> {
  available ??= await window.api.lsp.servers().catch(() => [])
  return available.find((s) => s.languages.includes(languageId))
}

function clientOf(model: Model): Client | undefined {
  return [...clients.values()].find((c) => c.info.languages.includes(model.getLanguageId()))
}

async function attach(model: Model): Promise<void> {
  const root = state.root
  if (!root) return
  const info = await serverFor(model.getLanguageId())
  if (!info || model.isDisposed() || state.root !== root) return
  let c = clients.get(info.id)
  if (!c || c.status === 'failed' || c.status === 'stopped') {
    if (c?.status === 'failed') return // 失败过就不反复重启，等用户手动重启
    c = new Client(info, root)
    clients.set(info.id, c)
  }
  try {
    await c.ready
  } catch {
    return
  }
  if (!model.isDisposed() && (findTab(normPath(model.uri.fsPath))?.model === model || probes.has(model))) c.open(model)
}

/* ---------------- 后台检查（IDE 桥接用） ---------------- */

/**
 * 没有打开标签的文件也交给语言服务检查（相当于 VS Code 的 openTextDocument）：
 * Claude 修改文件前后要对比诊断，而语言服务只分析打开的文档。
 * 引用计数；最后一个使用者释放时关闭文档，模型如果是这里建的也一并释放。
 */
const probes = new Map<Model, { refs: number; created: boolean }>()

export function isProbe(model: Model): boolean {
  return probes.has(model)
}

export async function probeFile(path: string): Promise<(() => void) | null> {
  const p = normPath(path)
  const uri = monaco.Uri.file(p)
  let model = findModel(uri.toString())
  let created = false
  if (!model) {
    const r = await window.api.fs.readFile(p)
    if (!r.ok) return null
    model = findModel(uri.toString())
    if (!model) {
      model = monaco.editor.createModel(r.content, languageFor(p), uri)
      created = true
    }
  }
  const entry = probes.get(model) ?? { refs: 0, created }
  entry.refs++
  probes.set(model, entry)
  await attach(model)
  const m = model
  let released = false
  return () => {
    if (released) return
    released = true
    const e = probes.get(m)
    if (!e || --e.refs > 0) return
    probes.delete(m)
    if (m.isDisposed() || tabs.some((t) => t.model === m)) return
    clientOf(m)?.close(m)
    if (e.created) m.dispose()
  }
}

/** 磁盘上的文件变了：后台检查的模型重新读入（标签页由 reloadFromDisk 处理） */
export async function refreshProbe(path: string): Promise<boolean> {
  const model = findModel(monaco.Uri.file(normPath(path)).toString())
  if (!model || !probes.has(model) || tabs.some((t) => t.model === model)) return false
  const r = await window.api.fs.readFile(normPath(path))
  if (!r.ok || model.isDisposed()) return false
  if (model.getValue(monaco.editor.EndOfLinePreference.TextDefined) === r.content) return false
  model.setValue(r.content)
  return true
}

/** 这个模型是否有语言服务在检查 */
export function isChecked(model: Model): boolean {
  return !!clientOf(model)?.has(model)
}

export function initLsp(): void {
  window.api.lsp.onMessage((session, msg) => sessions.get(session)?.handle(msg))
  window.api.lsp.onExit((session, code, stderr) => sessions.get(session)?.onExit(code, stderr))
  onTab('opened', (t) => void attach(t.model))
  onTab('closed', (t) => clientOf(t.model)?.close(t.model))
  onTab('saved', (t) => clientOf(t.model)?.save(t.model))
}

/** 打开 / 切换文件夹时调用：旧项目的语言服务全部停掉 */
export async function setLspRoot(root: string | null): Promise<void> {
  if (attachedRoot === root) return
  attachedRoot = root
  const old = clients
  clients = new Map()
  await Promise.all([...old.values()].map((c) => c.stop()))
}

export async function restartLsp(): Promise<void> {
  const old = clients
  clients = new Map()
  available = null
  await Promise.all([...old.values()].map((c) => c.stop()))
  for (const t of tabs) void attach(t.model)
  toast('语言服务已重启')
}

/** 调试用：直接向某个语言服务发请求 */
export function debugRequest(serverId: string, method: string, params: Json): Promise<Json> {
  return clients.get(serverId)?.request(method, params) ?? Promise.resolve('no client')
}

/** 当前文件对应的语言服务状态，用于状态栏 */
export function lspStatus(languageId: string): { name: string; status: Status } | null {
  const c = [...clients.values()].find((x) => x.info.languages.includes(languageId))
  if (c) return { name: c.info.name, status: c.status }
  const info = available?.find((s) => s.languages.includes(languageId))
  return info ? { name: info.name, status: 'stopped' } : null
}
