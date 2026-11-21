# 无界工作室 · Infinite Studio

极简、高度个性化的桌面 IDE。界面只有灰阶加一个你选的强调色；主题、强调色、字体、字号和布局打包成一个“空间”，可以绑定到项目、导出分享。

技术栈：Electron + Vite（electron-vite）+ TypeScript + Monaco Editor，界面层没有用框架。

## 运行

```bash
npm install
npm run dev        # 开发模式，带热更新
npm run build      # 打包到 out/
npm start          # 运行打包后的版本
npm run typecheck  # 类型检查
```

> npm 脚本通过 `scripts/run.cjs` 启动，会先清掉 `ELECTRON_RUN_AS_NODE`。某些终端（例如 VS Code 扩展）会注入这个变量，导致 Electron 被当成纯 Node 启动而直接崩溃。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl K` / `Ctrl P` | 命令面板：搜文件和命令（输入 `>` 只搜命令） |
| `Ctrl O` | 打开文件夹 |
| `Ctrl S` | 保存 |
| `Ctrl W` | 关闭标签 |
| `Ctrl Tab` | 切换标签 |
| `Ctrl B` | 显示 / 隐藏文件栏 |
| `Ctrl .` | 专注模式（`Esc` 退出） |
| `Ctrl ,` | 个性化设置 |
| `Ctrl =` / `Ctrl -` | 字号 |
| `Alt Z` | 自动换行 |
| `F12` | 开发者工具 |

## 目录结构

```
src/
  main/index.ts          主进程：无边框窗口、文件读写、设置持久化、空间导入导出
  preload/index.ts       通过 contextBridge 暴露安全的 window.api
  shared/types.ts        主进程与界面共用的类型（Space、Settings、Api）
  renderer/
    index.html
    src/
      main.ts            界面骨架、布局模式、快捷键、命令注册
      store.ts           状态、空间预设、事件订阅、设置持久化
      theme.ts           三套主题、强调色对比度自动校正、CSS 变量
      monaco.ts          Monaco worker 配置、单强调色语法主题、语言识别
      editor.ts          标签页、模型、保存、未保存标记
      tree.ts            懒加载文件树
      palette.ts         命令面板 + 模糊搜索
      settingsView.ts    个性化“空间”页 + 实时预览
      styles.css
```

设置保存在 `%APPDATA%/Infinite Studio/settings.json`。
