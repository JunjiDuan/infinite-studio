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
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

export type ReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'binary' | 'too-large' | 'error'; message?: string }

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
