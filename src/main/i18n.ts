/* 主进程里会显示给用户的文本（对话框标题、错误信息）的翻译：英文在下面的 EN 表里，其他语言来自语言包插件 */
import { app } from 'electron'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { LOCALE_CODE_RE, type LocalePack } from '../shared/plugins'

/** 实际显示的语言：zh / en / 语言包的代码 */
let locale = 'zh'
/** 设置里明确选过、并且现在可用的语言；没选过时为 null（界面跟随系统语言） */
let saved: string | null = null
/** 当前语言包（界面语言不是中文 / 英文时） */
let pack: LocalePack | null = null

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * 找已安装、已启用的这种语言的语言包，读出翻译表。
 * 界面是启动时一次性搭好的，翻译表要在页面脚本执行前就准备好，所以这里同步读文件。
 */
function readLocalePack(code: string, disabled: Record<string, boolean> | undefined): LocalePack | null {
  const dir = path.join(app.getPath('userData'), 'plugins')
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => ID_RE.test(n))
  } catch {
    return null
  }
  for (const id of names) {
    if (disabled?.[id] === false) continue
    try {
      const m = JSON.parse(readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')) as {
        id?: string
        category?: string
        locale?: { code?: unknown; name?: unknown; strings?: unknown }
      }
      const l = m.locale
      if (m.id !== id || m.category !== 'locale' || !l || l.code !== code || typeof l.strings !== 'string') continue
      const rel = l.strings.replace(/\\/g, '/')
      if (!rel || rel.startsWith('/') || rel.split('/').some((x) => x === '..' || x === '')) continue
      const raw = JSON.parse(readFileSync(path.join(dir, id, ...rel.split('/')), 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') continue
      const strings: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && v) strings[k] = v
      return { id, code, name: typeof l.name === 'string' ? l.name : code, strings }
    } catch {
      /* 坏掉的插件跳过 */
    }
  }
  return null
}

/**
 * 按设置决定界面语言。plugins 是设置里的“插件 id → 是否启用”。
 * 选的是语言包、但语言包已卸载或停用时，当作没选过（跟随系统语言）。
 */
export function setMainLocale(l: unknown, systemLocale?: string, plugins?: Record<string, boolean>): void {
  if (l === 'zh' || l === 'en') {
    locale = l
    saved = l
    pack = null
    return
  }
  if (typeof l === 'string' && LOCALE_CODE_RE.test(l)) {
    // 新开窗口时重新读（语言包可能更新过）；保存设置时沿用已读的，除非它刚被停用
    const p = systemLocale === undefined && pack?.code === l && plugins?.[pack.id] !== false ? pack : readLocalePack(l, plugins)
    if (p) {
      locale = l
      saved = l
      pack = p
      return
    }
  }
  pack = null
  saved = null
  locale = /^zh/i.test(systemLocale ?? app.getLocale()) ? 'zh' : 'en'
}

export function getSavedLocale(): string | null {
  return saved
}

export function getLocalePack(): LocalePack | null {
  return pack
}

export function getMainLocale(): string {
  return locale
}

