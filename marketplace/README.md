# Infinite Studio 插件市场

Infinite Studio（无界工作室）的官方插件。IDE 的插件面板里，“生产力工具”和“多语言支持”两栏，以及“大模型”栏里的市场插件，列表都来自这里的 `registry.json`。用户点击“安装”后，IDE 下载 `packages/` 里的插件包（先试 jsDelivr，再试 raw.githubusercontent），校验 sha256，再解压安装。

这个目录不会被打进 IDE 安装包，IDE 只在运行时从 GitHub 读取它。

| 插件 | 说明 |
| --- | --- |
| [HTML 预览器](plugins/html-preview) | 打开 `.html` 文件时直接显示成网页：本地 CSS / JS / 图片 / 字体自动加载，脚本照常运行。预览 / 分栏 / 源码，边写边刷新；桌面 / 平板 / 手机尺寸；控制台；引用文件改动后自动刷新；导出单文件 HTML。AI 工具：控制台、重新加载、在页面里运行脚本、截图 |
| [LaTeX 编辑器](plugins/latex) | 打开 `.tex` 文件。语法高亮，命令 / 环境 / 标签 / 文献 / 文件名补全，查找替换，大纲。即时预览不用安装 TeX（KaTeX 公式、自动编号、交叉引用、表格、定理、参考文献、图片），双击跳回源码；PDF 模式用本机 TeX 编译（XeLaTeX、pdfLaTeX、LuaLaTeX、latexmk、Tectonic），日志错误定位到行，SyncTeX 双向跳转。需要 `terminal` 权限。AI 工具：编译并返回带行号的错误、大纲、截图 |
| [PDF 编辑器](plugins/pdf) | 打开和编辑 `.pdf`：添加文字、修改原有文字（自动遮盖原文、取色）、高亮（吸附到文字行）、白色遮盖、矩形 / 椭圆 / 直线 / 箭头、手绘签名、图片（可拖入或粘贴），填写表单；页面旋转 / 删除 / 复制 / 拖动排序，插入空白页、合并其他 PDF，导出选中页或 PNG，文档属性。添加的内容保存后再打开仍可编辑；中文需要在菜单里选一次字体文件（如 `msyh.ttc`），保存时子集嵌入。加密的 PDF 只能查看。AI 工具：读文字（带位置）、渲染页面、添加批注 / 文字 / 图片、改原有文字、填表单、整理和拆分页面、文档属性。需要 `workspace-write` 权限（拆分出的新 PDF 写进工作区） |
| [Markdown 美化](plugins/markdown) | 打开 `.md` 文件。阅读 / 分栏 / 源码三种模式：标题编号、提示块、代码高亮与复制、任务进度、大纲与阅读进度，分栏滚动同步；四套主题，导出 HTML。AI 工具：大纲、导出 HTML 到工作区、截图。需要 `workspace-write` 权限 |
| [思维导图](plugins/mindmap) | 打开 `.mind` 文件。用键盘快速建主题，拖拽调整结构，可折叠分支，导出 PNG / SVG / Markdown。AI 工具：读取、增删改移节点、整张替换、截图 |
| [网页大模型助手](plugins/web-ai) | 在编辑器右侧分栏里使用网页版 Claude、ChatGPT、Gemini、DeepSeek（插件面板的“大模型”分类）。右上角的地球按钮选择网站，各网站的登录状态分开保存在本机；Alt K 把选中的代码或当前文件粘贴进网页的输入框 |
| [Word 文档](plugins/docx) | 打开和编辑 `.docx`：按原样式显示（样式继承、主题字体、编号列表、表格、图片、页眉页脚），直接打字修改；字体、字号、颜色、突出显示、上下标、对齐、行距、标题样式、项目符号和编号；插入表格（增删行列、Tab 跳格）、图片（拖动缩放）、超链接、分页符；查找替换、导航窗格；粘贴保留格式（网页内容转成标题 / 列表 / 表格）。保存时只重写改动过的部分，批注、修订、域、脚注、内容控件原样保留。AI 工具：读取文档（按块编号）、用 Markdown 插入内容、查找替换、改段落文字和格式、编辑表格、插入图片、删除块 |
| [演示文稿](plugins/pptx) | 打开和编辑 `.pptx`：按原样式显示（主题、母版、表格、图表、SmartArt），改文字和格式，移动 / 缩放 / 旋转形状，插入文本框、形状、图片、表格，增删 / 复制 / 排序幻灯片，备注，放映。AI 工具：读取幻灯片、按版式新建、改文字和格式、插入形状 / 图片 / 表格、备注、截图 |

