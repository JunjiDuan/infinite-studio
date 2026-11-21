# 无界工作室 · Infinite Studio

极简、高度个性化的桌面 IDE。界面只有灰阶加一个你选的强调色；主题、强调色、字体、字号和布局打包成一个“空间”，可以绑定到项目、导出分享。

技术栈：Electron + Vite（electron-vite）+ TypeScript + Monaco Editor，界面层没有用框架。

## 功能

- **编辑**：Monaco 编辑器、标签页、未保存标记、全部保存
- **单强调色主题**：墨 / 纸 / 暮三套主题，强调色自动校正对比度
- **空间**：主题 + 强调色 + 字体 + 字号 + 布局（经典 / 极简 / 专注），可保存、绑定项目、导出 `.infinite-space`
- **命令面板** `Ctrl K`：模糊搜索文件和命令
- **文件树**：新建、重命名、删除（进回收站）、右键菜单；磁盘变化自动同步，未修改的已打开文件自动重新加载
- **全局搜索与替换** `Ctrl Shift F`：区分大小写 / 全字匹配 / 正则，全部替换时跳过未保存的文件
- **集成终端** `` Ctrl ` ``：多终端，配色跟随空间
- **语言服务（LSP）**：诊断、补全、悬停、参数提示、转到定义 / 类型定义 / 实现、查找引用、跨文件重命名、格式化、大纲
  - TypeScript / JavaScript：内置 TypeScript 7 原生语言服务，开箱即用
  - Python（pyright / pylsp）、Rust（rust-analyzer）、Go（gopls）、C/C++（clangd）：装在 PATH 里就会自动接上
- **专注模式** `Ctrl .`

## 运行与打包

```bash
npm install
npm run dev        # 开发模式，带热更新
npm run build      # 构建到 out/
npm start          # 运行构建后的版本
npm run typecheck  # 类型检查
npm run dist       # 打包 Windows 安装程序到 release/
npm run pack       # 只生成免安装目录 release/win-unpacked（调试打包用）
npm run icon       # 重新生成 build/icon.png
```

> npm 脚本通过 `scripts/run.cjs` 启动，会先清掉 `ELECTRON_RUN_AS_NODE`。某些终端（例如 VS Code 扩展）会注入这个变量，导致 Electron 被当成纯 Node 启动而直接崩溃。
>
> 打包不需要 MSVC：终端用的 `@lydell/node-pty` 自带 N-API 预编译二进制，配置里关掉了 `npmRebuild`。安装程序未签名，首次运行时 Windows SmartScreen 可能会提示。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl K` / `Ctrl P` | 命令面板：搜文件和命令（输入 `>` 只搜命令） |
| `Ctrl Shift F` | 在文件中搜索 / 替换 |
| `` Ctrl ` `` / `` Ctrl Shift ` `` | 显示 / 隐藏终端，新建终端 |
| `Ctrl O` | 打开文件夹 |
| `Ctrl S` | 保存 |
| `Ctrl W` | 关闭标签 |
| `Ctrl Tab` | 切换标签 |
| `Ctrl B` | 显示 / 隐藏侧栏 |
| `Ctrl .` | 专注模式（`Esc` 退出） |
| `Ctrl ,` | 个性化设置 |
| `Ctrl =` / `Ctrl -` | 字号 |
| `Alt Z` | 自动换行 |
| `F12` / `Shift F12` | 转到定义 / 查找引用 |
| `F2` | 重命名符号（在文件树里是重命名文件） |
| `Shift Alt F` | 格式化文档 |
| `Ctrl Shift O` | 转到文件中的符号 |
| `Delete`（文件树） | 移到回收站 |
| `Ctrl Shift I` | 开发者工具 |

## 目录结构

```
src/
  main/
    index.ts             窗口、设置持久化、空间导入导出
    fsService.ts         文件读写、新建 / 重命名 / 删除、递归文件监听
    search.ts            全局搜索与替换
    terminal.ts          node-pty 终端
    lsp.ts               语言服务发现、启动、消息分帧
  preload/index.ts       通过 contextBridge 暴露安全的 window.api
  shared/types.ts        主进程与界面共用的类型
  renderer/
    index.html
    src/
      main.ts            界面骨架、布局模式、快捷键、命令注册
      store.ts           状态、空间预设、事件订阅、设置持久化
      theme.ts           三套主题、强调色对比度校正、CSS 变量
      monaco.ts          Monaco worker、单强调色语法主题、语言识别
      editor.ts          标签页、模型、保存、磁盘重新加载、改名跟随
      tree.ts            文件树、右键菜单、行内新建 / 重命名
      search.ts          搜索视图
      panel.ts           终端面板（xterm.js）
      lsp.ts             LSP 客户端
      palette.ts         命令面板 + 模糊搜索
      settingsView.ts    个性化“空间”页 + 实时预览
      menu.ts            右键菜单组件
      styles.css
scripts/                 启动脚本、图标生成
build/icon.png           应用图标
```

设置保存在 `%APPDATA%/Infinite Studio/settings.json`。

## 调试

在开发者工具控制台执行 `localStorage.setItem('debug', '1')` 后刷新，可通过 `window.__infinite` 访问 Monaco 实例、编辑器和语言服务请求，开发模式下默认开启。
