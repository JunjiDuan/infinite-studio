import type { AgentStart, ClaudeLoginMethod, LoginEvent, SessionInfo, DailyUsage } from './agents'
import type { IdeToolResult } from './ide'
import type { MarketResult, PluginManifest, PluginStatus, RemotePlugin, RunPlan } from './plugins'

export type ThemeId = 'dusk' | 'ink' | 'graphite' | 'paper'
export type FontId = 'jet' | 'plex' | 'space'

/** 外观 = 主题 + 强调色 + 字体 + 字号 */
export interface Space {
  theme: ThemeId
  accent: string
  font: FontId
  size: number
}

export interface Settings {
  space: Space
  recentFolders: string[]
  wordWrap: boolean
  /** 终端面板高度（px） */
  panelHeight?: number
  /** 侧栏宽度（px） */
  sidebarWidth?: number
  /** 对话面板宽度（px） */
  chatWidth?: number
  /** 插件 id → 对话面板选择的模式 */
  agentModes?: Record<string, string>
  /** 插件 id → 对话面板选择的模型和思考强度 */
  agentPrefs?: Record<string, { model?: string; effort?: string }>
  /** 发消息时自动附带当前文件 / 选中内容 */
  agentContext?: boolean
  /** 插件 id → 是否启用（未记录视为启用） */
  plugins?: Record<string, boolean>
  /** 界面语言 */
  locale?: 'zh' | 'en'
  /** 项目路径 → 资源管理器里展开的文件夹（相对路径） */
  treeExpanded?: Record<string, string[]>
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  os: string
  homepage: string
}

export type UpdateResult =
  | { status: 'available' | 'latest'; current: string; latest: string; url: string; notes?: string; date?: string }
  | { status: 'none'; current: string; url: string }
  | { status: 'error'; current: string; message: string }

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export type TextEncodingName = 'utf8' | 'gbk'

/** 文本文件的编码信息：保存时按原编码写回 */
export interface TextEncodingInfo {
  encoding: TextEncodingName
  bom: boolean
}

export type ReadResult =
  | ({ ok: true; content: string; /** 不是有效的 UTF-8 / GBK，无效字节已替换成 U+FFFD */ lossy?: boolean } & TextEncodingInfo)
  | { ok: false; reason: 'binary' | 'too-large' | 'missing' | 'error'; message?: string }

export type BinaryResult =
  | { ok: true; data: Uint8Array; size: number }
  | { ok: false; reason: 'too-large' | 'missing' | 'error'; size?: number; message?: string }

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface SearchMatch {
  /** 1 起始 */
  line: number
  col: number
  len: number
  /** 匹配附近的一段文本，匹配从 preview[at] 开始 */
  preview: string
  at: number
}

export interface SearchFile {
  path: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFile[]
  total: number
  truncated: boolean
  error?: string
}

export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  email: string
  /** 毫秒时间戳 */
  time: number
  /** 例如 HEAD -> main、origin/main、tag: v1.0 */
  refs: string[]
  subject: string
}

export type GitLog = { ok: true; commits: GitCommit[] } | { ok: false; reason: 'no-git' | 'not-repo' | 'error'; message?: string }

export interface GitChange {
  /** A / M / D / R / C … */
  status: string
  path: string
  /** 重命名前的路径 */
  from?: string
}

/** 工作区里一个有改动的文件（路径相对仓库根目录） */
export interface GitFile {
  path: string
  /** M 修改 / A 新增 / D 删除 / R 重命名 / C 复制 / T 类型变更 / U 未跟踪 / ! 冲突 */
  status: string
  from?: string
}

export type GitStatus =
  | {
      ok: true
      /** 当前分支；分离 HEAD 时为 null */
      branch: string | null
      detached: boolean
      upstream: string | null
      ahead: number
      behind: number
      /** 暂存的更改 */
      staged: GitFile[]
      /** 工作区的更改（含未跟踪） */
      changes: GitFile[]
      /** 合并冲突 */
      conflicts: GitFile[]
      hasCommits: boolean
    }
  | { ok: false; reason: 'no-git' | 'not-repo' | 'error'; message?: string }

export type GitOp = 'push' | 'pull' | 'fetch' | 'sync' | 'undoCommit' | 'stash' | 'stashPop'

export interface GitBranch {
  name: string
  current: boolean
  remote: boolean
}

export interface LspServerInfo {
  id: string
  name: string
  /** 对应的 Monaco 语言 id */
  languages: string[]
}

export interface Account {
  provider: 'github'
  login: string
  name: string
  url: string
  /** 头像 data URL */
  avatar?: string
}

export interface DeviceCode {
  userCode: string
  url: string
}

