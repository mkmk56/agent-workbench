import { Files, History, Info, LayoutDashboard, MessagesSquare, Moon, Settings as SettingsIcon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
// The real application icon (Converge「汇聚」, direction A): paper tile +
// 10% ink hairline, Y arms 72/512, node r=56/512. This is the same mark as
// assets/branding/app-icon/agent-workbench.ico (the window/taskbar icon), so
// the rail and the taskbar can never show two different versions of the mark.
// The old placeholder (source/mark-only.svg, Y arms 54/512, node r=42/512) is
// no longer referenced here.
import appMark from '@brand/source/icon-master.svg';
import { navigate } from '../lib/router';
import type { AppTheme } from '../lib/theme';
import type { AppInfo, EngineStatus, Route } from '../types';
import { AppIconButton } from '../ui/astryx';
import { AgentHud } from './AgentHud';
import { NavAgentStatus } from './NavAgentStatus';

type NavEntry = {
  key: string;
  label: string;
  title: string;
  icon: ReactNode;
  path: string;
  isSelected: (route: Route) => boolean;
};

const ENTRIES: NavEntry[] = [
  {
    key: 'chats',
    label: '群聊',
    title: '群聊',
    icon: <MessagesSquare size={22} strokeWidth={1.8} />,
    path: '/chats',
    isSelected: (route) => route.name === 'chats' || route.name === 'chat',
  },
  {
    key: 'workbench',
    label: '工作台',
    title: '工作台',
    icon: <LayoutDashboard size={22} strokeWidth={1.8} />,
    path: '/tasks',
    isSelected: (route) =>
      (route.name === 'tasks' && route.scope !== 'history') ||
      route.name === 'task' ||
      route.name === 'dispatch',
  },
  {
    key: 'history',
    label: '任务记录',
    title: '任务记录',
    icon: <History size={22} strokeWidth={1.8} />,
    path: '/tasks/history',
    isSelected: (route) => route.name === 'tasks' && route.scope === 'history',
  },
  {
    key: 'files',
    label: '文件',
    title: '文件',
    icon: <Files size={22} strokeWidth={1.8} />,
    path: '/files',
    isSelected: (route) => route.name === 'files',
  },
];

/**
 * Global nav rail (Muse, group-chat upgrade). Fixed left, icons only, names
 * on hover. Top: product mark + the four sections. Middle: live Agent HUD
 * slots (real-time status + paper planes, unchanged behaviour). Bottom:
 * engine status, theme toggle, settings, help.
 */
export function GlobalNav({
  route,
  mode,
  onToggleTheme,
  appInfo,
  engine,
}: {
  route: Route;
  mode: AppTheme;
  onToggleTheme: () => void;
  appInfo: AppInfo;
  engine: EngineStatus | null;
}) {
  const engineTone = engine?.healthy
    ? 'success'
    : engine?.state === 'starting'
      ? 'warning'
      : engine?.state === 'error'
        ? 'error'
        : 'neutral';
  const engineLabel = engine?.healthy
    ? '引擎在线'
    : engine?.state === 'starting'
      ? '引擎启动中'
      : engine?.state === 'error'
        ? '引擎启动失败'
        : '引擎离线';

  return (
    <nav className="nav-rail" aria-label="全局导航">
      <span className="nav-rail__mark" title={`Agent Workbench v${appInfo.version}`}>
        <img src={appMark} alt="" draggable={false} />
        <span className="nav-rail__wordmark">muse</span>
      </span>
      {ENTRIES.map((entry) => (
        <button
          key={entry.key}
          type="button"
          className={`nav-rail__item${entry.isSelected(route) ? ' is-selected' : ''}`}
          aria-label={entry.label}
          aria-current={entry.isSelected(route) ? 'page' : undefined}
          title={entry.title}
          onClick={() => navigate(entry.path)}
        >
          {entry.icon}
        </button>
      ))}

      <div className="nav-rail__hud">
        <AgentHud engine={engine} />
      </div>

      {/*
        Agent avatars with hover/focus status cards (task §1). Kept outside
        .nav-rail__hud so the HUD — its capsule, ring and portal — is untouched.
      */}
      <NavAgentStatus chatId={route.name === 'chat' ? route.id : null} />

      <div className="nav-rail__spacer" />

      <div className="nav-rail__bottom">
        <button
          type="button"
          className="nav-rail__engine"
          title={engine?.lastError ? `引擎：${engineLabel}。${engine.lastError}（打开设置管理引擎）` : `引擎：${engineLabel}（打开设置管理引擎）`}
          aria-label={`引擎状态：${engineLabel}，打开设置管理引擎`}
          onClick={() => navigate('/settings')}
        >
          <span
            className={`nav-rail__engine-dot nav-rail__engine-dot--${engineTone}`}
            aria-hidden="true"
          />
        </button>
        <AppIconButton
          label={mode === 'light' ? '切换到深色模式' : '切换到浅色模式'}
          title="切换主题"
          icon={mode === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          onClick={onToggleTheme}
        />
        <AppIconButton
          label="设置"
          title="设置"
          icon={<SettingsIcon size={16} />}
          onClick={() => navigate('/settings')}
        />
        <AppIconButton
          label="帮助"
          title="帮助"
          icon={<Info size={16} />}
          onClick={() => navigate('/about')}
        />
      </div>
    </nav>
  );
}
