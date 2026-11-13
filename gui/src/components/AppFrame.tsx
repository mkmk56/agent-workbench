import {
  Info,
  ListTodo,
  Moon,
  Send,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import type { ReactNode } from 'react';
import logoInverse from '@brand/logo/logo-inverse.svg';
import logoPrimary from '@brand/logo/logo-primary.svg';
import { navigate } from '../lib/router';
import type { AppTheme } from '../lib/theme';
import type { AppInfo, Route } from '../types';
import { AppIconButton, AppStatus } from '../ui/astryx';

function breadcrumbFor(route: Route): ReactNode {
  switch (route.name) {
    case 'task':
      return (
        <>
          <a href="#/tasks">任务</a>
          <span aria-hidden="true">/</span>
          <span className="mono">#{route.id}</span>
        </>
      );
    case 'dispatch':
      return (
        <>
          <a href="#/tasks">工作台</a>
          <span aria-hidden="true">/</span>
          <span>派发任务</span>
        </>
      );
    case 'settings':
      return (
        <>
          <a href="#/tasks">工作台</a>
          <span aria-hidden="true">/</span>
          <span>设置</span>
        </>
      );
    case 'about':
      return (
        <>
          <a href="#/tasks">工作台</a>
          <span aria-hidden="true">/</span>
          <span>关于</span>
        </>
      );
    default:
      return (
        <>
          <a href="#/tasks">工作台</a>
          <span aria-hidden="true">/</span>
          <span>任务</span>
        </>
      );
  }
}

function selectedNav(route: Route): 'tasks' | 'dispatch' | 'settings' | 'about' {
  if (route.name === 'task') {
    return 'tasks';
  }
  if (route.name === 'tasks') {
    return 'tasks';
  }
  return route.name;
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
  const selected = selectedNav(route);

  return (
    <div className="app">
      <header className="topbar">
        <a className="topbar__brand" href="#/tasks" aria-label="Agent Workbench 首页">
          <img className="logo logo--light" src={logoPrimary} alt="" />
          <img className="logo logo--dark" src={logoInverse} alt="" />
        </a>
        <span className="topbar__rule" aria-hidden="true" />
        <nav className="breadcrumb" aria-label="面包屑">
          {breadcrumbFor(route)}
        </nav>
        <div className="topbar__spacer" />
        <div className="engine-status">
          <AppStatus tone="neutral" label="引擎未接入" />
          <span className="mono dim">127.0.0.1:8080</span>
        </div>
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
        <span className="topbar__version">v{appInfo.version}</span>
      </header>

      <aside className="sidenav" aria-label="主导航">
        <div className="nav-section">工作台</div>
        <a
          className={`nav-item${selected === 'tasks' ? ' is-selected' : ''}`}
          href="#/tasks"
          aria-current={selected === 'tasks' ? 'page' : undefined}
        >
          <ListTodo size={16} className="icon" aria-hidden="true" />
          任务
          <span className="nav-count">6</span>
        </a>
        <a
          className={`nav-item${selected === 'dispatch' ? ' is-selected' : ''}`}
          href="#/dispatch"
          aria-current={selected === 'dispatch' ? 'page' : undefined}
        >
          <Send size={16} className="icon" aria-hidden="true" />
          派发任务
        </a>
        <div className="nav-section">配置</div>
        <a
          className={`nav-item${selected === 'settings' ? ' is-selected' : ''}`}
          href="#/settings"
          aria-current={selected === 'settings' ? 'page' : undefined}
        >
          <SettingsIcon size={16} className="icon" aria-hidden="true" />
          设置
        </a>
        <a
          className={`nav-item${selected === 'about' ? ' is-selected' : ''}`}
          href="#/about"
          aria-current={selected === 'about' ? 'page' : undefined}
        >
          <Info size={16} className="icon" aria-hidden="true" />
          关于
        </a>
        <div className="sidenav__footer">
          <div className="engine-mini">
            <div className="engine-mini__row">
              <AppStatus tone="neutral" label="引擎 IPC 未接入" />
            </div>
            <div className="engine-mini__meta">执行器状态未知 · 示例数据</div>
            <a className="text-link" href="#/settings">
              管理引擎
            </a>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="content">{children}</div>
      </main>
    </div>
  );
}