import type { ReactNode } from 'react';
import { useEngineStatus } from '../lib/engine';
import type { AppTheme } from '../lib/theme';
import type { AppInfo, Route } from '../types';
import { ChatSidebar } from './ChatSidebar';
import { GlobalNav } from './GlobalNav';

/**
 * App frame (Muse, group-chat upgrade).
 *
 * Layout: global nav rail | session list (chat routes only) | main.
 * The old topbar is gone — navigation, engine status, theme, settings and
 * help all live in the rail. The Agent HUD capsule lives inside the rail
 * (see GlobalNav); legacy task pages stay on their routes.
 */
export function AppFrame({
  route,
  mode,
  onToggleTheme,
  appInfo,
  children,
}: {
  route: Route;
  mode: AppTheme;
  onToggleTheme: () => void;
  appInfo: AppInfo;
  children: ReactNode;
}) {
  const { status } = useEngineStatus(5_000);

  const isChatRoute = route.name === 'chats' || route.name === 'chat';

  return (
    <div className={`app${isChatRoute ? ' app--chat' : ''}`}>
      <GlobalNav
        route={route}
        mode={mode}
        onToggleTheme={onToggleTheme}
        appInfo={appInfo}
        engine={status}
      />

      {isChatRoute && <ChatSidebar route={route} />}

      <main className="main">
        <div className={`content${isChatRoute ? ' content--chat' : ''}`}>{children}</div>
      </main>
    </div>
  );
}
