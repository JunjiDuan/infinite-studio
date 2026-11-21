import { h } from './dom'

export type MenuItem = { label: string; key?: string; danger?: boolean; disabled?: boolean; run: () => void } | 'sep'

let current: HTMLElement | null = null

export function closeMenu(): void {
  current?.remove()
  current = null
}

/** 极简右键菜单：Esc / 点外面关闭，方向键选择 */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu()
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
        h('span', { class: 'grow' }, it.label),
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
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
  buttons[0]?.focus()

  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus()
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
    else if (e.key === 'Escape') closeMenu()
    else return
    e.preventDefault()
    e.stopPropagation()
  })
  setTimeout(() => {
    const away = (e: Event) => {
      if (current && !current.contains(e.target as Node)) {
        closeMenu()
        window.removeEventListener('mousedown', away, true)
        window.removeEventListener('blur', away)
      }
    }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('blur', away)
  })
}
