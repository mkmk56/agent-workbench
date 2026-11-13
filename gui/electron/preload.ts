import { contextBridge, ipcRenderer } from 'electron';

const workbench = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  setToken: (token: string) => ipcRenderer.invoke('credentials:set-token', token),
  clearToken: () => ipcRenderer.invoke('credentials:clear-token'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  copyText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  getEngineStatus: () => ipcRenderer.invoke('engine:status'),
  startEngine: () => ipcRenderer.invoke('engine:start'),
  stopEngine: () => ipcRenderer.invoke('engine:stop'),
  getAgentInfo: () => ipcRenderer.invoke('engine:agent-info'),
  listTasks: (limit?: number) => ipcRenderer.invoke('engine:task-list', limit),
  getTaskStatus: (taskId: string) => ipcRenderer.invoke('engine:task-status', taskId),
  getTaskLogs: (input: { taskId: string; cursor?: number; limit?: number }) =>
    ipcRenderer.invoke('engine:task-logs', input),
  startTask: (input: {
    agent: 'claude' | 'dsh';
    prompt: string;
    cwd?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke('engine:task-start', input),
  sendTask: (taskId: string, prompt: string) =>
    ipcRenderer.invoke('engine:task-send', taskId, prompt),
  cancelTask: (taskId: string) => ipcRenderer.invoke('engine:task-cancel', taskId),
};

contextBridge.exposeInMainWorld('workbench', workbench);