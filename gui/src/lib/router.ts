import { useEffect, useState } from 'react';
import type { Route } from '../types';

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/chats';
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'chats' && parts.length === 3 && parts[2] === 'settings') {
    return { name: 'chat-settings', id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'chats' && parts.length === 2) {
    return { name: 'chat', id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'chats') {
    return { name: 'chats' };
  }
  // Hidden debug routes: the task console is no longer in the nav,
  // but the pages still work (linked from a message's "查看执行记录").
  if (parts[0] === 'tasks' && parts.length === 2 && parts[1] === 'history') {
    return { name: 'tasks', scope: 'history' };
  }
  if (parts[0] === 'tasks' && parts.length === 2) {
    return { name: 'task', id: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === 'tasks') {
    return { name: 'tasks' };
  }
  if (parts[0] === 'files') {
    return { name: 'files' };
  }
  if (parts[0] === 'inbox') {
    return { name: 'inbox' };
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
  // Hidden preview route (Lucide ⇄ Reicon comparison). Deliberately not in
  // the nav rail and not reachable from any production screen.
  if (parts[0] === 'preview' && parts[1] === 'reicon') {
    return { name: 'preview-reicon' };
  }
  return { name: 'chats' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/chats');
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