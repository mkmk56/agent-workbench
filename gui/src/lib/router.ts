import { useEffect, useState } from 'react';
import type { Route } from '../types';

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/tasks';
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'tasks' && parts.length === 2) {
    return { name: 'task', id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'dispatch') {
    return { name: 'dispatch' };
  }
  if (parts[0] === 'settings') {
    return { name: 'settings' };
  }
  if (parts[0] === 'about') {
    return { name: 'about' };
  }
  return { name: 'tasks' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/tasks');
    }
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

export function navigate(path: string): void {
  const next = path.startsWith('/') ? path : `/${path}`;
  if (window.location.hash !== `#${next}`) {
    window.location.hash = next;
  }
}