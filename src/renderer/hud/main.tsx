import React from 'react';
import { createRoot } from 'react-dom/client';
import { HudApp } from './HudApp';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <HudApp />
    </React.StrictMode>,
  );
}
