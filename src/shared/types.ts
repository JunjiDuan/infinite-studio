export type ThemeId = 'ink' | 'paper' | 'dusk'
export type FontId = 'jet' | 'plex' | 'space'
export type LayoutId = 'classic' | 'minimal' | 'focus'

/** 一个“空间”= 主题 + 强调色 + 字体 + 字号 + 布局 */
export interface Space {
  name: string
  theme: ThemeId
  accent: string
  font: FontId
  size: number
  layout: LayoutId
}

export interface Settings {
  space: Space
  savedSpaces: Space[]
  /** 项目路径 → 绑定的空间 */
  bindings: Record<string, Space>
  recentFolders: string[]
  wordWrap: boolean
  /** 终端面板高度（px） */
  panelHeight?: number
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export type ReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'binary' | 'too-large' | 'missing' | 'error'; message?: string }

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

export interface Api {
  platform: string
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
  }
  fs: {
    openFolderDialog(): Promise<string | null>
    readDir(dir: string): Promise<DirEntry[]>
    readFile(path: string): Promise<ReadResult>
    writeFile(path: string, content: string): Promise<void>
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
  search: {
    /** 返回 null 表示已被更新的搜索取代 */
    run(id: number, root: string, query: string, opts: SearchOptions): Promise<SearchResult | null>
    replace(query: string, opts: SearchOptions, replacement: string, files: string[]): Promise<{ files: number; replaced: number }>
  }
  settings: {
    load(): Promise<Settings | null>
    save(s: Settings): Promise<void>
  }
  space: {
    export(space: Space): Promise<boolean>
    import(): Promise<Space | null>
  }
}
