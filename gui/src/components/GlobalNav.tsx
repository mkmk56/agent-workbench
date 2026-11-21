import {
  Compass,
  Files,
  History,
  Inbox,
  Info,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  Settings as SettingsIcon,
  Sun,
  type IconWeight,
} from '../ui/icons';
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

type NavEntry = {
  key: string;
  label: string;
  title: string;
  /**
   * The rail draws the same glyph twice: Outline at rest, Filled on the active
   * section (Reicon's filled weight is what the #/preview/reicon comparison
   * settled on for selected states).
   */
  icon: (weight: IconWeight) => ReactNode;
  path: string;
  isSelected: (route: Route) => boolean;
};

const ENTRIES: NavEntry[] = [
  {
    key: 'chats',
    label: '群聊',
    title: '群聊',
    icon: (weight) => <MessagesSquare size={22} weight={weight} />,
    path: '/chats',
    isSelected: (route) => route.name === 'chats' || route.name === 'chat',
  },
  {
    // REA Phase 5 §4.1: local-only discovery of public chats (#/discover).
    key: 'discover',
    label: '发现',
    title: '发现（仅本机）',
    icon: (weight) => <Compass size={22} weight={weight} />,
    path: '/discover',
    isSelected: (route) => route.name === 'discover',
  },
  {
    key: 'workbench',
    label: '工作台',
    title: '工作台',
    icon: (weight) => <LayoutDashboard size={22} weight={weight} />,
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
    icon: (weight) => <History size={22} weight={weight} />,
    path: '/tasks/history',
    isSelected: (route) => route.name === 'tasks' && route.scope === 'history',
  },
  {
    key: 'files',
    label: '文件',
    title: '文件',
    icon: (weight) => <Files size={22} weight={weight} />,
    path: '/files',
    isSelected: (route) => route.name === 'files',
  },
  {
    // REA Phase 2: per-agent unread counters (mentions / replies / owner /
    // recalled) live on their own page; the chat list keeps its own badge.
    key: 'inbox',
    label: '收件箱',
    title: '收件箱',
    icon: (weight) => <Inbox size={22} weight={weight} />,
    path: '/inbox',
    isSelected: (route) => route.name === 'inbox',
  },
];

/**
 * Global nav rail (Muse, group-chat upgrade). Fixed left, icons only, names
 * on hover. Top: product mark + the four sections. Middle: live Agent HUD
 * slots (real-time status + paper planes, unchanged behaviour) — the rail's
 * only avatar row: the duplicate copy that sat under the capsule (the old
 * `.nav-rail__agents` block) is gone, so the rail no longer lists each agent
 * twice. The HUD capsule itself is untouched. Bottom: engine status, theme
 * toggle, settings, help.
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
          {entry.icon(entry.isSelected(route) ? 'Filled' : 'Outline')}
        </button>
      ))}

      <div className="nav-rail__hud">
        <AgentHud engine={engine} />
      </div>

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
