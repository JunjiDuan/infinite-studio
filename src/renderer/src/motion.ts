/**
 * 动效系统：所有界面动画都从这里走，统一曲线、时长和“动效强度”设置。
 *
 * - full：完整动效（位移、缩放、弹簧）
 * - reduced：只保留淡入淡出，时长缩短（系统开了“减少动态效果”时自动降到这一档）
 * - off：完全关闭
 */

export type MotionLevel = 'full' | 'reduced' | 'off'

let level: MotionLevel = 'full'
const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)')

export function setMotionLevel(l: MotionLevel): void {
  level = l
  document.documentElement.dataset.motion = motionLevel()
}
prefersReduced.addEventListener('change', () => setMotionLevel(level))

/** 实际生效的档位 */
export function motionLevel(): MotionLevel {
  return level === 'full' && prefersReduced.matches ? 'reduced' : level
}
export const canAnimate = (): boolean => motionLevel() !== 'off'
export const fullMotion = (): boolean => motionLevel() === 'full'

/**
 * 用阻尼弹簧模拟生成 CSS linear() 缓动，比 cubic-bezier 的“回弹”更自然。
 * stiffness 越大越快，damping 越小越弹。
 */
function springEasing(stiffness: number, damping: number, mass = 1): { easing: string; duration: number } {
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  const wd = w0 * Math.sqrt(Math.max(0, 1 - zeta * zeta))
  const at = (t: number): number => {
    if (zeta < 1) return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  }
  // 找到稳定（误差 < 0.1%）的时间点作为总时长
  let end = 0
  for (let t = 0; t < 3; t += 0.002) if (Math.abs(at(t) - 1) > 0.001) end = t
  end += 0.02
  const steps = 48
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) pts.push((Math.round(at((end * i) / steps) * 10000) / 10000).toString())
  pts[steps] = '1'
  return { easing: `linear(${pts.join(', ')})`, duration: Math.round(end * 1000) }
}

/** 弹簧：snappy 用于小元素（指示条、标签归位），soft 用于大块面板，bouncy 用于点缀 */
export const SPRING = {
  snappy: springEasing(520, 34),
  soft: springEasing(260, 28),
  bouncy: springEasing(380, 18)
}

export const EASE = {
  /** 进入：快起慢收 */
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** 退出：慢起快收 */
  in: 'cubic-bezier(0.55, 0, 0.75, 0.2)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  /** 轻微过冲 */
  overshoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
}

export const DUR = { xs: 120, sm: 180, md: 260, lg: 380 }

// 把弹簧写成 CSS 变量，样式表里的 transition 也能用
const rootStyle = document.documentElement.style
rootStyle.setProperty('--spring-snappy', SPRING.snappy.easing)
rootStyle.setProperty('--spring-snappy-dur', SPRING.snappy.duration + 'ms')
rootStyle.setProperty('--spring-soft', SPRING.soft.easing)
rootStyle.setProperty('--spring-soft-dur', SPRING.soft.duration + 'ms')
rootStyle.setProperty('--spring-bouncy', SPRING.bouncy.easing)
rootStyle.setProperty('--spring-bouncy-dur', SPRING.bouncy.duration + 'ms')

type Frames = Keyframe[]
interface AnimOpts {
  duration?: number
  easing?: string
  delay?: number
  fill?: FillMode
  /** 弹簧预设（覆盖 duration / easing） */
  spring?: keyof typeof SPRING
}

/**
 * 统一的 Element.animate 包装：按动效档位降级。
 * reduced 档只保留 opacity 关键帧（没有就跳过），时长减半。
 */
export function animate(el: Element, frames: Frames, o: AnimOpts = {}): Animation | null {
  const lv = motionLevel()
  if (lv === 'off') return null
  let duration = o.duration ?? DUR.md
  let easing = o.easing ?? EASE.out
  if (o.spring) {
    duration = SPRING[o.spring].duration
    easing = SPRING[o.spring].easing
  }
  let kf = frames
  if (lv === 'reduced') {
    if (!frames.some((f) => f.opacity !== undefined)) return null
    kf = frames.map((f) => ({ opacity: f.opacity ?? 1, offset: f.offset }))
    duration = Math.min(duration, 160) / 1.4
    easing = EASE.out
  }
  return el.animate(kf, { duration, easing, delay: o.delay ?? 0, fill: o.fill ?? 'backwards' })
}

/** 动画结束（或被取消）后执行；没有动画时立即执行 */
export function after(a: Animation | null, fn: () => void): void {
  if (!a) return fn()
  let done = false
  const run = () => {
    if (done) return
    done = true
    fn()
  }
  a.finished.then(run, run)
}

/**
 * FLIP：记下元素当前位置 → 执行 DOM 变化 → 从旧位置平滑移到新位置。
 * 只处理位移（不处理尺寸），适合列表重排。
 */
