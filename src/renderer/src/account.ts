import type { Account } from '../../shared/types'
import { h, toast } from './dom'
import { icons } from './icons'
import { showMenu, type MenuItem } from './menu'

let account: Account | null = null

export const accountBtn = h('button', { class: 'rail-btn rail-account', onClick: () => openAccountMenu() })

function render(): void {
  accountBtn.replaceChildren()
  if (account?.avatar) {
    accountBtn.append(h('img', { class: 'avatar', src: account.avatar, alt: '', draggable: 'false' }))
  } else {
    accountBtn.innerHTML = icons.user
  }
  const label = account ? `${account.name} (@${account.login})` : '登录 GitHub'
  accountBtn.title = label
  accountBtn.setAttribute('aria-label', '账户：' + label)
}

export async function initAccount(): Promise<void> {
  render()
  try {
    account = await window.api.account.get()
  } catch {
    account = null
  }
  render()
}

function signedIn(a: Account): void {
  account = a
  render()
  toast(`已登录 GitHub：@${a.login}`)
}

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function openAccountMenu(): void {
  const r = accountBtn.getBoundingClientRect()
  const x = r.right + 6
  const y = r.top
  const items: MenuItem[] = account
    ? [
        { label: `@${account.login}`, disabled: true, run: () => {} },
        { label: '在浏览器中查看主页', run: () => window.open(account!.url) },
        'sep',
        {
          label: '退出登录',
          danger: true,
          run: async () => {
            await window.api.account.logout()
            account = null
            render()
            toast('已退出登录')
          }
        }
      ]
    : [{ label: '使用 GitHub 登录…', run: () => void openLoginDialog() }]
  showMenu(x, y, items)
}

/* ---------------- 登录对话框 ---------------- */

let dialogEl: HTMLElement | null = null

function closeDialog(): void {
  if (!dialogEl) return
  dialogEl.remove()
  dialogEl = null
  void window.api.account.deviceCancel()
}

export async function openLoginDialog(): Promise<void> {
  closeDialog()
  const hasDevice = await window.api.account.hasDeviceFlow().catch(() => false)

  const status = h('p', { class: 'login-status', role: 'status' })
  const setBusy = (msg: string, isErr = false) => {
    status.textContent = msg
    status.classList.toggle('err', isErr)
  }
  const attempt = async (fn: () => Promise<Account | null>, busy: string) => {
    setBusy(busy)
    try {
      const a = await fn()
      if (!a) return
      closeDialog()
      signedIn(a)
    } catch (err) {
      if (dialogEl) setBusy(errMsg(err), true)
    }
  }

  const tokenInput = h('input', {
    class: 'login-input',
    type: 'password',
    placeholder: 'ghp_… 或 github_pat_…',
    spellcheck: 'false',
    autocomplete: 'off',
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') submitToken()
    }
  })
  const submitToken = () => void attempt(() => window.api.account.loginToken(tokenInput.value), '正在验证令牌…')

  const codeBox = h('div', { class: 'login-code', hidden: true })

  const deviceBtn = h(
    'button',
    {
      class: 'btn primary login-main',
      disabled: !hasDevice,
      title: hasDevice ? '' : '需要在 src/main/account.ts 配置 GitHub OAuth Client ID',
      onClick: () =>
        void attempt(async () => {
          const c = await window.api.account.deviceStart()
          codeBox.hidden = false
          codeBox.replaceChildren(
            h('span', { class: 'muted' }, '在打开的网页中输入验证码'),
            h('button', {
              class: 'code',
              title: '点击复制',
              onClick: () => {
                void navigator.clipboard.writeText(c.userCode)
                toast('验证码已复制')
              }
            }, c.userCode)
          )
          setBusy('等待浏览器中授权…')
          return window.api.account.devicePoll()
        }, '正在连接 GitHub…')
    },
    h('span', { class: 'ic', html: icons.github }),
    '在浏览器中登录'
  )

  const card = h(
    'div',
    { class: 'login-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '登录 GitHub' },
    h('div', { class: 'login-head' }, h('span', { class: 'ic', html: icons.githubLarge }), h('h2', {}, '登录 GitHub')),
    deviceBtn,
    codeBox,
    h(
      'button',
      { class: 'btn login-main', onClick: () => void attempt(() => window.api.account.loginGh(), '正在读取 GitHub CLI 登录…') },
      h('span', { class: 'ic', html: icons.terminal }),
      '使用 GitHub CLI (gh) 的登录'
    ),
    h('div', { class: 'login-or' }, '或使用个人访问令牌'),
    h('div', { class: 'login-row' }, tokenInput, h('button', { class: 'btn', onClick: submitToken }, '登录')),
    status,
    h('p', { class: 'login-note' }, '令牌只用于读取你的公开资料，并以系统密钥加密保存在本机。')
  )

  dialogEl = h(
    'div',
    {
      class: 'palette-backdrop login-backdrop',
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
  ;(hasDevice ? deviceBtn : tokenInput).focus()
}
