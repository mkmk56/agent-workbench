import { contextBridge, ipcRenderer } from 'electron';

const workbench = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  setToken: (token: string) => ipcRenderer.invoke('credentials:set-token', token),
  clearToken: () => ipcRenderer.invoke('credentials:clear-token'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
};

contextBridge.exposeInMainWorld('workbench', workbench);