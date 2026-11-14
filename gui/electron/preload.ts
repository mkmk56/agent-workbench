import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateChannel, UpdateState } from './update';

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
  listMessages: (limit?: number) => ipcRenderer.invoke('engine:message-list', limit),
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
  getHudConfig: () => ipcRenderer.invoke('hud:get-config'),
  setHudConfig: (patch: { paperPlanes?: boolean }) =>
    ipcRenderer.invoke('hud:set-config', patch),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  installUpdate: () =>
    ipcRenderer.invoke('update:install') as Promise<{ ok: boolean; error?: string }>,
  setUpdateChannel: (channel: UpdateChannel): Promise<UpdateState> =>
    ipcRenderer.invoke('update:set-channel', channel),
  onUpdateState: (callback: (state: UpdateState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('update:state', listener);
    return () => {
      ipcRenderer.removeListener('update:state', listener);
    };
  },
};

contextBridge.exposeInMainWorld('workbench', workbench);