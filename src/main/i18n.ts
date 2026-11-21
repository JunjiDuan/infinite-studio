/* 主进程里会显示给用户的文本（对话框标题、错误信息）的英文 */

let locale: 'zh' | 'en' = 'zh'
/** 设置里明确选过的语言；没选过时为 null（界面跟随系统语言） */
let saved: 'zh' | 'en' | null = null

export function setMainLocale(l: unknown, systemLocale?: string): void {
  if (l === 'zh' || l === 'en') {
    locale = l
    saved = l
  } else if (systemLocale) locale = /^zh/i.test(systemLocale) ? 'zh' : 'en'
}

export function getSavedLocale(): 'zh' | 'en' | null {
  return saved
}

export function getMainLocale(): 'zh' | 'en' {
  return locale
}

const EN: Record<string, string> = {
  令牌为空: 'Token is empty',
  令牌无效或已过期: 'Token is invalid or expired',
  'GitHub 返回 {0}': 'GitHub returned {0}',
  '系统密钥存储不可用，无法安全保存登录信息': 'System key storage is unavailable; cannot store sign-in securely',
  '未找到 GitHub CLI（gh）': 'GitHub CLI (gh) not found',
  'GitHub CLI 尚未登录，请先运行 gh auth login': 'GitHub CLI is not signed in; run gh auth login first',
  '未配置 GitHub OAuth Client ID': 'GitHub OAuth Client ID is not configured',
  无法发起登录: 'Unable to start sign-in',
  没有进行中的登录: 'No sign-in in progress',
  '验证码已过期，请重试': 'The code expired, please try again',
  登录失败: 'Sign-in failed',
  '登录失败（{0}）': 'Sign-in failed ({0})',
  未知插件: 'Unknown plugin',
  '未知插件：{0}': 'Unknown plugin: {0}',
  '没有找到 {0} 命令行工具，请先在插件页安装': '{0} CLI not found; install it from the Plugins page first',
  '没有找到 Claude Code 命令行工具，请先在插件页安装': 'Claude Code CLI not found; install it from the Plugins page first',
  '没有找到 Claude Code 命令行工具': 'Claude Code CLI not found',
  找不到这个会话: 'Session not found',
  不支持的图片格式: 'Unsupported image format',
  '图片超过 20 MB': 'Image exceeds 20 MB',
  '非法文件名：{0}': 'Invalid file name: {0}',
  打开文件夹: 'Open Folder',
  '出于安全考虑，不直接运行可执行文件或脚本': 'For safety, executables and scripts are not run directly',
  '已存在同名文件：{0}': 'A file with this name already exists: {0}',
  '找不到文件夹 {0}': 'Folder not found: {0}',
  无效的提交: 'Invalid commit',
  导出空间: 'Export Space',
  导入空间: 'Import Space',
  无界空间: 'Infinite Space',
  '没有可用的语言服务：{0}': 'No language server available: {0}',
  '正则表达式无效：{0}': 'Invalid regular expression: {0}',
  '{0} 窗口未就绪': '{0} window is not ready',
  当前不在任何分支上: 'Not on any branch',
  仓库没有配置远程仓库: 'This repository has no remote configured',
  请输入提交信息: 'Enter a commit message',
  无效的分支名: 'Invalid branch name'
}

/** 和渲染进程的 t() 一样：键是中文原文，{0} 是参数 */
export function tm(zh: string, ...args: unknown[]): string {
  const s = locale === 'en' ? (EN[zh] ?? zh) : zh
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s
}
