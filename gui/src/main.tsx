import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './theme/brand.generated.css';
import './styles/brand.css';
import './styles/astryx-overrides.css';
import './styles/hud.css';
import './styles/conversation.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);