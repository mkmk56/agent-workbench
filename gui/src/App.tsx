import { Theme } from '@astryxdesign/core';
import { lazy, Suspense, type ReactElement } from 'react';
import { AppFrame } from './components/AppFrame';
import { useRoute } from './lib/router';
import { useAppTheme } from './lib/theme';
import { useAppInfo } from './lib/workbench';
import { AboutPage } from './pages/AboutPage';
import { ChatPage } from './pages/ChatPage';
import { ChatSettingsPage } from './pages/ChatSettingsPage';
import { DispatchPage } from './pages/DispatchPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { FilesPage } from './pages/FilesPage';
import { InboxPage } from './pages/InboxPage';
import { SettingsPage } from './pages/SettingsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';
import { brandTheme } from './theme/brand-theme.mjs';

// Preview-only route: lazy so reicon-react stays in its own chunk and never
// rides along with the production chat screens.
const PreviewReiconPage = lazy(() =>
  import('./pages/PreviewReiconPage').then((module) => ({ default: module.PreviewReiconPage })),
);

export function App() {
  const route = useRoute();
  const { mode, toggleTheme } = useAppTheme();
  const { info } = useAppInfo();

  let page: ReactElement;
  switch (route.name) {
    case 'chat':
      page = <ChatPage key={route.id} chatId={route.id} />;
      break;
    case 'chat-settings':
      page = <ChatSettingsPage key={route.id} id={route.id} />;
      break;
    case 'chats':
      page = <ChatPage chatId={null} />;
      break;
    case 'discover':
      page = <DiscoverPage />;
      break;
    case 'task':
      page = <TaskDetailPage key={route.id} id={route.id} />;
      break;
    case 'tasks':
      page = <TasksPage key={route.scope ?? 'all'} scope={route.scope} />;
      break;
    case 'files':
      page = <FilesPage />;
      break;
    case 'inbox':
      page = <InboxPage />;
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
    case 'preview-reicon':
      page = (
        <Suspense fallback={<p>正在加载图标预览…</p>}>
          <PreviewReiconPage />
        </Suspense>
      );
      break;
  }

  return (
    <Theme theme={brandTheme} mode={mode}>
      <AppFrame route={route} mode={mode} onToggleTheme={toggleTheme} appInfo={info}>
        {page}
      </AppFrame>
    </Theme>
  );
}