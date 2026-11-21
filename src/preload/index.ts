import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/types'

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
    gitBranch: (root) => ipcRenderer.invoke('fs:gitBranch', root)
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
