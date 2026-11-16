import { Theme } from '@astryxdesign/core';
import type { ReactElement } from 'react';
import { AppFrame } from './components/AppFrame';
import { useRoute } from './lib/router';
import { useAppTheme } from './lib/theme';
import { useAppInfo } from './lib/workbench';
import { AboutPage } from './pages/AboutPage';
import { AttachmentLabPage } from './pages/AttachmentLabPage';
import { ChatPage } from './pages/ChatPage';
import { DispatchPage } from './pages/DispatchPage';
import { SettingsPage } from './pages/SettingsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';
import { brandTheme } from './theme/brand-theme.mjs';

/** Attachment lab: dev builds, or a build made with VITE_ATTACHMENT_LAB=1. */
const LAB_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ATTACHMENT_LAB === '1';

export function App() {
  const route = useRoute();
  const { mode, toggleTheme } = useAppTheme();
  const { info } = useAppInfo();

  if (LAB_ENABLED && window.location.hash.startsWith('#/__attachment-lab')) {
    return (
      <Theme theme={brandTheme} mode={mode}>
        <AttachmentLabPage />
      </Theme>
    );
  }

  let page: ReactElement;
  switch (route.name) {
    case 'chat':
      page = <ChatPage key={route.id} chatId={route.id} />;
      break;
    case 'chats':
      page = <ChatPage chatId={null} />;
      break;
    case 'task':
      page = <TaskDetailPage key={route.id} id={route.id} />;
      break;
    case 'tasks':
      page = <TasksPage />;
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
  }

  return (
    <Theme theme={brandTheme} mode={mode}>
      <AppFrame route={route} mode={mode} onToggleTheme={toggleTheme} appInfo={info}>
        {page}
      </AppFrame>
    </Theme>
  );
}