import type { FontId, Space, ThemeId } from '../../shared/types'
import { t } from './i18n'

export interface Palette {
  label: string
  bg: string
  panel: string
  line: string
  sel: string
  text: string
  muted: string
  str: string
  light: boolean
  swatch: string
}

export const THEMES: Record<ThemeId, Palette> = {
  dusk: { label: t('深邃'), bg: '#16151B', panel: '#201E27', line: '#2C2A35', sel: '#221F2A', text: '#ECE7F2', muted: '#9A95A6', str: '#CBBFD9', light: false, swatch: '#3A3546' },
  graphite: { label: t('石墨'), bg: '#1E1F22', panel: '#2A2B2F', line: '#37383D', sel: '#2E2F34', text: '#E3E4E6', muted: '#94969C', str: '#BEC3CA', light: false, swatch: '#55575D' },
  ink: { label: t('深色'), bg: '#0E0E10', panel: '#18181B', line: '#26262B', sel: '#1C1C20', text: '#E7E5E0', muted: '#8E8D93', str: '#C9C2B4', light: false, swatch: '#2A2A2E' },
  paper: { label: t('浅色'), bg: '#F7F5F0', panel: '#EDEAE3', line: '#E0DCD3', sel: '#EAE6DD', text: '#1D1C1A', muted: '#6B6760', str: '#5E5546', light: true, swatch: '#E9E4D9' },
  forest: { label: t('松林'), bg: '#131A17', panel: '#1B2420', line: '#27322D', sel: '#1E2723', text: '#E2EAE5', muted: '#8E9F95', str: '#B4CCBD', light: false, swatch: '#2E3D35' },
  tide: { label: t('深海'), bg: '#111821', panel: '#19222D', line: '#25303D', sel: '#1C2530', text: '#E2E8F0', muted: '#8A96A7', str: '#B2C3D7', light: false, swatch: '#2B3A4E' },
  mocha: { label: t('摩卡'), bg: '#1A1613', panel: '#241F1B', line: '#332B25', sel: '#28221D', text: '#EDE4DA', muted: '#A09488', str: '#D6C1AA', light: false, swatch: '#4A3C31' },
  mist: { label: t('雾蓝'), bg: '#F1F3F6', panel: '#E6E9EE', line: '#D7DCE3', sel: '#E1E5EB', text: '#1A1E24', muted: '#5D6571', str: '#3F5470', light: true, swatch: '#D5DDE8' }
}

export const ACCENTS: { hex: string; name: string }[] = [
  { hex: '#6E9BFF', name: t('蓝') },
  { hex: '#E8784A', name: t('橙') },
  { hex: '#7FBF7A', name: t('绿') },
  { hex: '#C99BFF', name: t('紫') },
  { hex: '#E5C15C', name: t('金') },
  { hex: '#5FC4C0', name: t('青') }
]

export const FONTS: Record<FontId, { name: string; css: string }> = {
  jet: { name: 'JetBrains Mono', css: "'JetBrains Mono', 'Microsoft YaHei UI', monospace" },
  plex: { name: 'IBM Plex Mono', css: "'IBM Plex Mono', 'Microsoft YaHei UI', monospace" },
  space: { name: 'Space Mono', css: "'Space Mono', 'Microsoft YaHei UI', monospace" }
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a)
  const y = rgb(b)
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

/** 把用户选的强调色调整到在当前背景上可读（对比度 ≥ 4.5） */
export function readableAccent(accent: string, bg: string): string {
  const target = luminance(bg) > 0.5 ? '#000000' : '#FFFFFF'
  for (let t = 0; t <= 1; t += 0.04) {
    const c = mix(accent, target, t)
    if (contrast(c, bg) >= 4.5) return c
  }
  return target
}

export function isHex(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s)
}

export interface ResolvedTheme extends Palette {
  accent: string
  fontCss: string
}

export function resolve(space: Space): ResolvedTheme {
  const p = THEMES[space.theme]
  return { ...p, accent: readableAccent(space.accent, p.bg), fontCss: FONTS[space.font].css }
}

/** 把空间写进 CSS 变量，整个界面跟着变 */
export function applyCssVars(space: Space): ResolvedTheme {
  const t = resolve(space)
  const s = document.documentElement.style
  s.setProperty('--bg', t.bg)
  s.setProperty('--panel', t.panel)
  s.setProperty('--line', t.line)
  s.setProperty('--sel', t.sel)
  s.setProperty('--text', t.text)
  s.setProperty('--muted', t.muted)
  s.setProperty('--accent', t.accent)
  s.setProperty('--accent-soft', t.accent + '2E')
  s.setProperty('--font-code', t.fontCss)
  s.setProperty('--shadow', t.light ? (space.theme === 'mist' ? 'rgba(30, 40, 60, 0.14)' : 'rgba(60, 50, 30, 0.14)') : 'rgba(0, 0, 0, 0.55)')
  document.documentElement.dataset.theme = space.theme
  document.documentElement.dataset.tone = t.light ? 'light' : 'dark'
  document.documentElement.style.colorScheme = t.light ? 'light' : 'dark'
  return t
}