/* ---------------- 系统监视器 ---------------- */

export interface SysGpu {
  id: string
  name: string
  /** 只做计算的设备（NPU） */
  npu: boolean
  /** 总占用：最忙的一类引擎，和任务管理器一致；null 表示读不到 */
  util: number | null
  /** 各类引擎的占用（3D、Copy、VideoDecode、Compute、Neural…） */
  engines: Record<string, number>
  dedicatedUsed: number | null
  dedicatedTotal: number
  sharedUsed: number | null
  sharedTotal: number
  temp: number | null
}

export interface SysDisk {
  name: string
  /** 活动时间百分比 */
  active: number | null
  read: number | null
  write: number | null
  volumes: { mount: string; total: number; free: number }[]
}

export interface SysNet {
  name: string
  rx: number
  tx: number
  bandwidth: number
}

export interface SysProc {
  type: string
  name: string
  pid: number
  cpu: number
  mem: number
}

export interface SysSample {
  t: number
  os: { platform: string; release: string; arch: string; host: string; uptime: number }
  cpu: {
    model: string
    logical: number
    /** 基准频率 MHz */
    baseMHz: number
    /** 当前频率 MHz；读不到为 null */
    curMHz: number | null
    usage: number
    cores: number[]
    processes: number | null
    threads: number | null
    handles: number | null
    temp: number | null
    load: number[] | null
  }
  mem: {
    total: number
    free: number
    committed: number | null
    commitLimit: number | null
    standby: number | null
    modified: number | null
    paged: number | null
    nonpaged: number | null
    pagefile: number | null
  }
  gpus: SysGpu[]
  disks: SysDisk[]
  nets: SysNet[]
  /** 本 IDE 自己的进程 */
  app: { cpu: number; mem: number; procs: SysProc[] }
}

