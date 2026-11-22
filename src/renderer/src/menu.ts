import { h } from './dom'

export type MenuItem = { label: string; icon?: string; key?: string; danger?: boolean; disabled?: boolean; run: () => void } | 'sep'

let current: HTMLElement | null = null
let onCurrentClose: (() => void) | null = null
let currentOwner: HTMLElement | null = null
/** 刚因按下触发按钮而关闭的菜单所属按钮：紧接着的 click 不再重新打开 */
let justClosedOwner: HTMLElement | null = null

export function closeMenu(): void {
  const el = current
  if (el) {
    // 先淡出再移除；动效关闭时 transitionend 不会触发，用定时器兜底
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 140)
  }
  current = null
  currentOwner = null
  const cb = onCurrentClose
  onCurrentClose = null
  cb?.()
}

/** onClose：菜单关闭时回调；onStep：左右方向键（菜单栏用来切换相邻菜单）；anchor 为 bottom 时 y 是菜单底边（向上展开）；
 *  owner：打开菜单的按钮，菜单开着时再点它只关闭菜单 */
type MenuOptions = { onClose?: () => void; onStep?: (dir: -1 | 1) => void; anchor?: 'top' | 'bottom'; owner?: HTMLElement }

/** 极简右键菜单：Esc / 点外面关闭，方向键选择 */
export function showMenu(x: number, y: number, items: MenuItem[], opts: MenuOptions = {}): void {
  if (opts.owner) {
    if (justClosedOwner === opts.owner) {
      justClosedOwner = null
      return
    }
    if (current && currentOwner === opts.owner) {
      closeMenu()
      return
    }
  }
  closeMenu()
  onCurrentClose = opts.onClose ?? null
  currentOwner = opts.owner ?? null
  const buttons: HTMLButtonElement[] = []
  const menu = h(
    'div',
    { class: 'ctx-menu', role: 'menu' },
    ...items.map((it) => {
      if (it === 'sep') return h('div', { class: 'ctx-sep', role: 'separator' })
      const b = h(
        'button',
        {
          class: 'ctx-item' + (it.danger ? ' danger' : ''),
          role: 'menuitem',
          disabled: it.disabled,
          onClick: () => {
            closeMenu()
            it.run()
          }
        },
        h('span', { class: 'grow ctx-label' }, it.label, it.icon ? h('span', { class: 'ic', html: it.icon }) : null),
        it.key ? h('kbd', {}, it.key) : null
      )
      if (!it.disabled) buttons.push(b)
      return b
    })
  )
  document.body.append(menu)
  current = menu
  // 防止超出窗口
  const r = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
  const top = opts.anchor === 'bottom' ? y - r.height : y
  menu.style.top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8)) + 'px'
  if (opts.anchor === 'bottom') menu.style.transformOrigin = 'bottom left'
  buttons[0]?.focus()

  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus()
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
    else if (e.key === 'Escape') closeMenu()
    else if (opts.onStep && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) opts.onStep(e.key === 'ArrowLeft' ? -1 : 1)
    else return
    e.preventDefault()
    e.stopPropagation()
  })
  setTimeout(() => {
    const away = (e: Event) => {
      if (current && !current.contains(e.target as Node)) {
        const owner = currentOwner
        if (e.type === 'mousedown' && owner?.contains(e.target as Node)) {
          justClosedOwner = owner
          // 没有产生 click（比如拖出按钮）时也要清掉，免得下次点击被吞
          setTimeout(() => {
            if (justClosedOwner === owner) justClosedOwner = null
          }, 400)
        }
        closeMenu()
        window.removeEventListener('mousedown', away, true)
        window.removeEventListener('blur', away)
      }
    }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('blur', away)
  })
}
