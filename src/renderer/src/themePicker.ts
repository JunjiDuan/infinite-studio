import type { ThemeId } from '../../shared/types'
import { h } from './dom'
import { t } from './i18n'
import { THEMES } from './theme'

/**
 * 标题栏主题选择器：平时只显示当前主题的一颗圆点，
 * 点击后从标题栏下沿展开一把半圆形的“调色盘”，各主题沿弧线排开。
 */

const RADIUS = 74 // 圆点所在弧线的半径
const ARC_FROM = 20 // 弧线起止角（度，0 = 正右，90 = 正下）
const ARC_TO = 160

export function createThemePicker(current: () => ThemeId, pick: (id: ThemeId, e: MouseEvent) => void): { el: HTMLElement; render: () => void } {
  const ids = Object.keys(THEMES) as ThemeId[]

  const triggerDot = h('span', { class: 'tp-dot' })
  const trigger = h('button', { class: 'tp-trigger', 'aria-haspopup': 'true', 'aria-expanded': 'false', onClick: () => toggle() }, triggerDot)
  const label = h('div', { class: 'tp-label' })
  const fan = h('div', { class: 'tp-fan', role: 'group', 'aria-label': t('切换主题') }, label)
  const el = h('div', { class: 'theme-picker' }, trigger, fan)

  const dots = ids.map((id, i) => {
    const deg = ids.length === 1 ? 90 : ARC_FROM + ((ARC_TO - ARC_FROM) * i) / (ids.length - 1)
    const rad = (deg * Math.PI) / 180
    const b = h(
      'button',
      {
        class: 'tp-item',
        tabindex: '-1',
        'aria-label': THEMES[id].label,
        onClick: (e: MouseEvent) => {
          close()
          pick(id, e)
        },
        onMouseenter: () => showLabel(id),
        onFocus: () => showLabel(id),
        onMouseleave: () => showLabel(current()),
        onKeydown: (e: KeyboardEvent) => {
          const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 1 : 0
          if (!step) return
          e.preventDefault()
          dots[(i + step + ids.length) % ids.length].focus()
        }
      },
      h('span', { style: { background: THEMES[id].swatch } })
    )
    b.style.setProperty('--x', `${(Math.cos(rad) * RADIUS).toFixed(1)}px`)
    b.style.setProperty('--y', `${(Math.sin(rad) * RADIUS).toFixed(1)}px`)
    // 从中间往两边依次弹出
    b.style.setProperty('--i', String(Math.abs(i - (ids.length - 1) / 2)))
    fan.append(b)
    return b
  })

  function showLabel(id: ThemeId): void {
    label.textContent = THEMES[id].label
  }

  function isOpen(): boolean {
    return el.classList.contains('open')
  }

  function open(): void {
    el.classList.add('open')
    trigger.setAttribute('aria-expanded', 'true')
    dots.forEach((d) => (d.tabIndex = 0))
    showLabel(current())
    dots[ids.indexOf(current())]?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', close)
  }

  function close(): void {
    if (!isOpen()) return
    const hadFocus = el.contains(document.activeElement)
    el.classList.remove('open')
    trigger.setAttribute('aria-expanded', 'false')
    dots.forEach((d) => (d.tabIndex = -1))
    if (hadFocus) trigger.focus({ preventScroll: true })
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', close)
  }

  function toggle(): void {
    if (isOpen()) close()
    else open()
  }

  function onOutside(e: PointerEvent): void {
    if (!el.contains(e.target as Node)) close()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function render(): void {
    const cur = current()
    triggerDot.style.background = THEMES[cur].swatch
    trigger.setAttribute('aria-label', `${t('切换主题')}: ${THEMES[cur].label}`)
    trigger.title = `${t('主题')}: ${THEMES[cur].label}`
    dots.forEach((d, i) => {
      const on = ids[i] === cur
      d.classList.toggle('on', on)
      d.setAttribute('aria-pressed', String(on))
    })
    if (isOpen()) showLabel(cur)
  }

  return { el, render }
}
