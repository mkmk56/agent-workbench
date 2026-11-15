import { Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { AgentHud } from './AgentHud';
import { ChatSidebar } from './ChatSidebar';
import { useEngineStatus } from '../lib/engine';
import type { AppTheme } from '../lib/theme';
import type { AppInfo, Route } from '../types';
import { AppIconButton, AppStatus } from '../ui/astryx';

/**
 * Chat-shell app frame (Muse, redesign gui/redesign-chat).
 *
 * Layout: HUD capsule | chat sidebar | main. The old task-manager sidenav is
 * gone; legacy task pages stay mounted on hidden debug routes only
 * (#/tasks, #/task/:id, #/dispatch).
 */
function sectionLabel(route: Route): string {
  switch (route.name) {
    case 'chats':
    case 'chat':
      return '群聊';
    case 'settings':
      return '设置';
    case 'about':
      return '关于';
    case 'tasks':
    case 'task':
      return '任务（调试）';
    case 'dispatch':
      return '派发任务（调试）';
    default:
      return '';
  }
}

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
  const engineTone = status?.healthy
    ? 'success'
    : status?.state === 'starting'
      ? 'warning'
      : status?.state === 'error'
        ? 'error'
        : 'neutral';
  const engineLabel = status?.healthy
    ? '引擎在线'
    : status?.state === 'starting'
      ? '引擎启动中'
      : status?.state === 'error'
        ? '引擎启动失败'
        : '引擎离线';

  const isChatRoute = route.name === 'chats' || route.name === 'chat';

  return (
    <div className={`app${isChatRoute ? ' app--chat' : ''}`}>
      <header className="topbar">
        <span className="topbar__section">{sectionLabel(route)}</span>
        <div className="topbar__spacer" />
        <a
          className="engine-status"
          href="#/settings"
          title={status?.lastError ? `管理引擎：${status.lastError}` : '管理引擎'}
          aria-label={`引擎状态：${engineLabel}，打开设置管理引擎`}
        >
          <AppStatus tone={engineTone} label={engineLabel} isPulsing={status?.state === 'starting'} />
          <span className="mono dim">{status?.baseUrl ?? '127.0.0.1:8080'}</span>
        </a>
        <AppIconButton
          label={mode === 'light' ? '切换到深色模式' : '切换到浅色模式'}
          title="切换主题"
          icon={mode === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          onClick={onToggleTheme}
        />
        <span className="topbar__version">v{appInfo.version}</span>
      </header>

      <AgentHud engine={status} />

      <ChatSidebar route={route} />

      <main className="main">
        <div className={`content${isChatRoute ? ' content--chat' : ''}`}>{children}</div>
      </main>
    </div>
  );
}