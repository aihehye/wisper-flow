import React from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './hub.css';
import { HubApp } from './HubApp';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <HubApp />
    </React.StrictMode>,
  );
}
