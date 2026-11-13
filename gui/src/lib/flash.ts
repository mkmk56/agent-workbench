const FLASH_KEY = 'workbench.flash';

export function setFlash(message: string): void {
  try {
    window.sessionStorage.setItem(FLASH_KEY, message);
  } catch {
    // Session storage is best effort; the navigation still works without it.
  }
}

export function takeFlash(): string | null {
  try {
    const value = window.sessionStorage.getItem(FLASH_KEY);
    if (value != null) {
      window.sessionStorage.removeItem(FLASH_KEY);
    }
    return value;
  } catch {
    return null;
  }
}