语言包（插件面板的“多语言支持”分类）：安装后在 设置 → 多语言设置 里切换界面语言。

| 插件 | 语言 |
| --- | --- |
| [العربية](plugins/lang-ar) | 阿拉伯语 `ar` |
| [Deutsch](plugins/lang-de) | 德语 `de` |
| [Español](plugins/lang-es) | 西班牙语 `es` |
| [Français](plugins/lang-fr) | 法语 `fr` |
| [日本語](plugins/lang-ja) | 日语 `ja` |
| [한국어](plugins/lang-ko) | 韩语 `ko` |
| [Русский](plugins/lang-ru) | 俄语 `ru` |

## 目录结构

```
marketplace/
├─ registry.json       插件目录（IDE 读取），由打包脚本生成，不要手改
├─ sdk/studio.js       插件页面和 IDE 通信用的 SDK，打包时自动放进每个插件
├─ plugins/<id>/       插件源码：manifest.json + 页面文件
├─ packages/           打好的插件包 <id>-<版本>.zip（要提交）
└─ pack.mjs            打包脚本
```

## 写一个插件

插件就是一个普通网页：用 HTML、CSS、JS 编写，可以用任何框架，构建产物放进插件目录即可。IDE 打开对应扩展名的文件时，会在编辑器标签里用 iframe 加载这个页面。

### manifest.json

