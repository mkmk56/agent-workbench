const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  info: () => ipcRenderer.invoke('app:info'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  startEngine: (options) => ipcRenderer.invoke('engine:start', options),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  listTasks: (payload) => ipcRenderer.invoke('tasks:list', payload),
  taskLogs: (payload) => ipcRenderer.invoke('tasks:logs', payload),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  ready: () => ipcRenderer.send('renderer:ready'),
  onUpdateEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('update:event', handler);
    return () => ipcRenderer.removeListener('update:event', handler);
  }
});