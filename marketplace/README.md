# Infinite Studio 插件市场

Infinite Studio（无界工作室）的官方插件。IDE 的插件面板里，“生产力工具”一栏的列表就来自这里的 `registry.json`。用户点击“安装”后，IDE 下载 `packages/` 里的插件包（先试 jsDelivr，再试 raw.githubusercontent），校验 sha256，再解压安装。

这个目录不会被打进 IDE 安装包，IDE 只在运行时从 GitHub 读取它。

| 插件 | 说明 |
| --- | --- |
| [Markdown 美化](plugins/markdown) | 打开 `.md` 文件。阅读 / 分栏 / 源码三种模式：标题编号、提示块、代码高亮与复制、任务进度、大纲与阅读进度，分栏滚动同步；四套主题，导出 HTML |
| [思维导图](plugins/mindmap) | 打开 `.mind` 文件。用键盘快速建主题，拖拽调整结构，可折叠分支，导出 PNG / SVG / Markdown |
| [演示文稿](plugins/pptx) | 打开和编辑 `.pptx`：按原样式显示（主题、母版、表格、图表、SmartArt），改文字和格式，移动 / 缩放 / 旋转形状，插入文本框、形状、图片、表格，增删 / 复制 / 排序幻灯片，备注，放映 |

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
  "icon": "icon.svg",
  "editor": { "entry": "index.html", "extensions": [".mind"], "binary": false },
  "newFile": { "label": "思维导图", "extension": ".mind", "template": "" }
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 小写字母、数字、连字符，必须和目录名相同 |
| `version` | `x.y.z`。发布新版本前先改这里 |
| `minStudio` | 需要的最低 IDE 版本。IDE 版本更低时拒绝安装 |
| `editor.extensions` | 由这个插件打开的文件扩展名 |
| `editor.binary` | `true`：文件按二进制读写（PDF、PPTX 等），页面收到的是 `ArrayBuffer` |
| `newFile` | 可选。在插件卡片和命令面板里加一个“新建…”命令 |

### 页面里的 SDK

先加载 `studio.js`（打包时自动放进插件包），再加载你的脚本：

```html
<script src="studio.js"></script>
<script src="main.js"></script>
```

```js
studio.onLoad((content, info) => { /* 打开文件；content 是字符串或 ArrayBuffer */ })
studio.onSave(() => serialize())          // IDE 保存（Ctrl S）时调用，返回要写入的内容
studio.setDirty(true)                     // 有未保存的修改
studio.onTheme((t) => {})                 // 主题变化；CSS 变量 --st-bg / --st-text / --st-accent 等会自动更新
studio.exportFile('图.png', blob)         // 另存为对话框
studio.toast('已完成')
studio.t('中文', 'English')               // 跟随 IDE 界面语言
studio.openText()                         // 用 IDE 的文本编辑器打开当前文件
studio.openLink('docs/a.md')              // 打开相对于当前文件的链接（只限工作区内）
studio.readAsset('img/a.png')             // 读取相对于当前文件的图片 → Promise<Blob | null>（只限工作区内）
```

快捷键：Ctrl S 由 SDK 处理。页面里没处理的 Ctrl 组合键（命令面板、关闭标签等）会转给 IDE。如果插件自己要用某个组合键，请在 `document` 或元素上监听并调用 `preventDefault()`。

### 安全限制

- 插件页面和 IDE 不同源，拿不到 IDE 的任何接口，只能通过 SDK 读写**当前打开的文件**。
- 页面的 CSP 禁止联网：所有脚本、样式、字体、wasm 都要打进插件包。

## 发布

需要 Node.js 22+。在 IDE 仓库根目录执行：

```bash
# 1. 改 marketplace/plugins/<id>/manifest.json 里的 version
# 2. 打包：生成 packages/<id>-<版本>.zip，并更新 registry.json
node marketplace/pack.mjs mindmap
# 3. 提交并推送 marketplace/（registry.json 和 packages/ 都要提交）
git add marketplace && git commit -m "发布 mindmap v1.0.1" && git push
```

推送后几分钟内，用户在 IDE 插件面板点“重新检测”就能看到“更新”按钮。

- **已发布的版本号不能改内容。** CDN 会缓存旧的插件包，用户下载到旧包时 sha256 对不上，就装不了。所以内容变了必须换新版本号；打包脚本发现同一版本内容不同时会直接报错。
- **插件包不放 GitHub Releases。** Releases 是 IDE 自己的版本，IDE 的“检查更新”读的是最新 Release。
