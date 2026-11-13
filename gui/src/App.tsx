import { Theme } from '@astryxdesign/core';
import type { ReactElement } from 'react';
import { AppFrame } from './components/AppFrame';
import { useRoute } from './lib/router';
import { useAppTheme } from './lib/theme';
import { useAppInfo } from './lib/workbench';
import { AboutPage } from './pages/AboutPage';
import { DispatchPage } from './pages/DispatchPage';
import { SettingsPage } from './pages/SettingsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';
import { brandTheme } from './theme/brand-theme.mjs';

export function App() {
  const route = useRoute();
  const { mode, toggleTheme } = useAppTheme();
  const { info } = useAppInfo();

  let page: ReactElement;
  switch (route.name) {
    case 'task':
      page = <TaskDetailPage id={route.id} />;
      break;
    case 'dispatch':
      page = <DispatchPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    case 'about':
      page = <AboutPage />;
      break;
    default:
      page = <TasksPage />;
  }

  return (
    <Theme theme={brandTheme} mode={mode}>
      <AppFrame route={route} mode={mode} onToggleTheme={toggleTheme} appInfo={info}>
        {page}
      </AppFrame>
    </Theme>
  );
}