export function flip(els: Iterable<Element>, mutate: () => void, o: AnimOpts = { spring: 'snappy' }): void {
  if (!fullMotion()) return mutate()
  const first = new Map<Element, DOMRect>()
  for (const el of els) first.set(el, el.getBoundingClientRect())
  mutate()
  for (const [el, a] of first) {
    if (!el.isConnected) continue
    const b = el.getBoundingClientRect()
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], o)
  }
}

/** 列表依次进入：每项延迟 step 毫秒（最多 maxItems 项有延迟，后面的一起出现） */
export function stagger(els: Element[], frames: Frames, o: AnimOpts & { step?: number; maxItems?: number } = {}): void {
  const step = o.step ?? 24
  const max = o.maxItems ?? 14
  els.forEach((el, i) => animate(el, frames, { ...o, delay: (o.delay ?? 0) + Math.min(i, max) * step }))
}

/* ---------------- 面板折叠 / 展开 ---------------- */

const collapsing = new WeakMap<HTMLElement, Animation>()

/**
 * 侧栏、终端面板这类“显示 / 隐藏”的块：展开时尺寸从 0 长到目标值，收起时反过来。
 * 隐藏期间元素带 .closing 类（样式表里让它保持显示），动画结束后移除。
 */
export function collapse(el: HTMLElement, axis: 'width' | 'height', show: boolean): void {
  collapsing.get(el)?.cancel()
  collapsing.delete(el)
  el.classList.remove('closing')
  if (!canAnimate()) return
  if (show) {
    const size = axis === 'width' ? el.offsetWidth : el.offsetHeight
    if (!size) return
    const a = animate(el, [{ [axis]: '0px', opacity: 0.4 }, { [axis]: size + 'px', opacity: 1 }], { spring: 'soft' })
    if (a) {
      el.classList.add('animating')
      collapsing.set(el, a)
      after(a, () => el.classList.remove('animating'))
    }
    // 内容轻轻滑入
    const inner = el.children
    for (let i = 0; i < inner.length; i++)
      animate(inner[i], [{ opacity: 0, transform: axis === 'width' ? 'translateX(-10px)' : 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.md, delay: 40 })
  } else {
    // 元素马上要被隐藏：先用 .closing 撑住，播完收起动画再真正隐藏
    const size = axis === 'width' ? el.offsetWidth : el.offsetHeight
    if (!size) return
    el.classList.add('closing', 'animating')
    const a = animate(el, [{ [axis]: size + 'px', opacity: 1 }, { [axis]: '0px', opacity: 0 }], { duration: DUR.sm + 40, easing: EASE.inOut, fill: 'forwards' })
    if (!a) {
      el.classList.remove('closing', 'animating')
      return
    }
    collapsing.set(el, a)
    after(a, () => {
      if (collapsing.get(el) !== a) return
      collapsing.delete(el)
      el.classList.remove('closing', 'animating')
      a.cancel()
    })
  }
}

/* ---------------- 视图过渡（主题切换、专注模式） ---------------- */

type VTDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> } }

/**
 * 用 View Transitions API 给整页状态切换做过渡。
 * reveal 传入坐标时，新画面从该点以圆形扩散展开（主题切换）；否则整体淡入并轻微缩放。
 */
export function viewTransition(update: () => void, o: { reveal?: { x: number; y: number }; kind?: string } = {}): void {
  const d = document as VTDoc
  if (!canAnimate() || !d.startViewTransition) return update()
  const root = document.documentElement
  root.dataset.vt = o.reveal ? 'reveal' : (o.kind ?? 'fade')
  const t = d.startViewTransition(update)
  t.ready
    .then(() => {
      if (!o.reveal || !fullMotion()) return
      const { x, y } = o.reveal
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 560, easing: EASE.inOut, pseudoElement: '::view-transition-new(root)' }
      )
    })
    .catch(() => {})
  t.finished.finally(() => delete root.dataset.vt).catch(() => {})
}

/* ---------------- 点击涟漪 ---------------- */

/** 在按钮上从点击位置扩散一圈柔和的光（主按钮、活动栏用） */
export function ripple(el: HTMLElement, e: MouseEvent): void {
  if (!fullMotion()) return
  const r = el.getBoundingClientRect()
  const size = Math.max(r.width, r.height) * 2.2
  const dot = document.createElement('span')
  dot.className = 'ripple'
  dot.style.width = dot.style.height = size + 'px'
  dot.style.left = e.clientX - r.left - size / 2 + 'px'
  dot.style.top = e.clientY - r.top - size / 2 + 'px'
  el.append(dot)
  const a = animate(dot, [{ transform: 'scale(0)', opacity: 0.35 }, { transform: 'scale(1)', opacity: 0 }], { duration: 520, easing: EASE.out, fill: 'forwards' })
  after(a, () => dot.remove())
}

/** 全局安装：所有 .btn / .rail-btn 点击时出现涟漪 */
export function installRipples(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return
      const el = (e.target as Element | null)?.closest?.('.btn, .rail-btn, .welcome .recent') as HTMLElement | null
      if (el && !(el as HTMLButtonElement).disabled) ripple(el, e)
    },
    true
  )
}
