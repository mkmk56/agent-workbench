import { useEffect, useState } from 'react';

export type AppTheme = 'light' | 'dark';

const STORAGE_KEY = 'agent-workbench.theme';

function initialTheme(): AppTheme {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') {
      return saved;
    }
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useAppTheme(): { mode: AppTheme; toggleTheme: () => void } {
  const [mode, setMode] = useState<AppTheme>(initialTheme);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }, [mode]);

  return {
    mode,
    toggleTheme: () => setMode((current) => (current === 'light' ? 'dark' : 'light')),
  };
}