export interface Api {
  platform: string
  /** 设置里选的界面语言；没选过为 null */
  locale: 'zh' | 'en' | null
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** 重新创建窗口（切换界面语言后） */
    reload(): void
    /** 新开一个空白 IDE 窗口 */
    newWindow(): void
  }
  app: {
    info(): Promise<AppInfo>
    checkUpdate(): Promise<UpdateResult>
  }
  fs: {
    openFolderDialog(): Promise<string | null>
    readDir(dir: string): Promise<DirEntry[]>
    readFile(path: string): Promise<ReadResult>
    /** enc 不传时按 UTF-8（无 BOM）写 */
    writeFile(path: string, content: string, enc?: TextEncodingInfo): Promise<void>
    /** 读二进制内容（文档 / 图片 / 音视频预览用） */
    readBinary(path: string): Promise<BinaryResult>
    writeBinary(path: string, data: Uint8Array): Promise<void>
    /** 用系统默认应用打开；成功返回空字符串，否则是错误信息 */
    openPath(path: string): Promise<string>
    listFiles(root: string): Promise<string[]>
    gitBranch(root: string): Promise<string | null>
    /** 在 dir 下新建文件 / 文件夹，返回完整路径 */
    createFile(dir: string, name: string): Promise<string>
    createDir(dir: string, name: string): Promise<string>
    /** 同目录改名，返回新路径 */
    rename(from: string, newName: string): Promise<string>
    /** 移到回收站 */
    trash(path: string): Promise<void>
    reveal(path: string): Promise<void>
    /** 递归监听；传 null 停止 */
    watch(root: string | null): Promise<void>
    onChanged(cb: (paths: string[]) => void): () => void
  }
  term: {
    create(opts: { cwd?: string; cols: number; rows: number }): Promise<{ id: number; shell: string }>
    write(id: number, data: string): void
    resize(id: number, cols: number, rows: number): void
    kill(id: number): void
    onData(cb: (id: number, data: string) => void): () => void
    onExit(cb: (id: number, code: number) => void): () => void
  }
  lsp: {
    /** 本机可用的语言服务 */
    servers(): Promise<LspServerInfo[]>
    start(serverId: string, root: string): Promise<number>
    send(session: number, msg: unknown): void
    stop(session: number): void
    onMessage(cb: (session: number, msg: unknown) => void): () => void
    onExit(cb: (session: number, code: number, stderr: string) => void): () => void
  }
  git: {
    /** 所有分支的提交（按时间倒序） */
    log(root: string, limit: number): Promise<GitLog>
    /** 某个提交改动的文件（相对 root） */
    changes(root: string, hash: string): Promise<GitChange[]>
    status(root: string): Promise<GitStatus>
    init(root: string): Promise<void>
    /** paths 为 null 时处理全部 */
    stage(root: string, paths: string[] | null): Promise<void>
    unstage(root: string, paths: string[] | null): Promise<void>
    /** 放弃修改：tracked 从暂存区恢复，untracked 移到回收站 */
    discard(root: string, tracked: string[], untracked: string[]): Promise<void>
    commit(root: string, message: string, opts?: { amend?: boolean }): Promise<void>
    run(root: string, op: GitOp): Promise<void>
    /** ref：'HEAD'、提交 hash、hash^，或 ':' 表示暂存区 */
    show(root: string, ref: string, path: string): Promise<string>
    lastMessage(root: string): Promise<string>
    branches(root: string): Promise<GitBranch[]>
    checkout(root: string, name: string, opts?: { create?: boolean; remote?: boolean }): Promise<void>
  }
  search: {
    /** 返回 null 表示已被更新的搜索取代 */
    run(id: number, root: string, query: string, opts: SearchOptions): Promise<SearchResult | null>
    replace(query: string, opts: SearchOptions, replacement: string, files: string[]): Promise<{ files: number; replaced: number }>
  }
  settings: {
    load(): Promise<Settings | null>
    /** 只传改动过的顶层字段，主进程合并进磁盘上的设置（多个窗口不会互相覆盖） */
    save(patch: Partial<Settings>): Promise<void>
  }
  /** 插件市场：从 GitHub 插件仓库安装的插件 */
  market: {
    registry(force?: boolean): Promise<MarketResult<RemotePlugin[]>>
    installed(): Promise<PluginManifest[]>
    install(id: string): Promise<MarketResult<PluginManifest>>
    uninstall(id: string): Promise<MarketResult<void>>
    /** 另存为对话框；取消时返回 null */
    exportFile(name: string, data: Uint8Array | string): Promise<string | null>
    /** 插件接口 v2 */
    stat(path: string): Promise<{ type: 'file' | 'dir'; size: number; mtime: number } | null>
    mkdirp(path: string): Promise<void>
    move(from: string, to: string): Promise<void>
    /** 打开对话框，返回用户选的路径（取消时为空数组） */
    openFiles(opts: { title?: string; extensions?: string[]; multiple?: boolean; directory?: boolean }): Promise<string[]>
    /** 读取用户在对话框里选的文件（不限工作区） */
    readExternal(path: string): Promise<Uint8Array>
    clipboard(pluginId: string, op: 'read' | 'write', text?: string): Promise<string | boolean>
    fetch(
      pluginId: string,
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeout?: number }
    ): Promise<{ status: number; statusText: string; url: string; headers: Record<string, string>; body: Uint8Array }>
    onProgress(cb: (id: string, received: number, total: number) => void): () => void
  }
  plugins: {
    /** 检测插件对应的命令行工具是否已安装 */
    detect(id: string): Promise<PluginStatus>
    /** 编程语言插件：在终端里运行这个文件的命令 */
    runPlan(id: string, file: string): Promise<RunPlan | { error: string }>
  }
  debug: {
    /** 准备调试（需要时先编译）并启动调试适配器；之后页面用 DAP 和适配器对话 */
    start(pluginId: string, file: string): Promise<DebugStart>
    send(session: number, msg: unknown): void
    stop(session: number): void
    onMessage(cb: (session: number, msg: unknown) => void): () => void
    onExit(cb: (session: number, code: number) => void): () => void
  }
  jupyter: {
    /** 为某个 .ipynb 启动 Jupyter 内核（经 Python 的 jupyter_client 桥接） */
    start(opts: JupyterStartOpts): Promise<JupyterStart>
    send(session: number, msg: JupyterCommand): void
    stop(session: number): void
    onEvent(cb: (session: number, ev: JupyterEvent) => void): () => void
    onExit(cb: (session: number, code: number, stderr: string) => void): () => void
  }
  sysmon: {
    /** 开始接收采样（视图打开时调用），返回取消函数 */
    subscribe(cb: (s: SysSample) => void): () => void
  }
  agent: {
    /** 启动对话进程，返回运行 id；进程输出的每行 JSON 通过 onEvent 推送 */
    start(req: AgentStart): Promise<number>
    /** 向进程写一条协议消息（主进程会校验类型） */
    write(runId: number, msg: Record<string, unknown>): void
    stop(runId: number): void
    /** 本地历史会话（Claude） */
    sessions(plugin: string, cwd: string | null): Promise<SessionInfo[]>
    /** 读取一个历史会话的消息（Claude；DeepSeek 返回转换好的 ACP session/update） */
    transcript(plugin: string, cwd: string | null, id: string): Promise<Record<string, unknown>[]>
    /** 把粘贴的图片存成临时文件，返回路径（Codex） */
    saveImage(dataUrl: string): Promise<string>
    onEvent(cb: (runId: number, ev: Record<string, unknown>) => void): () => void
    onExit(cb: (runId: number, code: number, stderr: string) => void): () => void
    /** Claude：运行 `claude auth login`，返回登录流程 id；进度通过 onLogin 推送 */
    claudeLogin(method: ClaudeLoginMethod): Promise<number>
    /** 向登录流程输入授权码 */
    loginWrite(loginId: number, text: string): void
    loginCancel(loginId: number): void
    onLogin(cb: (loginId: number, ev: LoginEvent) => void): () => void
    /** Claude：`claude auth logout` */
    claudeLogout(): Promise<void>
    /** Kimi：运行 `kimi login`（设备码），返回登录流程 id；进度通过 onLogin 推送 */
    kimiLogin(): Promise<number>
    /** DeepSeek：是否配置了 API Key（只返回掩码） */
    deepseekKeyStatus(): Promise<{ configured: boolean; masked?: string; source?: 'file' | 'env' }>
    /** DeepSeek：保存 API Key 到 ~/.dsh/.credentials.yaml；null 删除 */
    setDeepseekKey(key: string | null): Promise<void>
    /** DeepSeek：从本地日志读会话标题和更新时间（空会话不返回） */
    deepseekSessionMeta(ids: string[]): Promise<Record<string, { title: string; updatedAt: number }>>
    /** 按天汇总本地会话记录里的 token 消耗 */
    dailyUsage(plugin: string): Promise<DailyUsage>
  }
  /** IDE 桥接：终端里的 claude 通过主进程的 WebSocket 服务调用这里的工具 */
  ide: {
    /** 登记为执行工具的窗口 */
    register(): void
    onCall(cb: (id: number, tool: string, args: Record<string, unknown>) => void): () => void
    /** 调用被取消（claude 不再等结果，例如在终端里回答了授权） */
    onCancel(cb: (id: number) => void): () => void
    /** 是否有终端里的 claude 连着 */
    onStatus(cb: (connected: boolean) => void): () => void
    result(id: number, r: IdeToolResult): void
    setWorkspace(folders: string[]): void
    selection(sel: Record<string, unknown>): void
    /** 向连着的 claude 发送“插入引用”；没有连接时返回 false */
    atMention(params: Record<string, unknown>): Promise<boolean>
  }
  account: {
    get(): Promise<Account | null>
    /** 是否配置了 OAuth Client ID，可用浏览器登录 */
    hasDeviceFlow(): Promise<boolean>
    loginToken(token: string): Promise<Account>
    /** 复用 GitHub CLI 的登录 */
    loginGh(): Promise<Account>
    deviceStart(): Promise<DeviceCode>
    /** 等待用户在浏览器授权；被取消时返回 null */
    devicePoll(): Promise<Account | null>
    deviceCancel(): Promise<void>
    logout(): Promise<void>
  }
}

