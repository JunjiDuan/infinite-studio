import type { Account } from '../../shared/types'
import { h, toast } from './dom'
import { icons } from './icons'
import { showMenu, type MenuItem } from './menu'
import { t } from './i18n'

let account: Account | null = null

export const accountBtn = h('button', { class: 'rail-btn rail-account', onClick: () => openAccountMenu() })

function render(): void {
  accountBtn.replaceChildren()
  if (account?.avatar) {
    accountBtn.append(h('img', { class: 'avatar', src: account.avatar, alt: '', draggable: 'false' }))
  } else {
    accountBtn.innerHTML = icons.user
  }
  const label = account ? `${account.name} (@${account.login})` : t('登录 GitHub')
  accountBtn.title = label
  accountBtn.setAttribute('aria-label', t('账户：') + label)
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
  toast(t('已登录 GitHub：@{0}', a.login))
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
        { label: t('在浏览器中查看主页'), run: () => window.open(account!.url) },
        'sep',
        {
          label: t('退出登录'),
          danger: true,
          run: async () => {
            await window.api.account.logout()
            account = null
            render()
            toast(t('已退出登录'))
          }
        }
      ]
    : [{ label: t('使用 GitHub 登录'), run: () => void openLoginDialog() }]
  showMenu(x, y, items, { owner: accountBtn })
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
    placeholder: t('ghp_… 或 github_pat_…'),
    spellcheck: 'false',
    autocomplete: 'off',
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') submitToken()
    }
  })
  const submitToken = () => void attempt(() => window.api.account.loginToken(tokenInput.value), t('正在验证令牌…'))

  const codeBox = h('div', { class: 'login-code', hidden: true })

  // 浏览器登录：配置了 OAuth Client ID 走 Device Flow；没配置时打开 GitHub 预填好的令牌创建页，
  // 用户在网页里点“Generate token”，复制回来粘贴即可
  const TOKEN_URL = 'https://github.com/settings/tokens/new?description=Infinite%20Studio&scopes=read:user'
  const browserLogin = (): void => {
    if (!hasDevice) {
      window.open(TOKEN_URL)
      codeBox.hidden = false
      codeBox.replaceChildren(h('span', { class: 'muted' }, t('已在浏览器中打开 GitHub，点击页面底部的 “Generate token”，复制令牌后粘贴到下方')))
      setBusy('')
      tokenInput.focus()
      return
    }
    void attempt(async () => {
      const c = await window.api.account.deviceStart()
      codeBox.hidden = false
      codeBox.replaceChildren(
        h('span', { class: 'muted' }, t('在打开的网页中输入验证码')),
        h('button', {
          class: 'code',
          title: t('点击复制'),
          onClick: () => {
            void navigator.clipboard.writeText(c.userCode)
            toast(t('验证码已复制'))
          }
        }, c.userCode)
      )
      setBusy(t('等待浏览器中授权…'))
      return window.api.account.devicePoll()
    }, t('正在连接 GitHub…'))
  }

  const deviceBtn = h(
    'button',
    { class: 'btn primary login-main', onClick: browserLogin },
    h('span', { class: 'ic', html: icons.github }),
    t('在浏览器中登录')
  )

  const card = h(
    'div',
    { class: 'login-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('登录 GitHub') },
    h('div', { class: 'login-head' }, h('span', { class: 'ic', html: icons.githubLarge }), h('h2', {}, t('登录 GitHub'))),
    deviceBtn,
    codeBox,
    h(
      'button',
      { class: 'btn login-main', onClick: () => void attempt(() => window.api.account.loginGh(), t('正在读取 GitHub CLI 登录…')) },
      h('span', { class: 'ic', html: icons.terminal }),
      t('使用 GitHub CLI (gh) 的登录')
    ),
    h('div', { class: 'login-or' }, t('或使用个人访问令牌')),
    h('div', { class: 'login-row' }, tokenInput, h('button', { class: 'btn', onClick: submitToken }, t('登录'))),
    status,
    h('p', { class: 'login-note' }, t('令牌只用于读取你的公开资料，并以系统密钥加密保存在本机。'))
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
  deviceBtn.focus()
}
