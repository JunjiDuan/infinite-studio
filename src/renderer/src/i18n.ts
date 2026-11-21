import { EN } from './i18n-en'

/* ---------------- 界面语言：中文 / English ---------------- */

export type Locale = 'zh' | 'en'

function initial(): Locale {
  const saved = window.api.locale
  if (saved === 'zh' || saved === 'en') return saved
  return /^zh/i.test(navigator.language) ? 'zh' : 'en'
}

let locale: Locale = initial()
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'

export function getLocale(): Locale {
  return locale
}

/** 只记下新的语言（保存在设置里）；界面在重新加载窗口后生效（大部分界面是启动时一次性搭好的） */
export function saveLocale(l: Locale): void {
  locale = l
}

/**
 * 翻译：源文本就是中文原文，英文从 EN 表里查，查不到时显示中文。
 * 参数用 {0} {1} … 占位：t('还有 {0} 行', n)
 */
export function t(zh: string, ...args: unknown[]): string {
  // 同一个中文在不同场合译法不同时，键写成“原文##场合”，中文界面只显示原文
  const s = locale === 'en' ? (EN[zh] ?? zh.replace(/##.*$/, '')) : zh.replace(/##.*$/, '')
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s
}

/** 英文复数：tn(n, '{0} 个文件', ...) 在英文下按 n 选 file / files（表里写成 "{0} file|{0} files"） */
export function tn(n: number, zh: string, ...args: unknown[]): string {
  const s = t(zh, n, ...args)
  if (locale !== 'en' || !s.includes('|')) return s
  const [one, many] = s.split('|')
  return n === 1 ? one : many
}

/** 本地化的日期时间 */
export function fmtDate(d: Date | number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', opts)
}
