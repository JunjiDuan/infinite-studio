type Child = Node | string | null | undefined | false
type Props = Record<string, unknown>

/** 极简的 DOM 构造函数：h('div', { class: 'x', onClick: fn }, child...) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k === 'class') {
      el.className = String(v)
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v)
    } else if (k === 'html') {
      // 仅用于本地写死的 SVG 图标，绝不传入外部内容
      el.innerHTML = String(v)
    } else {
      el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children) if (c != null && c !== false) el.append(c)
  return el
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function relative(root: string, p: string): string {
  if (p.toLowerCase().startsWith(root.toLowerCase())) return p.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
  return p
}

export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : p
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(msg: string): void {
  let el = document.getElementById('toast')
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' })
    document.body.append(el)
  }
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el!.classList.remove('show'), 1800)
}
