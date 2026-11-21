import type { AppInfo, UpdateResult } from '../../shared/types'
import { h, toast } from './dom'
import { icons } from './icons'
import { t } from './i18n'

/* ---------------- 帮助菜单的对话框：隐私声明 / 检查更新 / 关于 ---------------- */

let dialogEl: HTMLElement | null = null
let lastFocus: HTMLElement | null = null

function closeDialog(): void {
  if (!dialogEl) return
  dialogEl.remove()
  dialogEl = null
  lastFocus?.focus?.()
  lastFocus = null
}

function openDialog(title: string, body: Node[], actions: HTMLElement[]): HTMLElement {
  closeDialog()
  lastFocus = document.activeElement as HTMLElement | null
  const close = h('button', { class: 'icon-btn small help-close', 'aria-label': t('关闭'), title: t('关闭'), html: icons.close, onClick: closeDialog })
  const card = h(
    'div',
    { class: 'help-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'help-head' }, h('h2', {}, title), close),
    h('div', { class: 'help-body' }, ...body),
    actions.length ? h('div', { class: 'help-actions' }, ...actions) : null
  )
  dialogEl = h(
    'div',
    {
      class: 'palette-backdrop help-backdrop',
      onMousedown: (e: MouseEvent) => {
        if (e.target === dialogEl) closeDialog()
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          closeDialog()
        }
      }
    },
    card
  )
  document.body.append(dialogEl)
  ;(actions[actions.length - 1] ?? close).focus()
  return card
}

const okBtn = (): HTMLElement => h('button', { class: 'btn primary', onClick: closeDialog }, t('好'))

/* ---------- 隐私声明 ---------- */

export function openPrivacy(): void {
  const section = (title: string, ...lines: string[]) =>
    h('section', { class: 'help-sec' }, h('h3', {}, title), ...lines.map((l) => h('p', {}, l)))
  openDialog(
    t('隐私声明'),
    [
      h('p', { class: 'help-lead' }, t('Infinite Studio 是本地运行的桌面应用，不收集使用统计、崩溃报告或任何遥测数据，也没有自己的服务器。')),
      section(
        t('保存在本机的数据'),
        t('设置、最近打开的文件夹、窗口布局和资源管理器的展开状态保存在本机的用户数据目录中。'),
        t('GitHub 登录令牌使用系统密钥存储加密后保存在本机，只用于读取你的公开资料。')
      ),
      section(
        t('联网的情况'),
        t('登录 GitHub 时：连接 github.com 和 api.github.com 验证身份、读取头像。'),
        t('检查更新时：只在你点击“检查更新”后请求 GitHub 公开的 Releases 接口，不附带账户或设备信息。'),
        t('使用 Claude、Codex 等 AI 插件时：由本机安装的对应命令行工具直接与其服务商通信，发送的内容适用该服务商的隐私政策。')
      ),
      section(
        t('你的代码'),
        t('项目文件只在本机读写。语言服务、调试器和终端都在本机运行；只有你主动发给 AI 插件的内容才会离开本机。')
      )
    ],
    [okBtn()]
  )
}

/* ---------- 检查更新 ---------- */

export async function checkForUpdates(): Promise<void> {
  const status = h('p', { class: 'help-status', role: 'status' }, t('正在检查更新…'))
  const actions = h('div', { class: 'help-actions-inline' })
  const card = openDialog(t('检查更新'), [status, actions], [okBtn()])
  const r: UpdateResult = await window.api.app.checkUpdate().catch((e) => ({ status: 'error' as const, current: '', message: String(e) }))
  if (!card.isConnected) return
  if (r.status === 'available') {
    status.textContent = t('发现新版本 {0}（当前 {1}）', r.latest, r.current)
    actions.append(h('button', { class: 'btn primary', onClick: () => window.open(r.url) }, t('前往下载')))
    if (r.notes) card.querySelector('.help-body')!.append(h('pre', { class: 'help-notes' }, r.notes))
  } else if (r.status === 'latest') {
    status.textContent = t('已是最新版本（{0}）', r.current)
  } else if (r.status === 'none') {
    status.textContent = t('当前版本 {0}，暂时还没有发布新版本', r.current)
    actions.append(h('button', { class: 'btn', onClick: () => window.open(r.url) }, t('查看发布页')))
  } else if (r.status === 'error') {
    status.classList.add('err')
    status.textContent = t('检查更新失败：{0}', r.message)
  }
}

/* ---------- 关于 ---------- */

export async function openAbout(): Promise<void> {
  let info: AppInfo
  try {
    info = await window.api.app.info()
  } catch (e) {
    toast(String(e))
    return
  }
  const rows: [string, string][] = [
    [t('版本'), info.version],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node.js', info.node],
    ['V8', info.v8],
    [t('操作系统'), info.os]
  ]
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n')
  openDialog(
    t('关于'),
    [
      h(
        'div',
        { class: 'about-brand' },
        h('span', { class: 'about-logo', html: icons.logoLarge }),
        h('div', {}, h('div', { class: 'about-name' }, 'Infinite Studio'), h('div', { class: 'about-sub' }, t('无界工作室 · 极简、高度个性化的桌面 IDE')))
      ),
      h('dl', { class: 'about-grid' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('p', { class: 'about-copy' }, 'Copyright © 2026 JunjiDuan')
    ],
    [
      h('button', { class: 'btn', onClick: () => window.open(info.homepage) }, t('项目主页')),
      h(
        'button',
        {
          class: 'btn',
          onClick: () => void navigator.clipboard.writeText(`Infinite Studio\n${text}`).then(() => toast(t('已复制版本信息')))
        },
        t('复制')
      ),
      okBtn()
    ]
  )
}
