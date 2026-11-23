import { EN } from './i18n-en'

/* ---------------- 界面语言：中文 / English / 语言包插件提供的其他语言 ---------------- */

/** zh / en，或语言包的 BCP 47 代码（例如 es、ja） */
export type Locale = string

/** 当前语言包（主进程启动窗口时读好的翻译表）；界面是中文 / 英文时为 null */
const pack = window.api.localePack

function initial(): Locale {
  const saved = window.api.locale
  if (saved === 'zh' || saved === 'en') return saved
  if (saved && pack?.code === saved) return saved
  return /^zh/i.test(navigator.language) ? 'zh' : 'en'
}

let locale: Locale = initial()
/** 当前语言用的翻译表：英文用内置的 EN，其他语言用语言包 */
const dict: Record<string, string> | null = locale === 'zh' ? null : locale === 'en' ? EN : (pack?.strings ?? EN)
document.documentElement.lang = localeTag()

export function getLocale(): Locale {
  return locale
}

/** 当前界面语言的 BCP 47 标签（给 Intl、lang 属性用） */
export function localeTag(l: Locale = locale): string {
  return l === 'zh' ? 'zh-CN' : l === 'en' ? 'en' : l
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
  // 同一个中文在不同场合译法不同时，键写成“原文##场合”，中文界面只显示原文。
  // 语言包里缺的条目（IDE 新加的文本）先显示英文
  const s = (dict && (dict[zh] || EN[zh])) || zh.replace(/##.*$/, '')
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s
}

/** 复数：tn(n, '{0} 个文件', ...) 在英文等语言下按 n 选 file / files（表里写成 "{0} file|{0} files"） */
export function tn(n: number, zh: string, ...args: unknown[]): string {
  const s = t(zh, n, ...args)
  if (locale === 'zh' || !s.includes('|')) return s
  const [one, many] = s.split('|')
  return n === 1 ? one : many
}

/** 本地化的日期时间 */
export function fmtDate(d: Date | number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleString(locale === 'en' ? 'en-US' : localeTag(), opts)
}
