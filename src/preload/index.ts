import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/types'

/** 订阅主进程推送的事件，返回取消订阅函数（不把 event 对象暴露给页面） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function subscribe<A extends any[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  platform: process.platform,
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close')
  },
  fs: {
    openFolderDialog: () => ipcRenderer.invoke('fs:openFolderDialog'),
    readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', p, content),
    listFiles: (root) => ipcRenderer.invoke('fs:listFiles', root),
    gitBranch: (root) => ipcRenderer.invoke('fs:gitBranch', root),
    createFile: (dir, name) => ipcRenderer.invoke('fs:createFile', dir, name),
    createDir: (dir, name) => ipcRenderer.invoke('fs:createDir', dir, name),
    rename: (from, newName) => ipcRenderer.invoke('fs:rename', from, newName),
    trash: (p) => ipcRenderer.invoke('fs:trash', p),
    reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
    watch: (root) => ipcRenderer.invoke('fs:watch', root),
    onChanged: (cb) => subscribe('fs:changed', cb)
  },
  term: {
    create: (opts) => ipcRenderer.invoke('term:create', opts),
    write: (id, data) => ipcRenderer.send('term:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('term:kill', id),
    onData: (cb) => subscribe('term:data', cb),
    onExit: (cb) => subscribe('term:exit', cb)
  },
  lsp: {
    servers: () => ipcRenderer.invoke('lsp:servers'),
    start: (serverId, root) => ipcRenderer.invoke('lsp:start', serverId, root),
    send: (session, msg) => ipcRenderer.send('lsp:send', session, msg),
    stop: (session) => ipcRenderer.send('lsp:stop', session),
    onMessage: (cb) => subscribe('lsp:message', cb),
    onExit: (cb) => subscribe('lsp:exit', cb)
  },
  search: {
    run: (id, root, query, opts) => ipcRenderer.invoke('search:run', id, root, query, opts),
    replace: (query, opts, replacement, files) => ipcRenderer.invoke('search:replace', query, opts, replacement, files)
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (s) => ipcRenderer.invoke('settings:save', s)
  },
  space: {
    export: (space) => ipcRenderer.invoke('space:export', space),
    import: () => ipcRenderer.invoke('space:import')
  }
}

contextBridge.exposeInMainWorld('api', api)
