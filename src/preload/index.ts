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
  locale: ipcRenderer.sendSync('app:locale') as 'zh' | 'en' | null,
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    reload: () => ipcRenderer.send('win:reload')
  },
  fs: {
    openFolderDialog: () => ipcRenderer.invoke('fs:openFolderDialog'),
    readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', p, content),
    readBinary: (p) => ipcRenderer.invoke('fs:readBinary', p),
    openPath: (p) => ipcRenderer.invoke('fs:openPath', p),
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
  git: {
    log: (root, limit) => ipcRenderer.invoke('git:log', root, limit),
    changes: (root, hash) => ipcRenderer.invoke('git:changes', root, hash),
    status: (root) => ipcRenderer.invoke('git:status', root),
    init: (root) => ipcRenderer.invoke('git:init', root),
    stage: (root, paths) => ipcRenderer.invoke('git:stage', root, paths),
    unstage: (root, paths) => ipcRenderer.invoke('git:unstage', root, paths),
    discard: (root, tracked, untracked) => ipcRenderer.invoke('git:discard', root, tracked, untracked),
    commit: (root, message, opts) => ipcRenderer.invoke('git:commit', root, message, opts),
    run: (root, op) => ipcRenderer.invoke('git:run', root, op),
    show: (root, ref, path) => ipcRenderer.invoke('git:show', root, ref, path),
    lastMessage: (root) => ipcRenderer.invoke('git:lastMessage', root),
    branches: (root) => ipcRenderer.invoke('git:branches', root),
    checkout: (root, name, opts) => ipcRenderer.invoke('git:checkout', root, name, opts)
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
  },
  plugins: {
    detect: (id) => ipcRenderer.invoke('plugins:detect', id)
  },
  agent: {
    start: (req) => ipcRenderer.invoke('agent:start', req),
    write: (runId, msg) => ipcRenderer.send('agent:write', runId, msg),
    stop: (runId) => ipcRenderer.send('agent:stop', runId),
    sessions: (plugin, cwd) => ipcRenderer.invoke('agent:sessions', plugin, cwd),
    transcript: (plugin, cwd, id) => ipcRenderer.invoke('agent:transcript', plugin, cwd, id),
    saveImage: (dataUrl) => ipcRenderer.invoke('agent:saveImage', dataUrl),
    onEvent: (cb) => subscribe('agent:event', cb),
    onExit: (cb) => subscribe('agent:exit', cb),
    claudeLogin: (method) => ipcRenderer.invoke('agent:claudeLogin', method),
    loginWrite: (loginId, text) => ipcRenderer.send('agent:loginWrite', loginId, text),
    loginCancel: (loginId) => ipcRenderer.send('agent:loginCancel', loginId),
    onLogin: (cb) => subscribe('agent:login', cb),
    claudeLogout: () => ipcRenderer.invoke('agent:claudeLogout'),
    dailyUsage: (plugin) => ipcRenderer.invoke('agent:dailyUsage', plugin)
  },
  ide: {
    register: () => ipcRenderer.send('ide:register'),
    onCall: (cb) => subscribe('ide:call', cb),
    onCancel: (cb) => subscribe('ide:cancel', cb),
    onStatus: (cb) => subscribe('ide:status', cb),
    result: (id, r) => ipcRenderer.send('ide:result', id, r),
    setWorkspace: (folders) => ipcRenderer.send('ide:workspace', folders),
    selection: (sel) => ipcRenderer.send('ide:selection', sel),
    atMention: (params) => ipcRenderer.invoke('ide:atMention', params)
  },
  account: {
    get: () => ipcRenderer.invoke('account:get'),
    hasDeviceFlow: () => ipcRenderer.invoke('account:hasDeviceFlow'),
    loginToken: (token) => ipcRenderer.invoke('account:loginToken', token),
    loginGh: () => ipcRenderer.invoke('account:loginGh'),
    deviceStart: () => ipcRenderer.invoke('account:deviceStart'),
    devicePoll: () => ipcRenderer.invoke('account:devicePoll'),
    deviceCancel: () => ipcRenderer.invoke('account:deviceCancel'),
    logout: () => ipcRenderer.invoke('account:logout')
  }
}

contextBridge.exposeInMainWorld('api', api)