```json
{
  "id": "mindmap",
  "name": "思维导图",
  "version": "1.0.0",
  "publisher": "Infinite Studio",
  "description": "一句话介绍，显示在插件卡片上",
  "category": "productivity",
  "homepage": "https://github.com/JunjiDuan/infinite-studio/tree/main/marketplace/plugins/mindmap",
  "minStudio": "0.1.0",
  "minApi": 2,
  "icon": "icon.svg",
  "permissions": [],
  "editor": { "entry": "index.html", "extensions": [".mind"], "binary": false },
  "newFile": { "label": "思维导图", "extension": ".mind", "template": "" }
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 小写字母、数字、连字符，必须和目录名相同 |
| `version` | `x.y.z`。发布新版本前先改这里 |
| `minApi` | 需要的最低**插件接口版本**（见下文），不写为 1。IDE 不够新时插件卡片显示“需要更新 Infinite Studio”，不能安装 |
| `minStudio` | 需要的最低 IDE 版本。一般不用，用 `minApi` |
| `editor.extensions` | 由这个插件打开的文件扩展名 |
| `editor.binary` | `true`：文件按二进制读写（PDF、PPTX 等），页面收到的是 `ArrayBuffer` |
| `newFile` | 可选。在插件卡片和命令面板里加一个“新建…”命令 |
| `permissions` | 可选。额外权限，显示在插件卡片上。没有必要不要声明 |

### 权限

| 权限 | 允许 |
| --- | --- |
| `network` | 页面可以加载 http(s) 资源；可以用 `studio.net.fetch`（主进程发请求，不受跨域限制） |
| `eval` | 页面可以用 `eval` / `new Function` |
| `workspace-write` | 在工作区里写入、新建、移动、删除文件。不声明时只能写**当前打开的文件** |
| `clipboard-read` | 读取剪贴板（写入不需要权限） |
| `terminal` | 在 IDE 终端里运行命令。每次 IDE 运行期间，第一次运行前会弹窗问用户 |
| `webPanel` | 在编辑器分栏里显示 `manifest.webPanel` 声明的网站（见下文“网页面板”） |

不需要权限的：读取工作区里的任何文件、列目录、监视文件、对话框、写剪贴板、打开文件、提示、命令面板。

### 插件接口版本（为什么加插件不用更新 IDE）

IDE 给插件的能力是一套通用接口（文件、对话框、网络、剪贴板、终端、命令…），插件在这套接口上实现功能。**只用现有接口的插件，发布后所有 IDE 都能直接安装使用，不需要更新 IDE。**

只有接口本身扩展时（新增一类能力），接口版本号 `PLUGIN_API`（`src/shared/plugins.ts`）才加 1：

| 版本 | 内容 |
| --- | --- |
| 1 | 打开 / 保存当前文件、主题、导出、提示、打开链接、`readAsset` |
| 2 | `studio.call` 通用调用：`fs.*`、`dialog.*`、`clipboard.*`、`net.fetch`、`editor.*`、`ui.*`、`terminal.run`、`commands.*`；权限；文件监视 |
| 3 | 语言包（`category: "locale"` + `locale` 字段） |
| 4 | 网页面板（`webPanel` 字段 + `webPanel` 权限）；市场插件可以放进“大模型”分类（`category: "llm"`） |
| 5 | AI 联动：`agentTools` 字段 + `studio.tools.register`（IDE 里的 AI 助手调用插件的功能）；`studio.agent.send`（把内容放进 AI 对话） |

插件用到哪个版本的接口，就在 manifest 里写 `"minApi"`。旧 IDE 不会装上用不了的插件（卡片会提示更新 IDE）；新 IDE 永远兼容旧插件。

如果某个功能只是“锦上添花”，不想因为它提高 `minApi`，可以运行时判断：

```js
if (studio.has('terminal.run')) showRunButton()
```

在 IDE 里扩展接口时：在 `src/renderer/src/market.ts` 的 `call()` 里加方法、加进 `METHODS`，在 `sdk/studio.js` 里加简写，`PLUGIN_API` 加 1，并更新上面的表。**不要改已有方法的参数和返回值**，只能新增。

### 页面里的 SDK

先加载 `studio.js`（打包时自动放进插件包），再加载你的脚本：

```html
<script src="studio.js"></script>
<script src="main.js"></script>
```

**当前文件（接口版本 1）**

```js
studio.onLoad((content, info) => {})      // 打开 / 重新加载文件；content 是字符串或 ArrayBuffer；info: { fileName, path, relPath }
studio.onSave(() => serialize())          // IDE 保存（Ctrl S）时调用，返回要写入的内容（可以返回 Promise）
studio.onSaved(() => {})                  // 保存完成
studio.setDirty(true)                     // 有未保存的修改
studio.onTheme((t) => {})                 // 主题变化；CSS 变量 --st-bg / --st-text / --st-accent 等会自动更新
studio.exportFile('图.png', blob)         // 另存为对话框
studio.toast('已完成')
studio.t('中文', 'English')               // 跟随 IDE 界面语言
studio.openText()                         // 用 IDE 的文本编辑器打开当前文件
studio.openLink('docs/a.md')              // 在 IDE 里打开工作区文件
studio.readAsset('img/a.png')             // 读取工作区里的任意文件 → Promise<Blob | null>
studio.watchAssets(['css/a.css'])         // 监视文件
studio.onAssetChanged((paths) => {})      // 被监视的文件在磁盘上变了
```

**扩展接口（接口版本 2）**：都返回 Promise，失败时 reject（例如没声明权限、路径超出工作区、IDE 太旧）。

路径相对于当前文件；以 `/` 开头时相对于工作区根目录。只能访问工作区（没打开工作区时为当前文件所在目录）。

```js
studio.api                                // IDE 支持的接口版本
studio.has('fs.write')                    // IDE 支不支持某个方法
studio.permissions                        // 这个插件拿到的权限
studio.call('fs.read', 'a.txt')           // 通用调用；下面都是它的简写