const EN: Record<string, string> = {
  '无法连接到插件仓库：{0}': 'Cannot reach the plugin repository: {0}',
  '插件包不是有效的 zip 文件': 'The plugin package is not a valid zip file',
  插件包不能加密: 'The plugin package must not be encrypted',
  插件包解压后太大: 'The plugin package is too large when unpacked',
  插件包使用了不支持的压缩方式: 'The plugin package uses an unsupported compression method',
  插件包太大: 'The plugin package is too large',
  '下载失败：{0}': 'Download failed: {0}',
  正在安装中: 'Already installing',
  '插件仓库里没有 {0}': '{0} is not in the plugin repository',
  '需要 Infinite Studio {0} 或更高版本': 'Requires Infinite Studio {0} or later',
  '这个插件需要更新 Infinite Studio 才能使用': 'This plugin requires a newer version of Infinite Studio',
  '校验失败：插件包和仓库登记的不一致': 'Checksum mismatch: the package does not match the repository',
  插件包里有不安全的文件路径: 'The plugin package contains unsafe file paths',
  '插件包里没有 manifest.json': 'The plugin package has no manifest.json',
  '插件包的 manifest.json 无效': "The plugin package's manifest.json is invalid",
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
  'API Key 格式不正确': 'The API key format is invalid',
  '系统密钥存储不可用，无法安全保存 API Key': 'System keychain is unavailable; cannot store the API key securely',
  '接口地址必须以 http:// 或 https:// 开头': 'The endpoint URL must start with http:// or https://',
  '还没有配置 {0} 的 API Key（设置 → 智慧能力）': 'No API key configured for {0} (Settings → Intelligence)',
  '请在设置里填写 {0} 使用的模型名称': 'Enter the model name to use for {0} in Settings',
  'API Key 无效或没有权限': 'Invalid API key or insufficient permissions',
  请求太频繁或额度已用完: 'Rate limited or out of credit',
  'Claude 拒绝了这个请求': 'Claude declined this request',
  '模型不存在：{0}': 'Model not found: {0}',
  '无法连接到 {0}': 'Cannot connect to {0}',
  网络连接失败: 'Network connection failed',
  请求超时: 'Request timed out',
  'OpenAI 兼容': 'OpenAI-compatible',
  '当前运行环境不支持读取 zstd 日志': 'This runtime cannot read zstd logs',
  '没有找到 Node.js，{0} 需要本机安装的 Node.js': 'Node.js not found; {0} needs a locally installed Node.js',
  不支持的图片格式: 'Unsupported image format',
  '图片超过 20 MB': 'Image exceeds 20 MB',
  '非法文件名：{0}': 'Invalid file name: {0}',
  打开文件夹: 'Open Folder',
  '出于安全考虑，不直接运行可执行文件或脚本': 'For safety, executables and scripts are not run directly',
  '已存在同名文件：{0}': 'A file with this name already exists: {0}',
  '找不到文件夹 {0}': 'Folder not found: {0}',
  无效的提交: 'Invalid commit',
  '没有可用的语言服务：{0}': 'No language server available: {0}',
  '正则表达式无效：{0}': 'Invalid regular expression: {0}',
  '{0} 窗口未就绪': '{0} window is not ready',
  当前不在任何分支上: 'Not on any branch',
  仓库没有配置远程仓库: 'This repository has no remote configured',
  请输入提交信息: 'Enter a commit message',
  无效的分支名: 'Invalid branch name',
  "解释器": "Interpreter",
  "调试器": "Debugger",
  "语言服务": "Language server",
  "编译器": "Compiler",
  "没有找到 Python 解释器，请先在插件页安装 Python 插件": "Python interpreter not found; install the Python plugin from the Plugins page",
  "没有找到 JDK，请先在插件页安装 Java 插件": "JDK not found; install the Java plugin from the Plugins page",
  "没有找到 C/C++ 编译器，请先在插件页安装 C/C++ 插件": "C/C++ compiler not found; install the C/C++ plugin from the Plugins page",
  "没有安装 debugpy，请在插件页点击 Python 插件的“安装”": "debugpy is not installed; click Install on the Python plugin in the Plugins page",
  "没有找到调试器（gdb），请先在插件页安装 C/C++ 插件": "Debugger (gdb) not found; install the C/C++ plugin from the Plugins page",
  "没有找到 .NET SDK，请先在插件页安装 C# 插件": ".NET SDK not found; install the C# plugin from the Plugins page",
  "没有找到调试器（netcoredbg），请先在插件页安装 C# 插件": "Debugger (netcoredbg) not found; install the C# plugin from the Plugins page",
  "没有找到 .csproj 项目文件；直接运行单个 .cs 文件需要 .NET 10 或更新的 SDK": "No .csproj project found; running a single .cs file requires .NET 10 SDK or later",
  "找不到编译生成的程序集（多目标框架的项目暂不支持调试）": "Could not find the built assembly (debugging multi-target projects is not supported yet)",
  "编译失败": "Compilation failed",
  /* 网页面板 */
  允许: 'Allow',
  拒绝: 'Deny',
  '{0} 想使用摄像头和麦克风': '{0} wants to use your camera and microphone',
  '{0} 想使用麦克风': '{0} wants to use your microphone',
  '本次运行 IDE 期间不再询问': "You won't be asked again until the IDE restarts",
  添加到词典: 'Add to dictionary',
  在浏览器中打开链接: 'Open link in browser',
  复制链接地址: 'Copy link address',
  复制图片: 'Copy image',
  剪切: 'Cut',
  复制: 'Copy',
  粘贴: 'Paste',
  全选: 'Select all',
  后退: 'Back',
  前进: 'Forward',
  重新加载: 'Reload',
  检查元素: 'Inspect element',
  '插件没有声明这个网站：{0}': 'The plugin does not declare the site: {0}',
  // 新建项目
  项目名称不能为空: 'Project name cannot be empty',
  项目名称包含非法字符: 'Project name contains invalid characters',
  位置必须是绝对路径: 'Location must be an absolute path',
  '目标已存在且不是文件夹：{0}': 'The target exists and is not a folder: {0}',
  '文件夹已存在且不为空：{0}': 'The folder already exists and is not empty: {0}',
  '包名不合法：{0}': 'Invalid package name: {0}',
  '未知项目类型：{0}': 'Unknown project type: {0}',
  '没有找到 Python 解释器，未创建虚拟环境': 'Python interpreter not found; the virtual environment was not created',
  '虚拟环境创建失败：{0}': 'Failed to create the virtual environment: {0}',
  'Git 仓库初始化失败：{0}': 'Failed to initialize the Git repository: {0}',
  '没有找到 git': 'git not found',
  选择项目位置: 'Choose project location'
}

/** 和渲染进程的 t() 一样：键是中文原文，{0} 是参数；语言包里没有的条目显示英文 */
export function tm(zh: string, ...args: unknown[]): string {
  const s = locale === 'zh' ? zh : ((pack?.strings[zh] ?? EN[zh]) || zh)
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s
}