export type DebugStart =
  | { ok: true; id: number; adapterId: string; launch: Record<string, unknown> }
  | { ok: false; error: string; output?: string }

/* ---------------- Jupyter ---------------- */

export interface JupyterStartOpts {
  /** Notebook 文件路径（内核的工作目录是它所在的文件夹，并在上级目录里找虚拟环境） */
  file: string
  /** kernelspec 名称，比如 python3 */
  kernel: string
  /** 工作区根目录：找虚拟环境时不越过它 */
  root?: string | null
}

export type JupyterStart =
  | { ok: true; session: number; python: string }
  | { ok: false; reason: 'no-python'; detail?: string }

export type JupyterCommand =
  | { cmd: 'execute'; id: number; code: string }
  | { cmd: 'complete'; id: number; code: string; pos: number }
  | { cmd: 'input'; value: string }
  | { cmd: 'interrupt' }
  | { cmd: 'restart' }
  | { cmd: 'shutdown' }

export type JupyterEvent =
  /** 内核已就绪；info 是 kernel_info_reply 的内容 */
  | { type: 'ready'; info: Record<string, unknown>; kernel: string; fallback?: string }
  /** 请求已发出：客户端编号 → 内核消息 ID */
  | { type: 'sent'; id: number; msg_id: string }
  | { type: 'iopub' | 'shell' | 'stdin'; parent: string | null; msg_type: string; content: Record<string, unknown> }
  | { type: 'restarted' }
  | { type: 'dead' }
  /** missing：缺少 jupyter_client / ipykernel；install 是在终端里安装它们的命令 */
  | { type: 'fatal'; reason: 'missing' | 'nokernel' | 'start'; detail: string; install?: string }
  | { type: 'log'; text: string }
