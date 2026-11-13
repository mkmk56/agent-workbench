import type { WorkbenchApi } from './types';

declare global {
  interface Window {
    workbench?: WorkbenchApi;
  }
}

export {};