// 文件
await studio.fs.readText('data/a.csv')    // 字符串
await studio.fs.read('img/a.png')         // ArrayBuffer
await studio.fs.readJSON('/package.json')
await studio.fs.write('out/a.txt', text)  // 字符串 / ArrayBuffer / Blob；自动建上级目录（其他文件需 workspace-write）
await studio.fs.stat('src')               // { type: 'file' | 'dir', size, mtime } | null
await studio.fs.exists('a.txt')
await studio.fs.list('/src')              // [{ name, type, path }]
await studio.fs.files({ extension: '.md' }) // 工作区里的所有文件 ['/README.md', ...]（跳过 node_modules、.git）
await studio.fs.mkdir('out')              // workspace-write
await studio.fs.move('a.txt', 'b/a.txt')  // workspace-write
await studio.fs.delete('tmp.txt')         // 移到回收站；workspace-write（当前文件除外）
await studio.fs.watch(['data/a.csv'])     // 变化时调用 onAssetChanged(paths)

// 对话框
await studio.dialog.open({ extensions: ['csv'], multiple: true, encoding: 'utf8' }) // [{ name, data }]，可以选工作区外的文件
await studio.dialog.save('报告.pdf', blob)                                          // 保存的路径或 null

// 剪贴板
await studio.clipboard.writeText('hi')
await studio.clipboard.readText()         // clipboard-read

// 网络（network）：主进程发请求，不受跨域限制
const r = await studio.net.fetch('https://api.example.com/x', { method: 'POST', headers: {}, body: '...' })
r.status; r.headers; await r.json()

// 编辑器
await studio.editor.open('src/a.js', { line: 10 })  // 在 IDE 里打开文件，跳到某行
await studio.editor.setTitle('标题')                 // 改标签标题
await studio.editor.save()
await studio.editor.reload()                         // 从磁盘重新读取当前文件

// 界面
await studio.ui.confirm('确定删除？')     // true / false
await studio.ui.openExternal('https://…')
studio.onShow(() => {})                   // 插件标签切到前台

// 终端（terminal）
await studio.terminal.run('npm test', { cwd: '/', title: '测试' })

