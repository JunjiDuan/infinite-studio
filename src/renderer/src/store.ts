import type { FontId, Settings, Space, ThemeId } from '../../shared/types'
import { isHex } from './theme'
import { t } from './i18n'
import { EN } from './i18n-en'

export const PRESETS: Space[] = [
  { name: t('深夜编码'), theme: 'dusk', accent: '#6E9BFF', font: 'jet', size: 14 },
  { name: t('白天文档'), theme: 'paper', accent: '#6E9BFF', font: 'plex', size: 15 },
  { name: t('演示模式'), theme: 'dusk', accent: '#E5C15C', font: 'space', size: 18 }
]

const THEME_IDS: ThemeId[] = ['dusk', 'ink', 'graphite', 'paper']
const FONT_IDS: FontId[] = ['jet', 'plex', 'space']
export const MIN_SIZE = 11
export const MAX_SIZE = 24

/** 预设空间名在另一种语言下保存的，换成当前语言的名字 */
function localName(name: string): string {
  for (const zh of ['深夜编码', '白天文档', '演示模式', '我的空间']) if (name === zh || name === EN[zh]) return t(zh)
  return name
}

export function sanitizeSpace(raw: Partial<Space> | null | undefined, fallback: Space = PRESETS[0]): Space {
  const r = raw ?? {}
  return {
    name: typeof r.name === 'string' && r.name.trim() ? localName(r.name.trim().slice(0, 40)) : fallback.name,
    theme: THEME_IDS.includes(r.theme as ThemeId) ? (r.theme as ThemeId) : fallback.theme,
    accent: isHex(r.accent) ? r.accent.toUpperCase() : fallback.accent,
    font: FONT_IDS.includes(r.font as FontId) ? (r.font as FontId) : fallback.font,
    size: typeof r.size === 'number' ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(r.size))) : fallback.size
  }
}

export function sameLook(a: Space, b: Space): boolean {
  return a.theme === b.theme && a.accent === b.accent && a.font === b.font && a.size === b.size
}

type Topic = 'space' | 'layout' | 'root' | 'tabs' | 'cursor' | 'markers' | 'saved' | 'lsp' | 'debug'

const subs = new Map<Topic, Set<() => void>>()

export function on(topic: Topic, fn: () => void): void {
  if (!subs.has(topic)) subs.set(topic, new Set())
  subs.get(topic)!.add(fn)
}

export function emit(topic: Topic): void {
  subs.get(topic)?.forEach((fn) => fn())
}

export type SideView = 'files' | 'search' | 'scm' | 'plugins' | 'debug' | 'monitor'

export const state = {
  settings: {
    space: { ...PRESETS[0] },
    savedSpaces: [],
    bindings: {},
    recentFolders: [],
    wordWrap: false
  } as Settings,
  root: null as string | null,
  branch: null as string | null,
  /** Ctrl . 临时切换专注；null 表示跟随布局 */
  focusOverride: null as boolean | null,
  /** Ctrl B 临时切换文件栏；null 表示跟随布局 */
  sidebarOverride: null as boolean | null,
  /** 侧栏当前显示的视图 */
  sideView: 'files' as SideView,
  /** 底部终端面板是否展开 */
  panelOpen: false
}

export async function loadSettings(): Promise<void> {
  const s = await window.api.settings.load()
  if (!s) return
  state.settings = {
    space: sanitizeSpace(s.space),
    savedSpaces: Array.isArray(s.savedSpaces) ? s.savedSpaces.map((x) => sanitizeSpace(x)) : [],
    bindings: Object.fromEntries(Object.entries(s.bindings ?? {}).map(([k, v]) => [k, sanitizeSpace(v)])),
    recentFolders: Array.isArray(s.recentFolders) ? s.recentFolders.filter((x) => typeof x === 'string').slice(0, 8) : [],
    wordWrap: !!s.wordWrap,
    panelHeight: typeof s.panelHeight === 'number' ? Math.max(120, Math.min(2000, s.panelHeight)) : undefined,
    sidebarWidth: typeof s.sidebarWidth === 'number' ? Math.max(170, Math.min(800, s.sidebarWidth)) : undefined,
    chatWidth: typeof s.chatWidth === 'number' ? Math.max(300, Math.min(1200, s.chatWidth)) : undefined,
    agentModes: s.agentModes && typeof s.agentModes === 'object' ? { ...s.agentModes } : {},
    agentPrefs: s.agentPrefs && typeof s.agentPrefs === 'object' ? { ...s.agentPrefs } : {},
    agentContext: s.agentContext !== false,
    locale: s.locale === 'zh' || s.locale === 'en' ? s.locale : undefined,
    plugins:
      s.plugins && typeof s.plugins === 'object'
        ? Object.fromEntries(Object.entries(s.plugins).filter(([, v]) => typeof v === 'boolean'))
        : {},
    treeExpanded:
      s.treeExpanded && typeof s.treeExpanded === 'object'
        ? Object.fromEntries(
            Object.entries(s.treeExpanded)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 500)])
          )
        : {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
export function persist(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.api.settings.save(state.settings).catch((e) => console.error('保存设置失败', e))
  }, 300)
}

function knownSpaces(): Space[] {
  return [...PRESETS, ...state.settings.savedSpaces]
}

/** 修改当前空间。外观变了但没起新名字时，名字自动变成“我的空间” */
export function setSpace(patch: Partial<Space>): void {
  const prev = state.settings.space
  const next = sanitizeSpace({ ...prev, ...patch }, prev)
  if (patch.name === undefined) {
    const known = knownSpaces().find((s) => sameLook(s, next))
    if (known) next.name = known.name
    else if (knownSpaces().some((s) => s.name === prev.name)) next.name = t('我的空间')
  }
  state.settings.space = next
  emit('space')
  emit('layout')
  persist()
}

export function isFocus(): boolean {
  return state.focusOverride ?? false
}

export function isSidebarVisible(): boolean {
  if (isFocus()) return false
  // 没打开文件夹时，只有插件和系统监视器视图可以单独打开
  if (!state.root) return (state.sideView === 'plugins' || state.sideView === 'monitor') && state.sidebarOverride === true
  return state.sidebarOverride ?? true
}

export function isRailVisible(): boolean {
  return !isFocus()
}
