import { contextBridge, ipcRenderer } from 'electron'
import type { LocalePack } from '../shared/plugins'
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
  locale: ipcRenderer.sendSync('app:locale') as string | null,
  localePack: ipcRenderer.sendSync('app:localePack') as LocalePack | null,
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    reload: () => ipcRenderer.send('win:reload'),
    newWindow: (open) => ipcRenderer.send('win:new', open)
  },
  project: {
    home: () => ipcRenderer.invoke('project:home'),
    pickLocation: (start) => ipcRenderer.invoke('project:pickLocation', start),
    probe: (kind) => ipcRenderer.invoke('project:probe', kind),
    target: (location, name) => ipcRenderer.invoke('project:target', location, name),
    freeName: (location, base) => ipcRenderer.invoke('project:freeName', location, base),
    create: (opts) => ipcRenderer.invoke('project:create', opts)
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    checkUpdate: () => ipcRenderer.invoke('app:checkUpdate')
  },
  fs: {
    openFolderDialog: () => ipcRenderer.invoke('fs:openFolderDialog'),
    readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, content, enc) => ipcRenderer.invoke('fs:writeFile', p, content, enc),
    readBinary: (p) => ipcRenderer.invoke('fs:readBinary', p),
    writeBinary: (p, data) => ipcRenderer.invoke('fs:writeBinary', p, data),
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
  market: {
    registry: (force) => ipcRenderer.invoke('market:registry', !!force),
    installed: () => ipcRenderer.invoke('market:installed'),
    install: (id) => ipcRenderer.invoke('market:install', id),
    uninstall: (id) => ipcRenderer.invoke('market:uninstall', id),
    exportFile: (name, data) => ipcRenderer.invoke('market:exportFile', name, data),
    stat: (p) => ipcRenderer.invoke('market:stat', p),
    mkdirp: (p) => ipcRenderer.invoke('market:mkdirp', p),
    move: (from, to) => ipcRenderer.invoke('market:move', from, to),
    openFiles: (opts) => ipcRenderer.invoke('market:openFiles', opts),
    readExternal: (p) => ipcRenderer.invoke('market:readExternal', p),
    clipboard: (id, op, text) => ipcRenderer.invoke('market:clipboard', id, op, text),
    fetch: (id, url, init) => ipcRenderer.invoke('market:fetch', id, url, init),
    onProgress: (cb) => subscribe('market:progress', cb),
    capture: (rect) => ipcRenderer.invoke('market:capture', rect)
  },
  webPanel: {
    create: (opts) => ipcRenderer.invoke('webpanel:create', opts),
    layout: (id, rect) => ipcRenderer.send('webpanel:layout', id, rect),
    focus: (id) => ipcRenderer.send('webpanel:focus', id),
    nav: (id, action) => ipcRenderer.send('webpanel:nav', id, action),
    zoom: (id, level) => ipcRenderer.send('webpanel:zoom', id, level),
    capture: (id) => ipcRenderer.invoke('webpanel:capture', id),
    insert: (id, text) => ipcRenderer.invoke('webpanel:insert', id, text),
    external: (id) => ipcRenderer.send('webpanel:external', id),
    devtools: (id) => ipcRenderer.send('webpanel:devtools', id),
    clearData: (id) => ipcRenderer.invoke('webpanel:clearData', id),
    destroy: (id) => ipcRenderer.send('webpanel:destroy', id),
    onState: (cb) => subscribe('webpanel:state', cb),
    onKey: (cb) => subscribe('webpanel:key', cb),
    onFocus: (cb) => subscribe('webpanel:focus', cb)
  },
  plugins: {
    detect: (id) => ipcRenderer.invoke('plugins:detect', id),
    runPlan: (id, file) => ipcRenderer.invoke('plugins:runPlan', id, file)
  },
  debug: {
    start: (pluginId, file) => ipcRenderer.invoke('debug:start', pluginId, file),
    send: (session, msg) => ipcRenderer.send('debug:send', session, msg),
    stop: (session) => ipcRenderer.send('debug:stop', session),
    onMessage: (cb) => subscribe('debug:message', cb),
    onExit: (cb) => subscribe('debug:exit', cb)
  },
  jupyter: {
    start: (opts) => ipcRenderer.invoke('jupyter:start', opts),
    send: (session, msg) => ipcRenderer.send('jupyter:send', session, msg),
    stop: (session) => ipcRenderer.send('jupyter:stop', session),
    onEvent: (cb) => subscribe('jupyter:event', cb),
    onExit: (cb) => subscribe('jupyter:exit', cb)
  },
  sysmon: {
    subscribe: (cb) => {
      const off = subscribe('sysmon:sample', cb)
      ipcRenderer.send('sysmon:subscribe')
      return () => {
        off()
        ipcRenderer.send('sysmon:unsubscribe')
      }
    }
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
    kimiLogin: () => ipcRenderer.invoke('agent:kimiLogin'),
    deepseekKeyStatus: () => ipcRenderer.invoke('agent:deepseekKeyStatus'),
    setDeepseekKey: (key) => ipcRenderer.invoke('agent:setDeepseekKey', key),
    deepseekSessionMeta: (ids) => ipcRenderer.invoke('agent:deepseekSessionMeta', ids),
    dailyUsage: (plugin) => ipcRenderer.invoke('agent:dailyUsage', plugin),
    mcpServers: () => ipcRenderer.invoke('agent:mcpServers')
  },
  agentTools: {
    onRequest: (cb) => subscribe('agentTools:request', cb),
    reply: (id, result) => ipcRenderer.send('agentTools:reply', id, result),
    awake: (on) => ipcRenderer.send('agentTools:awake', !!on)
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