// 命令面板（插件标签显示时出现，标题前面会加插件名）
await studio.commands.register('export-pdf', '导出 PDF', () => exportPdf())
```

快捷键：Ctrl S 由 SDK 处理。页面里没处理的 Ctrl 组合键（命令面板、关闭标签等）会转给 IDE。如果插件自己要用某个组合键，请在 `document` 或元素上监听并调用 `preventDefault()`。

插件自己的设置可以存在 `localStorage` 里（每个插件单独一份，不会丢）。

### 语言包

语言包没有页面，只有一张翻译表。IDE 启动窗口时读取它，界面上的每一句话都按它显示。

```json
{
  "id": "lang-es",
  "name": "Español",
  "version": "1.0.0",
  "publisher": "Infinite Studio",
  "description": "…",
  "category": "locale",
  "minApi": 3,
  "icon": "icon.svg",
  "locale": { "code": "es", "name": "Español", "strings": "strings.json" }
}
```

| 字段 | 说明 |
| --- | --- |
| `category` | 必须是 `"locale"`，卡片显示在“多语言支持”分类 |
| `minApi` | 必须是 3（更老的 IDE 不认识语言包） |
| `locale.code` | BCP 47 语言代码（`es`、`pt-BR`…），也用于日期格式 |
| `locale.name` | 这种语言自己的名称，显示在多语言设置里 |
| `locale.strings` | 翻译表 JSON：键是界面源码里的中文原文（`src/renderer/src/i18n-en.ts` 和 `src/main/i18n.ts` 里 EN 表的键），值是译文，`{0}` `{1}` 等参数必须和原文一致 |

IDE 新加的文本在语言包里还没有译文时显示英文，所以语言包不用和 IDE 同步发布。打包脚本会检查参数是否一致，并列出还没翻译的条目；补上译文后改版本号重新发布即可。

插件页面（`studio.t(zh, en)`）在中文以外的界面语言下显示英文，实际界面语言在 load 消息的 `language` 字段里。

### 网页面板

有的网站不允许被 iframe 嵌入（网页版大模型都是这样），插件页面里显示不了。声明了 `webPanel` 的插件不需要页面：IDE 在编辑器右上角加一个按钮，点开后选择网站，网站在右侧分栏里打开（IDE 用独立的浏览器视图显示它，不是 iframe）。[网页大模型助手](plugins/web-ai) 就是这样做的。

```json
{
  "id": "web-ai",
  "category": "llm",
  "minApi": 4,
  "permissions": ["webPanel"],
  "webPanel": {
    "title": "网页大模型助手",
    "sites": [
      {
        "id": "claude",
        "name": "Claude",
        "url": "https://claude.ai/new",
        "icon": "sites/claude.svg",
        "hosts": ["claude.ai", "*.claude.ai", "*.anthropic.com", "accounts.google.com"],
        "input": ["div.ProseMirror[contenteditable=\"true\"]"]
      }
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `webPanel.title` | 右上角按钮的提示文字和选择弹窗的标题，不写时用插件名 |
| `sites[].id` | 小写字母、数字、连字符。每个网站的登录状态、缓存单独保存（按插件 id + 网站 id） |
| `sites[].url` | 首页，必须是 https。工具条上的“新对话”也回到这里 |
| `sites[].icon` | 包内的图标（SVG / PNG），显示在选择弹窗和标签上 |
| `sites[].hosts` | 网站自己的域名，以及第三方登录要经过的域名（`accounts.google.com` 等）。`*.example.com` 同时匹配 `example.com` 和它的子域名。网页在新标签页 / 新窗口打开这些域名时留在面板里（登录弹窗），其他链接用系统浏览器打开 |
| `sites[].input` | 输入框的 CSS 选择器，依次尝试。Alt K（引用当前文件 / 选中行）把内容粘贴进第一个找到的输入框；都找不到时再试页面上的 `textarea` 和可编辑区域，还找不到就把内容放进剪贴板 |

网页面板的规则：

- 每个网站一个独立的会话，和 IDE、和其他网站都隔离；网页运行在沙箱里，拿不到 IDE 的任何接口。卸载插件时清除它的所有网站数据
- User-Agent 是普通的 Chrome（去掉了 Electron 和 IDE 的标识），否则 Google 等登录页会拒绝
- 同一页面里的 https 跳转（例如单点登录跳到公司自己的登录页）留在面板里，这时工具条上显示那个网站的域名
- 麦克风 / 摄像头每次 IDE 运行期间第一次使用时询问用户；通知、定位等其他权限一律拒绝
- 网页获得焦点时，IDE 的全局快捷键（Ctrl K 命令面板、Ctrl W 关闭标签、Ctrl Tab、Ctrl \` 终端、F5 运行调试、Ctrl Esc 回到编辑器等）仍然归 IDE；复制粘贴、Ctrl F 等留给网页。Ctrl = / - / 0 缩放网页，Ctrl R 刷新，Alt ← / → 后退前进
- 面板隐藏超过 30 分钟会释放内存，再显示时重新打开原来的网址

### AI 联动（接口版本 5）

IDE 内置的 AI 对话（Claude Code、Codex、Gemini、Kimi Code、DeepSeek Harness）可以调用插件提供的功能。插件在 manifest 里用 `agentTools` 声明工具，在页面里实现：

```json
"agentTools": [
  {
    "name": "addNodes",
    "description": "Add nodes under a parent node …（给 AI 看的说明，英文效果最好）",
    "inputSchema": { "type": "object", "properties": { "parent": { "type": "string" } } },
    "readOnly": false,
    "timeout": 60
  }
]
```

```js
studio.tools.register('addNodes', async (args) => {
  // 修改文档（像用户操作一样进撤销历史、调用 setDirty）
  return { added: [] } // 字符串 / 可 JSON 化的对象 / { content: [...] }（MCP 格式）；抛错表示失败
})
studio.tools.register('render', () => studio.tools.image(canvas, 'Page 1')) // 返回图片
```

| 字段 | 说明 |
| --- | --- |
| `name` | 字母、数字、下划线。AI 看到的工具名是 `<插件 id>_<name>`（id 里的连字符换成下划线），例如 `pdf_getText` |
| `description` | 工具做什么、参数怎么用、坐标单位等。AI 只能靠它理解工具 |
| `inputSchema` | 参数的 JSON Schema（`type: "object"`）。**不要声明 `file`**：IDE 自动给每个工具加上 `file` 参数 |
| `readOnly` | `true`：只读取、不修改文档。AI 调用时不用征求用户同意，调用后也不保存 |
| `timeout` | 最长等多少秒（默认 60，最多 900），编译之类的慢操作要调大 |

IDE 怎么执行一次调用：

1. 按 `file` 参数找到文件（相对工作区根目录或绝对路径；不给时用用户正在看的那个）。没打开就在编辑器里打开它，等页面的 `onLoad` 处理完（`onLoad` 返回 Promise 时等它）。文件不存在、工具会修改文档、插件有 `newFile` 时，先按模板新建
2. 把参数交给页面里 `studio.tools.register` 注册的函数。同一个文件的调用排队执行
3. 不是 `readOnly` 的工具执行完后，如果文档有未保存的修改（`setDirty(true)`），IDE 自动保存，并在结果里告诉 AI（保存失败也会告诉它）

每个插件还自动有一个 `<id>_screenshot` 工具：IDE 把插件标签切到前台，截取它的画面给 AI 看。manifest 里也声明了 `screenshot` 的话，IDE 先调用页面里同名的函数（例如翻到某一页、切换视图），它的说明和参数会合并进去，返回的文字附在截图后面。

文本格式的文件（`.md`、`.tex`、`.html` 等）AI 用它自己的工具直接改就行。插件工具适合做 AI 自己做不到的事：读写二进制格式（PDF、PPTX）、看渲染效果、编译、读预览里的控制台。

页面里也可以把内容交给 AI：

```js
await studio.agent.send('请解释这一段：\n> …', { file: true }) // 放进最近使用的 AI 对话的输入框（不会自动发送）；file: true 时一起 @ 当前文件
```

两个功能都只在新 IDE 上有。不想因此提高 `minApi` 时，用 `studio.has('agent.send')` 判断；`agentTools` 在旧 IDE 上会被忽略。

工作原理：IDE 把这些工具注册成 MCP 服务 `infinite-studio` 的工具。Claude Code 的对话通过它的 SDK MCP 通道直接调用；Codex 和 ACP 系的对话（Gemini、Kimi Code、DeepSeek Harness）启动时会带上一个本地的 MCP 桥接（Electron 自带的 Node 运行的小脚本，通过命名管道连回 IDE）。

### 安全限制

- 插件页面和 IDE 不同源，拿不到 IDE 的任何接口，只能通过 SDK。
- 文件访问只限工作区；写入当前文件以外的文件、读剪贴板、联网、运行命令都要在 manifest 里声明权限，并显示在插件卡片上。
- 页面的 CSP 禁止联网：所有脚本、样式、字体、wasm 都要打进插件包（声明了 `network` 权限的除外）。
- 页面里可以再嵌 iframe（`srcdoc`、`blob:`、`data:`），它继承插件页面的 CSP。HTML 预览器就是这样显示网页的：预览框不带 `allow-same-origin`，拿不到插件页面的 SDK。

## 发布

需要 Node.js 22+。在 IDE 仓库根目录执行：

```bash
# 1. 改 marketplace/plugins/<id>/manifest.json 里的 version
# 2. 打包：生成 packages/<id>-<版本>.zip，并更新 registry.json
node marketplace/pack.mjs mindmap
# 3. 提交并推送 marketplace/（registry.json 和 packages/ 都要提交）
git add marketplace && git commit -m "Release mindmap 1.0.1" && git push
```

推送后几分钟内，用户在 IDE 插件面板点“重新检测”就能看到“更新”按钮。

- **已发布的版本号不能改内容。** CDN 会缓存旧的插件包，用户下载到旧包时 sha256 对不上，就装不了。所以内容变了必须换新版本号；打包脚本发现同一版本内容不同时会直接报错。
- **插件包不放 GitHub Releases。** Releases 是 IDE 自己的版本，IDE 的“检查更新”读的是最新 Release。
