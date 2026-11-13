import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, EngineAgent, EngineResult, OperationResult } from '../types';

export const FALLBACK_APP_INFO: AppInfo = {
  name: 'Agent Workbench',
  version: '0.1.0',
  dataDir: '（浏览器预览：主进程未连接）',
  cwd: '（浏览器预览：主进程未连接）',
  engineWorkdir: '',
  platform: 'browser',
  arch: '',
  isPackaged: false,
  tokenStored: false,
  encryptionAvailable: false,
  update: {
    supported: false,
    channel: 'stable',
    reason: '浏览器预览：主进程未连接。',
  },
  versions: {
    electron: '—',
    node: '—',
    chrome: navigator.userAgent,
  },
};

let pending: Promise<AppInfo> | null = null;

export function loadAppInfo(force = false): Promise<AppInfo> {
  if (!window.workbench) {
    return Promise.resolve(FALLBACK_APP_INFO);
  }
  if (force || pending == null) {
    pending = window.workbench.getAppInfo().catch(() => FALLBACK_APP_INFO);
  }
  return pending;
}

export function useAppInfo(): { info: AppInfo; refresh: () => Promise<AppInfo> } {
  const [info, setInfo] = useState<AppInfo>(FALLBACK_APP_INFO);

  useEffect(() => {
    let alive = true;
    void loadAppInfo().then((next) => {
      if (alive) {
        setInfo(next);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await loadAppInfo(true);
    setInfo(next);
    return next;
  }, []);

  return { info, refresh };
}

export async function copyText(text: string): Promise<boolean> {
  if (window.workbench) {
    const result = await window.workbench.copyText(text);
    return result.ok;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function openExternal(url: string): Promise<OperationResult> {
  if (window.workbench) {
    return window.workbench.openExternal(url);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return { ok: true };
}

export function platformLabel(platform: string, arch: string): string {
  const names: Record<string, string> = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
  };
  const name = names[platform] ?? platform;
  return arch ? `${name} · ${arch}` : name;
}

const NO_MAIN_PROCESS = '主进程未连接（浏览器预览）。';

export function engineUnavailable<T>(): Promise<EngineResult<T>> {
  return Promise.resolve({ ok: false, error: NO_MAIN_PROCESS });
}

export async function testToken(): Promise<EngineResult<EngineAgent[]>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN_PROCESS };
  }
  const result = await window.workbench.getAgentInfo();
  if (!result.ok) {
    return result;
  }
  return { ok: true, data: result.data.agents };
}